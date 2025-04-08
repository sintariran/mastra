import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { projectTools } from '../mastra/tools/projectTools.js';
import { taskTools } from '../mastra/tools/taskTools.js';

const router = express.Router();

// Find tool by ID helper
const findTool = (tools: any[], id: string) => tools.find(t => t.id === id);

// Async handler wrapper to catch errors and pass to next()
const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next); // Pass errors to Express error handler
  };

// GET /api/project/
router.get(
  '/',
  asyncHandler(async (req, res, next) => {
    const listProjectsTool = findTool(projectTools, 'listProjects');
    if (!listProjectsTool) throw new Error('listProjects tool not found');
    const projects = await listProjectsTool.execute({ context: req.query });
    res.status(200).json(projects);
  }),
);

// GET /api/project/:projectId
router.get(
  '/:projectId',
  asyncHandler(async (req, res, next) => {
    const { projectId } = req.params;
    const getProjectDetailsTool = findTool(projectTools, 'getProjectDetails');
    if (!getProjectDetailsTool) throw new Error('getProjectDetails tool not found');
    const project = await getProjectDetailsTool.execute({ context: { projectId } });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.status(200).json(project);
  }),
);

// GET /api/project/:projectId/tasks
router.get(
  '/:projectId/tasks',
  asyncHandler(async (req, res, next) => {
    const { projectId } = req.params;
    const listTasksTool = findTool(taskTools, 'listTasks');
    if (!listTasksTool) throw new Error('listTasks tool not found');
    const tasks = await listTasksTool.execute({ context: { projectId, ...req.query } });
    res.status(200).json(tasks);
  }),
);

// POST /api/project/tasks (Manual task creation)
router.post(
  '/tasks',
  asyncHandler(async (req, res, next) => {
    const createTaskTool = findTool(taskTools, 'createTask');
    if (!createTaskTool) throw new Error('createTask tool not found');

    const validationResult = createTaskTool.inputSchema?.safeParse(req.body);
    if (!validationResult?.success) {
      // Consider creating a specific error type for validation errors
      return res.status(400).json({ error: 'Invalid task data', details: validationResult?.error.errors });
    }

    const createdTask = await createTaskTool.execute({ context: validationResult.data });
    res.status(201).json(createdTask);
  }),
);

// PUT /api/project/tasks/:taskId (Update task status etc.)
router.put(
  '/tasks/:taskId',
  asyncHandler(async (req, res, next) => {
    const { taskId } = req.params;
    const updateStatusSchema = z.object({ status: z.enum(['pending', 'in-progress', 'completed']) });
    const validationResult = updateStatusSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({ error: 'Invalid status update data', details: validationResult.error.errors });
    }
    const { status } = validationResult.data;

    const updateTaskStatusTool = findTool(taskTools, 'updateTaskStatus');
    if (!updateTaskStatusTool) throw new Error('updateTaskStatus tool not found');

    const updatedTask = await updateTaskStatusTool.execute({ context: { taskId, status } });
    res.status(200).json(updatedTask);
  }),
);

// Optional: Add a generic error handler for the router
// router.use((err: Error, req: Request, res: Response, next: NextFunction) => {
//   console.error("API Error:", err);
//   res.status(500).json({ error: 'Internal Server Error', message: err.message });
// });

export default router;
