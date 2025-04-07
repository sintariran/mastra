# プロジェクト管理AIシステム実装ガイド

このガイドでは、Mastraフレームワークを使用したプロジェクト管理AIシステムの実装方法について説明します。

## 1. プロジェクト構造

```
project-management/
├── src/
│   ├── mastra/
│   │   ├── index.ts               # メインエントリーポイント
│   │   ├── agents/                # エージェント定義
│   │   │   ├── index.ts           # エージェントのエクスポート
│   │   │   ├── projectAgent.ts    # プロジェクト質問対応エージェント
│   │   │   └── taskAgent.ts       # タスク管理サブエージェント
│   │   ├── tools/                 # ツール定義
│   │   │   ├── index.ts           # ツールのエクスポート
│   │   │   ├── projectTools.ts    # プロジェクト情報関連ツール
│   │   │   └── taskTools.ts       # タスク管理ツール
│   │   ├── workflows/             # ワークフロー定義
│   │   │   ├── index.ts           # ワークフローのエクスポート
│   │   │   └── meetingWorkflow.ts # 会議情報処理ワークフロー
│   │   └── memory/                # メモリ関連
│   │       ├── index.ts           # メモリシステムのエクスポート
│   │       ├── projectMemory.ts   # プロジェクト情報メモリ
│   │       └── vectorStore.ts     # ベクトルストアの設定
│   ├── api/                       # API定義
│   │   ├── index.ts               # APIルーターのエクスポート
│   │   ├── meeting.ts             # 会議情報APIエンドポイント
│   │   └── project.ts             # プロジェクト情報APIエンドポイント
│   └── db/                        # データベース定義
│       ├── index.ts               # データベース接続設定
│       ├── migrations/            # マイグレーションファイル
│       └── schema.ts              # スキーマ定義
├── .env                           # 環境変数
└── package.json                   # 依存関係
```

## 2. 主要コンポーネントの実装

### 2.1 会議情報処理ワークフロー

`src/mastra/workflows/meetingWorkflow.ts`

```typescript
import { createWorkflow, createStep } from '@mastra/core/workflow';
import { openai } from '@mastra/core/llm';
import { MDocument } from '@mastra/memory';
import { vectorStore } from '../memory/vectorStore';
import { saveTasks } from '../tools/taskTools';

// 会議情報処理ワークフロー
export const meetingWorkflow = createWorkflow({
  id: 'meeting-processing',
  description: '会議トランスクリプトの処理と情報抽出を行うワークフロー',

  steps: {
    // ステップ1: メタデータ検証
    validateMetadata: createStep({
      handler: async (ctx, { input }) => {
        const { transcript, projectId, meetingDate, participants } = input;

        if (!transcript || !projectId || !meetingDate) {
          return {
            status: 'error',
            message: '必須メタデータが不足しています',
            missingFields: [
              !transcript ? 'transcript' : null,
              !projectId ? 'projectId' : null,
              !meetingDate ? 'meetingDate' : null,
            ].filter(Boolean),
          };
        }

        return {
          status: 'success',
          transcript,
          projectId,
          meetingDate: new Date(meetingDate),
          participants: participants || [],
        };
      },
    }),

    // ステップ2: 会議内容の分析
    analyzeMeeting: createStep({
      handler: async (ctx, { input }) => {
        const { transcript, projectId, meetingDate, participants } = input;

        // OpenAIモデルを使用して会議内容を分析
        const analysis = await openai('gpt-4o').generate(`
          以下の会議トランスクリプトを分析し、以下の情報を抽出してください:
          1. 会議の要約 (300文字以内)
          2. 主要な議論ポイント (箇条書きで5-7項目)
          3. 次のステップや決定事項 (箇条書き)
          
          会議情報:
          プロジェクトID: ${projectId}
          日付: ${meetingDate.toISOString().split('T')[0]}
          参加者: ${participants.join(', ')}
          
          トランスクリプト:
          ${transcript}
          
          JSON形式で返答してください:
          {
            "summary": "会議の要約",
            "keyPoints": ["ポイント1", "ポイント2", ...],
            "nextSteps": ["ステップ1", "ステップ2", ...]
          }
        `);

        try {
          const parsedAnalysis = JSON.parse(analysis.text);

          return {
            ...input,
            analysis: parsedAnalysis,
          };
        } catch (error) {
          console.error('会議分析結果のパースに失敗しました:', error);
          return {
            status: 'error',
            message: '会議分析結果の処理に失敗しました',
            rawAnalysis: analysis.text,
          };
        }
      },
    }),

    // ステップ3: タスク抽出
    extractTasks: createStep({
      handler: async (ctx, { input }) => {
        const { transcript, projectId, analysis } = input;

        // OpenAIモデルを使用してタスクを抽出
        const taskExtraction = await openai('gpt-4o').generate(`
          以下の会議トランスクリプトから、全てのタスクやアクションアイテムを抽出してください。
          各タスクには以下の情報を含めてください:
          - タスクの説明
          - 担当者 (言及されている場合)
          - 期限 (言及されている場合)
          - 優先度 (言及されている場合、または内容から推測)
          
          会議トランスクリプト:
          ${transcript}
          
          JSON形式で返答してください:
          {
            "tasks": [
              {
                "description": "タスクの説明",
                "assignee": "担当者名 (不明な場合は空文字)",
                "dueDate": "YYYY-MM-DD形式 (不明な場合は空文字)",
                "priority": "high/medium/low (不明な場合はmedium)"
              },
              ...
            ]
          }
        `);

        try {
          const parsedTasks = JSON.parse(taskExtraction.text);

          // 抽出したタスクをデータベースに保存
          const meetingId = `meeting-${projectId}-${input.meetingDate.getTime()}`;
          const savedTasks = await saveTasks(
            parsedTasks.tasks.map(task => ({
              ...task,
              projectId,
              sourceType: 'meeting',
              sourceId: meetingId,
              status: 'pending',
              createdAt: new Date(),
            })),
          );

          return {
            ...input,
            tasks: savedTasks,
          };
        } catch (error) {
          console.error('タスク抽出結果のパースに失敗しました:', error);
          return {
            status: 'error',
            message: 'タスク抽出結果の処理に失敗しました',
            rawTaskExtraction: taskExtraction.text,
          };
        }
      },
    }),

    // ステップ4: 永続化
    persistData: createStep({
      handler: async (ctx, { input }) => {
        const { transcript, projectId, meetingDate, participants, analysis, tasks } = input;

        // 会議IDの生成
        const meetingId = `meeting-${projectId}-${meetingDate.getTime()}`;

        // トランスクリプトとその分析結果をベクトルDBに保存
        await vectorStore.addDocuments([
          // 生トランスクリプト
          new MDocument({
            id: `${meetingId}-raw`,
            text: transcript,
            metadata: {
              type: 'meeting-transcript',
              projectId,
              meetingDate: meetingDate.toISOString(),
              participants,
            },
          }),

          // 会議要約
          new MDocument({
            id: `${meetingId}-summary`,
            text: analysis.summary,
            metadata: {
              type: 'meeting-summary',
              projectId,
              meetingDate: meetingDate.toISOString(),
              participants,
            },
          }),

          // 主要ポイント (各ポイントを個別のドキュメントとして保存)
          ...analysis.keyPoints.map(
            (point, index) =>
              new MDocument({
                id: `${meetingId}-keypoint-${index}`,
                text: point,
                metadata: {
                  type: 'meeting-keypoint',
                  projectId,
                  meetingDate: meetingDate.toISOString(),
                  participants,
                },
              }),
          ),

          // 次のステップ (各ステップを個別のドキュメントとして保存)
          ...(analysis.nextSteps || []).map(
            (step, index) =>
              new MDocument({
                id: `${meetingId}-nextstep-${index}`,
                text: step,
                metadata: {
                  type: 'meeting-nextstep',
                  projectId,
                  meetingDate: meetingDate.toISOString(),
                  participants,
                },
              }),
          ),
        ]);

        // 会議レコードをデータベースに保存 (スキーマ詳細は省略)
        // await db.meetingRecords.create({ ... });

        return {
          status: 'success',
          meetingId,
          projectId,
          meetingDate,
          summary: analysis.summary,
          taskCount: tasks.length,
        };
      },
    }),
  },

  // ワークフローのグラフ定義
  graph: {
    start: 'validateMetadata',
    validateMetadata: {
      next: 'analyzeMeeting',
      error: 'end',
    },
    analyzeMeeting: {
      next: 'extractTasks',
      error: 'end',
    },
    extractTasks: {
      next: 'persistData',
      error: 'end',
    },
    persistData: {
      next: 'end',
    },
  },
});
```

### 2.2 プロジェクト質問対応エージェント

`src/mastra/agents/projectAgent.ts`

```typescript
import { Agent } from '@mastra/core/agent';
import { openai } from '@mastra/core/llm';
import { vectorStore } from '../memory/vectorStore';
import { projectTools } from '../tools/projectTools';
import { taskTools } from '../tools/taskTools';

// プロジェクト質問対応エージェント
export const projectAgent = new Agent({
  name: 'ProjectAssistant',
  description: 'プロジェクト情報の質問に回答し、タスク管理を支援するアシスタント',

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
  `,

  model: openai('gpt-4o'),

  // 使用するツール
  tools: [
    ...projectTools,
    ...taskTools,
    {
      name: 'searchProjectInformation',
      description: 'プロジェクト関連情報をベクトルDBから検索します',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '検索クエリ' },
          projectId: { type: 'string', description: 'プロジェクトID (任意)' },
          type: {
            type: 'string',
            description:
              '検索対象タイプ (任意): meeting-transcript, meeting-summary, meeting-keypoint, meeting-nextstep',
            enum: ['meeting-transcript', 'meeting-summary', 'meeting-keypoint', 'meeting-nextstep'],
          },
          limit: { type: 'number', description: '取得する結果の最大数 (デフォルト: 5)' },
        },
        required: ['query'],
      },
      handler: async ({ query, projectId, type, limit = 5 }) => {
        const filter = {
          ...(projectId ? { projectId } : {}),
          ...(type ? { type } : {}),
        };

        const results = await vectorStore.similaritySearch(query, limit, filter);

        return results.map(doc => ({
          content: doc.text,
          metadata: doc.metadata,
          score: doc.score,
        }));
      },
    },
  ],

  // 会話の履歴を保持するメモリ
  memory: 'conversation',
});
```

### 2.3 タスク管理ツール

`src/mastra/tools/taskTools.ts`

```typescript
import { db } from '../../db';

// タスク管理ツール
export const taskTools = [
  {
    name: 'listTasks',
    description: 'プロジェクトのタスク一覧を取得します',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'プロジェクトID' },
        status: {
          type: 'string',
          description: 'タスクのステータス (任意): pending, in-progress, completed',
          enum: ['pending', 'in-progress', 'completed'],
        },
        assignee: { type: 'string', description: '担当者名 (任意)' },
      },
      required: ['projectId'],
    },
    handler: async ({ projectId, status, assignee }) => {
      // データベースからタスクを検索
      const filter = {
        projectId,
        ...(status ? { status } : {}),
        ...(assignee ? { assignee } : {}),
      };

      const tasks = await db.tasks.findMany({ where: filter });

      return tasks;
    },
  },

  {
    name: 'getTaskDetails',
    description: '特定のタスクの詳細情報を取得します',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'タスクID' },
      },
      required: ['taskId'],
    },
    handler: async ({ taskId }) => {
      const task = await db.tasks.findUnique({ where: { id: taskId } });

      if (!task) {
        return { error: '指定されたIDのタスクが見つかりません' };
      }

      return task;
    },
  },

  {
    name: 'createTask',
    description: '新しいタスクを作成します',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'プロジェクトID' },
        description: { type: 'string', description: 'タスクの説明' },
        assignee: { type: 'string', description: '担当者名 (任意)' },
        dueDate: { type: 'string', description: '期限 (YYYY-MM-DD形式) (任意)' },
        priority: {
          type: 'string',
          description: '優先度 (任意): low, medium, high',
          enum: ['low', 'medium', 'high'],
          default: 'medium',
        },
      },
      required: ['projectId', 'description'],
    },
    handler: async ({ projectId, description, assignee, dueDate, priority = 'medium' }) => {
      // 新しいタスクを作成
      const task = await db.tasks.create({
        data: {
          projectId,
          description,
          assignee: assignee || null,
          dueDate: dueDate ? new Date(dueDate) : null,
          priority,
          status: 'pending',
          sourceType: 'manual',
          createdAt: new Date(),
        },
      });

      return task;
    },
  },

  {
    name: 'updateTaskStatus',
    description: 'タスクのステータスを更新します',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'タスクID' },
        status: {
          type: 'string',
          description: '新しいステータス: pending, in-progress, completed',
          enum: ['pending', 'in-progress', 'completed'],
        },
      },
      required: ['taskId', 'status'],
    },
    handler: async ({ taskId, status }) => {
      // タスクのステータスを更新
      const task = await db.tasks.update({
        where: { id: taskId },
        data: {
          status,
          updatedAt: new Date(),
          // completedがtrueの場合は完了日時も記録
          ...(status === 'completed' ? { completedAt: new Date() } : {}),
        },
      });

      return task;
    },
  },
];

// タスク保存用のヘルパー関数
export async function saveTasks(tasks) {
  // データベースに一括保存
  const savedTasks = await db.tasks.createMany({
    data: tasks,
    skipDuplicates: true,
  });

  return savedTasks;
}
```

### 2.4 メインアプリケーションのエントリーポイント

`src/mastra/index.ts`

```typescript
import { Mastra } from '@mastra/core';
import { projectAgent } from './agents/projectAgent';
import { meetingWorkflow } from './workflows/meetingWorkflow';
import { createLogger } from '@mastra/loggers';

// ロガーの設定
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
});

// Mastraインスタンスの初期化
export const mastra = new Mastra({
  agents: {
    projectAgent,
  },
  workflows: {
    meetingWorkflow,
  },
  logger,
});

// APIサーバーの起動設定
if (require.main === module) {
  const port = process.env.PORT || 4111;

  mastra.listen(port, () => {
    logger.info(`📊 プロジェクト管理AIシステムが起動しました！`);
    logger.info(`API: http://localhost:${port}/api`);
    logger.info(`Swagger UI: http://localhost:${port}/swagger-ui`);
    logger.info(`Playground: http://localhost:${port}/`);
  });
}

export default mastra;
```

## 3. 実装時の注意点

### 3.1 環境変数の設定

`.env`ファイルには以下の変数を設定してください：

```
# OpenAI API設定
OPENAI_API_KEY=sk-...

# データベース設定
DATABASE_URL=postgresql://username:password@localhost:5432/project_management

# アプリケーション設定
PORT=4111
LOG_LEVEL=info
```

### 3.2 データベースのセットアップ

PostgreSQLとpgvector拡張機能を設定します：

```sql
-- pgvector拡張のインストール
CREATE EXTENSION IF NOT EXISTS vector;

-- プロジェクトテーブルの作成
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP,
  status TEXT NOT NULL,
  client_info JSONB,
  tags TEXT[]
);

-- 会議記録テーブルの作成
CREATE TABLE meeting_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  date TIMESTAMP NOT NULL,
  participants TEXT[],
  raw_transcript TEXT NOT NULL,
  summary TEXT,
  key_points TEXT[],
  next_steps TEXT[],
  vector_embedding vector(1536),
  CONSTRAINT fk_project FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- タスクテーブルの作成
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  description TEXT NOT NULL,
  assignee TEXT,
  due_date TIMESTAMP,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP,
  completed_at TIMESTAMP
);

-- インデックスの作成
CREATE INDEX idx_meeting_project_id ON meeting_records(project_id);
CREATE INDEX idx_tasks_project_id ON tasks(project_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee);
CREATE INDEX idx_tasks_status ON tasks(status);
```

### 3.3 APIエンドポイント

`src/api/meeting.ts`（一部のみ表示）：

```typescript
import { Router } from 'express';
import { mastra } from '../mastra';

const router = Router();

// 会議情報処理エンドポイント
router.post('/process', async (req, res) => {
  try {
    const { transcript, projectId, meetingDate, participants } = req.body;

    // 入力検証
    if (!transcript || !projectId || !meetingDate) {
      return res.status(400).json({
        error: '必須パラメータが不足しています',
      });
    }

    // ワークフローを実行
    const result = await mastra.workflows.meetingWorkflow.start({
      transcript,
      projectId,
      meetingDate,
      participants: participants || [],
    });

    return res.json(result);
  } catch (error) {
    console.error('会議情報処理中にエラーが発生しました:', error);
    return res.status(500).json({
      error: '会議情報の処理に失敗しました',
      message: error.message,
    });
  }
});

export default router;
```

## 4. 使用例

### 4.1 会議情報の登録

```bash
curl -X POST http://localhost:4111/api/meeting/process \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "proj-001",
    "meetingDate": "2023-06-15",
    "participants": ["山田太郎", "佐藤花子", "鈴木一郎"],
    "transcript": "議事録の内容をここに記載..."
  }'
```

### 4.2 エージェントへの質問

```bash
curl -X POST http://localhost:4111/api/agent/projectAgent/generate \
  -H "Content-Type: application/json" \
  -d '{
    "input": "プロジェクトproj-001の進捗状況を教えてください"
  }'
```

## 5. デプロイ方法

Mastraアプリケーションのデプロイには以下の方法があります：

1. **Docker**:

   ```bash
   docker build -t project-management-ai .
   docker run -p 4111:4111 --env-file .env project-management-ai
   ```

2. **Vercel**:

   ```bash
   npm install -g vercel
   vercel
   ```

3. **Mastra Cloud**:
   ```bash
   npx @mastra/cli deploy
   ```

各方法の詳細は、Mastraの公式ドキュメントを参照してください。
