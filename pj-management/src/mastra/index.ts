// import dotenv from 'dotenv';
// dotenv.config(); // Remove this as it's handled in env.ts now

import { Mastra } from '@mastra/core';
import { PgVector } from '@mastra/pg';
import { createLogger } from '@mastra/core/logger';
import { projectAgent } from './agents/projectAgent.js';
import { plannerAgent, autoRunWorkflow } from './autoRun.js';
// import { meetingWorkflow } from './workflows/index.js'; // Workflow is on hold
import { env } from '../utils/env.js';

// ロガーの設定
const logger = createLogger({
  level: env.LOG_LEVEL,
  // name: 'ProjectManagementAI' // Optional: Add a name to the logger
});

// ベクトルストアの設定 (PgVector を使用)
const vectorStore = new PgVector({
  connectionString: env.DATABASE_URL,
  // Add schemaName if needed, e.g., schemaName: 'vector_schema'
});

// Mastraインスタンスの初期化
export const mastra = new Mastra({
  agents: {
    projectAgent,
    plannerAgent,
  },
  workflows: {
    autoRun: autoRunWorkflow,
    // meetingWorkflow,
  },
  logger,
  vectors: {
    pgvectorStore: vectorStore,
  },
  // 必要に応じて他の設定 (メモリプロバイダなど) - Memory is configured within the Agent itself now
});

// Optionally log status on init (might be better done in the main app entry point)
// mastra.logStatus();

// --- Removed Server Startup Logic ---
