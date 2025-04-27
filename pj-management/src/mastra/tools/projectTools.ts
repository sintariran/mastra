import { z } from 'zod';
import { createTool } from '@mastra/core';
import { db } from '../../db/index.js';
import { randomUUID } from 'crypto';

// Zod schema for Project (based on design/project-management-system.md and DB schema)
const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  start_date: z.date(), // Assuming TIMESTAMPTZ maps to Date
  end_date: z.date().nullable(),
  status: z.string(), // Consider enum: z.enum(['active', 'completed', 'on-hold'])
  client_info: z.record(z.unknown()).nullable(), // JSONB maps to record/object
  tags: z.array(z.string()).nullable(),
});

// Tool to get details of a specific project
const getProjectDetails = createTool({
  id: 'getProjectDetails',
  description: '特定のプロジェクトの詳細情報を取得します',
  inputSchema: z.object({
    projectId: z.string().describe('プロジェクトID'),
  }),
  outputSchema: projectSchema.nullable(), // Can return null if not found
  execute: async ({ context }) => {
    try {
      const project = await db.oneOrNone('SELECT * FROM projects WHERE id = $1', [context.projectId]);
      return project ? projectSchema.parse(project) : null; // Validate DB output
    } catch (error) {
      console.error('Error fetching project details:', error);
      // Consider throwing a specific error or returning an error object
      return null; // Or throw error
    }
  },
});

// Tool to list projects based on filters
const listProjects = createTool({
  id: 'listProjects',
  description: 'プロジェクトを検索または一覧表示します',
  inputSchema: z.object({
    status: z.string().optional().describe('プロジェクトのステータス (任意): active, completed, on-hold'),
    // Add other filters here
  }),
  outputSchema: z.array(projectSchema),
  execute: async ({ context }) => {
    try {
      let query = 'SELECT * FROM projects';
      const params: string[] = [];
      if (context.status) {
        query += ' WHERE status = $1';
        params.push(context.status);
      }
      // Add more WHERE clauses for other filters

      const projects = await db.manyOrNone(query, params);
      return z.array(projectSchema).parse(projects); // Validate DB output
    } catch (error) {
      console.error('Error listing projects:', error);
      return []; // Return empty array on error
    }
  },
});

// Tool to create a new project
const createProject = createTool({
  id: 'createProject',
  description: '新しいプロジェクトを追加します',
  inputSchema: z.object({
    name: z.string().describe('プロジェクト名'),
    description: z.string().optional().describe('プロジェクトの説明 (任意)'),
    startDate: z
      .string()
      .datetime({ message: '日付は ISO 8601 形式 (YYYY-MM-DDTHH:mm:ssZ) である必要があります' })
      .describe('開始日 (ISO 8601形式)'),
    endDate: z
      .string()
      .datetime({ message: '日付は ISO 8601 形式 (YYYY-MM-DDTHH:mm:ssZ) である必要があります' })
      .optional()
      .describe('終了日 (任意, ISO 8601形式)'),
    status: z
      .enum(['active', 'completed', 'on-hold'])
      .default('active')
      .optional()
      .describe('プロジェクトのステータス (任意)'),
    clientInfo: z.record(z.unknown()).optional().describe('クライアント情報 (任意)'),
    tags: z.array(z.string()).optional().describe('タグ (任意)'),
  }),
  outputSchema: projectSchema, // Return the created project
  execute: async ({ context }) => {
    try {
      const projectId = randomUUID();

      const projectData = {
        id: projectId,
        name: context.name,
        description: context.description ?? null,
        start_date: new Date(context.startDate),
        end_date: context.endDate ? new Date(context.endDate) : null,
        status: context.status ?? 'active',
        client_info: context.clientInfo ?? null,
        tags: context.tags ?? null,
      };

      // Insert into the database and return the created row
      const createdProject = await db.one(
        `INSERT INTO projects(id, name, description, start_date, end_date, status, client_info, tags)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          projectData.id,
          projectData.name,
          projectData.description,
          projectData.start_date,
          projectData.end_date,
          projectData.status,
          projectData.client_info,
          projectData.tags,
        ],
      );

      return projectSchema.parse(createdProject);
    } catch (error) {
      console.error('Error creating project:', error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`プロジェクトの作成に失敗しました: ${message}`);
    }
  },
});

export const projectTools = [getProjectDetails, listProjects, createProject];
export { createProject };
