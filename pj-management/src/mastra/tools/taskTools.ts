import { z } from 'zod';
import { createTool } from '@mastra/core';
import { db } from '../../db/index.js';

// Zod schema for Task (based on design/project-management-system.md and DB schema)
export const taskSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  description: z.string(),
  assignee: z.string().nullable(),
  due_date: z.date().nullable(), // TIMESTAMPTZ maps to Date
  status: z.enum(['pending', 'in-progress', 'completed']),
  priority: z.enum(['low', 'medium', 'high']),
  source_type: z.string(), // Consider enum: z.enum(['meeting', 'manual'])
  source_id: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date().nullable(),
  completed_at: z.date().nullable(),
});

// Tool to list tasks
const listTasks = createTool({
  id: 'listTasks',
  description: 'プロジェクトのタスク一覧を取得します',
  inputSchema: z.object({
    projectId: z.string().describe('プロジェクトID'),
    status: z.enum(['pending', 'in-progress', 'completed']).optional().describe('タスクのステータス (任意)'),
    assignee: z.string().optional().describe('担当者名 (任意)'),
  }),
  outputSchema: z.array(taskSchema),
  execute: async ({ context }) => {
    try {
      const conditions: string[] = ['project_id = $1'];
      const params: (string | undefined)[] = [context.projectId];
      let paramIndex = 2;

      if (context.status) {
        conditions.push(`status = $${paramIndex++}`);
        params.push(context.status);
      }
      if (context.assignee) {
        conditions.push(`assignee = $${paramIndex++}`);
        params.push(context.assignee);
      }

      const query = `SELECT * FROM tasks WHERE ${conditions.join(' AND ')}`;
      const tasks = await db.manyOrNone(query, params);
      return z.array(taskSchema).parse(tasks);
    } catch (error) {
      console.error('Error listing tasks:', error);
      return [];
    }
  },
});

// Tool to get task details
const getTaskDetails = createTool({
  id: 'getTaskDetails',
  description: '特定のタスクの詳細情報を取得します',
  inputSchema: z.object({
    taskId: z.string().describe('タスクID'),
  }),
  outputSchema: taskSchema.nullable(),
  execute: async ({ context }) => {
    try {
      const task = await db.oneOrNone('SELECT * FROM tasks WHERE id = $1', [context.taskId]);
      return task ? taskSchema.parse(task) : null;
    } catch (error) {
      console.error('Error fetching task details:', error);
      return null;
    }
  },
});

// Tool to create a task
const createTask = createTool({
  id: 'createTask',
  description: '新しいタスクを作成します',
  inputSchema: z.object({
    projectId: z.string().describe('プロジェクトID'),
    description: z.string().describe('タスクの説明'),
    assignee: z.string().optional().describe('担当者名 (任意)'),
    dueDate: z
      .string()
      .datetime({ message: '日付は ISO 8601 形式 (YYYY-MM-DDTHH:mm:ssZ) である必要があります' })
      .optional()
      .describe('期限 (ISO 8601形式) (任意)'),
    priority: z.enum(['low', 'medium', 'high']).default('medium').optional().describe('優先度 (任意)'),
  }),
  outputSchema: taskSchema, // Should return the created task
  execute: async ({ context }) => {
    try {
      const taskData = {
        project_id: context.projectId,
        description: context.description,
        assignee: context.assignee || null,
        due_date: context.dueDate ? new Date(context.dueDate) : null,
        priority: context.priority || 'medium',
        status: 'pending',
        source_type: 'manual', // Or determine based on context if needed
        created_at: new Date(),
      };
      // Use pg-promise's returning feature to get the created task including default id
      const createdTask = await db.one(
        'INSERT INTO tasks(project_id, description, assignee, due_date, priority, status, source_type, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
        [
          taskData.project_id,
          taskData.description,
          taskData.assignee,
          taskData.due_date,
          taskData.priority,
          taskData.status,
          taskData.source_type,
          taskData.created_at,
        ],
      );
      return taskSchema.parse(createdTask);
    } catch (error) {
      console.error('Error creating task:', error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`タスクの作成に失敗しました: ${message}`);
    }
  },
});

// Tool to update task status
const updateTaskStatus = createTool({
  id: 'updateTaskStatus',
  description: 'タスクのステータスを更新します',
  inputSchema: z.object({
    taskId: z.string().describe('タスクID'),
    status: z.enum(['pending', 'in-progress', 'completed']).describe('新しいステータス'),
  }),
  outputSchema: taskSchema, // Return the updated task
  execute: async ({ context }) => {
    try {
      const completedAt = context.status === 'completed' ? new Date() : null;
      const updatedTask = await db.oneOrNone(
        'UPDATE tasks SET status = $1, updated_at = $2, completed_at = $3 WHERE id = $4 RETURNING *',
        [context.status, new Date(), completedAt, context.taskId],
      );
      if (!updatedTask) {
        throw new Error(`タスクID ${context.taskId} が見つかりません`);
      }
      return taskSchema.parse(updatedTask);
    } catch (error) {
      console.error('Error updating task status:', error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`タスクステータスの更新に失敗しました: ${message}`);
    }
  },
});

// Helper function to save multiple tasks (used by workflow)
// This is not a Tool, just a utility function
export async function saveTasks(
  tasks: Omit<z.infer<typeof taskSchema>, 'id' | 'created_at' | 'updated_at' | 'completed_at'>[],
) {
  if (!tasks || tasks.length === 0) {
    return [];
  }
  // Use pg-promise's helper for bulk inserts
  const cs = new db.$config.pgp.helpers.ColumnSet(
    ['project_id', 'description', 'assignee', 'due_date', 'status', 'priority', 'source_type', 'source_id'],
    { table: 'tasks' },
  );

  const insertQuery = db.$config.pgp.helpers.insert(tasks, cs) + ' RETURNING *';

  try {
    const savedTasks = await db.many(insertQuery);
    return z.array(taskSchema).parse(savedTasks);
  } catch (error) {
    console.error('Error saving tasks:', error);
    // Decide how to handle bulk insert errors (e.g., return empty, throw)
    return [];
  }
}

export const taskTools = [listTasks, getTaskDetails, createTask, updateTaskStatus];
