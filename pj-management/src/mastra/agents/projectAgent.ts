import { Agent } from '@mastra/core/agent';
// import { openai } from '@mastra/core/llm';
import { anthropic } from '@ai-sdk/anthropic'; // Use Anthropic SDK
import { z } from 'zod';
import { createTool, Tool, ToolExecutionContext } from '@mastra/core'; // Import createTool and types
import { Memory } from '@mastra/memory'; // Import Memory class
import { embeddingModel } from '../memory/vectorStore.js';
import { projectTools } from '../tools/projectTools.js';
import { taskTools } from '../tools/taskTools.js';
import { processMeetingTranscript } from '../tools/meetingTools.js';
import { db } from '../../db/index.js';
import pgvector from 'pgvector/pg'; // Import pgvector helpers
// import { pool } from '../../db/index.js'; // Removed pool
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
  description: 'プロジェクト関連情報 (会議記録、要約など) を意味的に検索します',
  inputSchema: searchInputSchema,
  outputSchema: searchOutputSchema,
  execute: async (executionContext: ToolExecutionContext<typeof searchInputSchema>) => {
    const { query, projectId, type, limit = 5 } = executionContext.context;

    try {
      // 1. Generate embedding for the query
      const embeddingResult = await embeddingModel.doEmbed({ values: [query] });
      const queryVector = embeddingResult.embeddings[0];

      if (!queryVector) {
        throw new Error('Failed to generate query embedding.');
      }

      // Use pgvector helper to convert embedding to SQL string format
      const queryVectorSql = pgvector.toSql(queryVector);

      // 2. Build SQL query using pg Pool and parameterized queries
      let sql = `SELECT 
                    ${env.PGVECTOR_CONTENT_COLUMN} as content, 
                    ${env.PGVECTOR_METADATA_COLUMN} as metadata, 
                    1 - (${env.PGVECTOR_VECTOR_COLUMN} <=> $1) AS score 
                 FROM ${env.PGVECTOR_TABLE_NAME}`;

      const conditions: string[] = [];
      const params: any[] = [queryVectorSql]; // Start params with vector
      let paramIndex = 2; // Start parameter index from $2

      // Add filters based on context
      // Ensure metadata filters use JSONB accessor correctly
      if (projectId) {
        conditions.push(`${env.PGVECTOR_METADATA_COLUMN}->>'projectId' = $${paramIndex++}`);
        params.push(projectId);
      }
      if (type) {
        conditions.push(`${env.PGVECTOR_METADATA_COLUMN}->>'type' = $${paramIndex++}`);
        params.push(type);
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      // Order by score DESC (higher similarity is better, 1 - distance)
      sql += ` ORDER BY score DESC LIMIT $${paramIndex++}`;
      params.push(limit);

      // 3. Execute the query using pg-promise db
      const { rows } = await db.query(sql, params);

      // 4. Parse and return results (score is already calculated as 1 - distance)
      // Ensure the output matches the defined outputSchema
      return searchOutputSchema.parse(
        rows.map((row: any) => ({
          ...row,
          // Ensure score is treated as optional if it might be null/undefined from DB
          score: row.score ?? undefined,
        })),
      );
    } catch (error) {
      console.error('Error during vector search:', error);
      // Consider logging the specific query and params for debugging
      return []; // Return empty array on error
    }
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
    (注: 会議内容などの詳細検索機能が利用可能になりました)
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
    ),
    [processMeetingTranscript.id]: processMeetingTranscript,
    [searchProjectInformationTool.id]: searchProjectInformationTool,
  },

  // 会話の履歴を保持するメモリ
  memory: new Memory(),
});
