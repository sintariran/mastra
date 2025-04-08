import { z } from 'zod';
import { createTool } from '@mastra/core'; // Assuming createTool is available from core
import { db } from '../../db/index.js';

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

export const projectTools = [getProjectDetails, listProjects];
