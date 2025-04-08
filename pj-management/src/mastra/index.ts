// import dotenv from 'dotenv';
// dotenv.config(); // Remove this as it's handled in env.ts now

import { Mastra } from '@mastra/core';
import { createLogger } from '@mastra/core/logger';
import { projectAgent } from './agents/projectAgent.js'; // Import directly from projectAgent.js
// import { meetingWorkflow } from './workflows/index.js'; // Workflow is on hold
import { env } from '../utils/env.js';

// ロガーの設定
const logger = createLogger({
  level: env.LOG_LEVEL,
  // name: 'ProjectManagementAI' // Optional: Add a name to the logger
});

// Mastraインスタンスの初期化
export const mastra = new Mastra({
  agents: {
    projectAgent, // Register the agent
  },
  // workflows: {
  //   meetingWorkflow, // Workflow registration is on hold
  // },
  logger,
  // 必要に応じて他の設定 (メモリプロバイダなど) - Memory is configured within the Agent itself now
});

// Optionally log status on init (might be better done in the main app entry point)
// mastra.logStatus();

// --- Removed Server Startup Logic ---
