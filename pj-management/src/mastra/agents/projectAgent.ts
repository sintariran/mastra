import { Agent } from '@mastra/core/agent';
// import { openai } from '@mastra/core/llm';
import { anthropic } from '@ai-sdk/anthropic'; // Use Anthropic SDK
import { z } from 'zod';
import { createTool, Tool, ToolExecutionContext } from '@mastra/core'; // Import createTool and types
import { Memory } from '@mastra/memory'; // Import Memory class
import { embeddingModel } from '../memory/vectorStore.js';
import { projectTools } from '../tools/projectTools.js';
import { taskTools } from '../tools/taskTools.js';
import { db } from '../../db/index.js';
import pgvector from 'pgvector/pg'; // Import pgvector helpers
import { pool } from '../../db/index.js'; // Import the pg Pool
import { env } from '../../utils/env.js'; // Import env variables

// Define schema for the search tool input
const searchInputSchema = z.object({
  query: z.string().describe('検索クエリ'),
  projectId: z.string().optional().describe('プロジェクトID (任意)'),
  type: z
    .enum(['meeting-transcript', 'meeting-summary', 'meeting-keypoint', 'meeting-nextstep'])
    .optional()
    .describe('検索対象タイプ (任意): meeting-transcript, meeting-summary, meeting-keypoint, meeting-nextstep'),
  limit: z.number().optional().default(5).describe('取得する結果の最大数 (デフォルト: 5)'),
});

// Define schema for the search tool output
const searchOutputSchema = z.array(
  z.object({
    content: z.string(),
    metadata: z.record(z.unknown()),
    score: z.number().optional(),
  }),
);

// Define the search tool using createTool
const searchProjectInformationTool = createTool({
  id: 'searchProjectInformation',
  description: 'プロジェクト関連情報をベクトルDBから検索します (現在実装見直し中)',
  inputSchema: searchInputSchema,
  outputSchema: searchOutputSchema,
  execute: async (executionContext: ToolExecutionContext<typeof searchInputSchema>) => {
    console.warn(
      'searchProjectInformationTool execute function needs implementation based on embeddingModel capabilities.',
    );
    // TODO: Implement actual vector search logic using embeddingModel
    // const { query, projectId, type, limit = 5 } = executionContext.context;
    // This logic is likely incorrect as embeddingModel doesn't have similaritySearch
    // const results = await embeddingModel.similaritySearch(query, limit, filter);
    return []; // Return empty array for now
  },
});

// Helper function to convert Tool[] to { [toolId: string]: Tool }
function toolsArrayToObject(tools: Tool[]): { [toolId: string]: Tool } {
  return tools.reduce(
    (acc, tool) => {
      if (tool.id) {
        // Ensure tool has an id
        acc[tool.id] = tool;
      }
      return acc;
    },
    {} as { [toolId: string]: Tool },
  );
}

// プロジェクト質問対応エージェント
export const projectAgent = new Agent({
  name: 'ProjectAssistant',
  // description: 'プロジェクト情報の質問に回答し、タスク管理を支援するアシスタント', // Comment out description to fix lint error

  instructions: `
    あなたはプロジェクト管理AIアシスタントです。以下の役割を担当します：
    
    1. プロジェクト情報への質問対応
       - プロジェクトの詳細、ステータス、進捗状況に関する質問に回答
       - 会議の要約や重要ポイントの提供
       - プロジェクト関連の意思決定のサポート
    
    2. タスク管理支援
       - タスクの一覧表示、詳細確認
       - タスクの作成、更新、完了処理
       - タスクの担当者や期限の管理
    
    常に丁寧かつ簡潔に対応し、ユーザーからの曖昧な質問には適切な確認を行ってください。
    データベースにないことを尋ねられた場合は、情報がないことを素直に伝えてください。
    
    特定のプロジェクトに関する質問の場合は、まずそのプロジェクトIDを特定または確認してください。
    プロジェクトIDがない場合は、プロジェクト名からIDを検索するか、利用可能なプロジェクト一覧を提示してください。
    (注: 現在、会議内容などの詳細検索機能は実装見直し中です)
    (注: タスク管理ツールは現在無効です)
  `,

  // model: openai('gpt-4o'),
  model: anthropic('claude-3-7-sonnet-20250219'),

  // Restore taskTools
  tools: {
    ...projectTools.reduce(
      (acc, tool) => {
        acc[tool.id] = tool;
        return acc;
      },
      {} as { [id: string]: Tool<any, any> },
    ),
    ...taskTools.reduce(
      (acc, tool) => {
        acc[tool.id] = tool;
        return acc;
      },
      {} as { [id: string]: Tool<any, any> },
    ), // Restore taskTools
    [searchProjectInformationTool.id]: searchProjectInformationTool,
  },

  // 会話の履歴を保持するメモリ
  memory: new Memory(),
});
