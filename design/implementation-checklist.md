# プロジェクト管理AIシステム実装チェックリスト

このチェックリストは、設計書に基づいてMastraフレームワークを使用したプロジェクト管理AIシステムを実装するためのステップバイステップガイドです。

## 1. 環境構築

- [ ] Node.js v20.0以上をインストール
- [ ] プロジェクトの初期化
  ```bash
  mkdir project-management
  cd project-management
  npm init -y
  ```
- [ ] TypeScript関連パッケージのインストール
  ```bash
  npm install typescript tsx @types/node --save-dev
  npx tsc --init
  ```
- [ ] Mastra関連パッケージのインストール
  ```bash
  npm install @mastra/core @mastra/memory @mastra/pg zod @ai-sdk/openai
  ```
- [ ] 必要に応じて追加パッケージのインストール
  ```bash
  npm install pg pg-promise pgvector express dotenv @mastra/loggers
  # APIサーバーが必要な場合
  npm install express @types/express
  ```

## 2. プロジェクト構造の設定

- [ ] ディレクトリ構造の作成
  ```bash
  mkdir -p src/mastra/{agents,tools,workflows,memory} src/api src/db/migrations src/utils
  ```
- [ ] `.env` ファイルの作成と環境変数の設定

  ```bash
  touch .env
  ```

  ```dotenv
  # .env
  # OpenAI API設定
  OPENAI_API_KEY=YOUR_API_KEY_HERE

  # データベース設定
  DATABASE_URL=postgresql://username:password@localhost:5432/project_management_ai

  # アプリケーション設定
  PORT=4111
  LOG_LEVEL=info

  # ベクトルストア設定 (例)
  PGVECTOR_TABLE_NAME=embeddings
  PGVECTOR_ID_COLUMN=id
  PGVECTOR_VECTOR_COLUMN=embedding
  PGVECTOR_CONTENT_COLUMN=content
  PGVECTOR_METADATA_COLUMN=metadata
  PGVECTOR_EMBEDDING_DIMENSIONS=1536 # OpenAI text-embedding-ada-002 の場合
  ```

- [ ] `package.json` にスクリプトを追加
  ```json
  {
    "scripts": {
      "dev": "tsx watch src/index.ts",
      "build": "tsc",
      "start": "node dist/index.js",
      "db:migrate": "tsx src/db/migrations/run-migrations.ts",
      "test:db": "tsx -e \"import { testConnection } from './src/db'; testConnection().then(process.exit);\"",
      "test:vector": "tsx -e \"import { initializeVectorStore } from './src/mastra/memory/vectorStore'; initializeVectorStore().then(process.exit);\""
    }
  }
  ```
- [ ] `tsconfig.json` の設定
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "esModuleInterop": true,
      "outDir": "./dist",
      "rootDir": "./src",
      "strict": true,
      "skipLibCheck": true,
      "resolveJsonModule": true, // JSONファイルのインポートを許可
      "forceConsistentCasingInFileNames": true
    },
    "include": ["src/**/*"],
    "exclude": ["node_modules", "dist"]
  }
  ```
- [ ] 環境変数読み込みユーティリティ (`src/utils/env.ts`) - オプションだが推奨

  ```typescript
  // src/utils/env.ts
  import dotenv from 'dotenv';
  import { z } from 'zod';

  dotenv.config();

  const envSchema = z.object({
    OPENAI_API_KEY: z.string().min(1),
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().default(4111),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    PGVECTOR_TABLE_NAME: z.string().default('embeddings'),
    PGVECTOR_ID_COLUMN: z.string().default('id'),
    PGVECTOR_VECTOR_COLUMN: z.string().default('embedding'),
    PGVECTOR_CONTENT_COLUMN: z.string().default('content'),
    PGVECTOR_METADATA_COLUMN: z.string().default('metadata'),
    PGVECTOR_EMBEDDING_DIMENSIONS: z.coerce.number().default(1536),
  });

  export const env = envSchema.parse(process.env);
  ```

## 3. データベースのセットアップ

- [ ] PostgreSQLデータベースの作成
  ```bash
  createdb project_management_ai
  # またはSQLクライアントを使用
  ```
- [ ] pgvector拡張のインストール
  ```sql
  -- SQLクライアントで実行
  CREATE EXTENSION IF NOT EXISTS vector;
  ```
- [ ] データベーススキーマの作成

  - [ ] マイグレーションファイルの作成 (`src/db/migrations/001-initial-schema.sql`)

    ```sql
    -- プロジェクトテーブル
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      start_date TIMESTAMPTZ NOT NULL,
      end_date TIMESTAMPTZ,
      status TEXT NOT NULL,
      client_info JSONB,
      tags TEXT[]
    );

    -- 会議記録テーブル (ベクトル埋め込みはベクトルストア側で管理する想定に変更)
    CREATE TABLE meeting_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      date TIMESTAMPTZ NOT NULL,
      participants TEXT[],
      raw_transcript TEXT NOT NULL,
      summary TEXT,
      key_points TEXT[],
      next_steps TEXT[]
    );

    -- タスクテーブル
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid(), -- UUID生成を推奨
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      assignee TEXT,
      due_date TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      source_type TEXT NOT NULL, -- 'meeting', 'manual', etc.
      source_id TEXT, -- Optional: ID of meeting or other source
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );

    -- インデックスの作成
    CREATE INDEX idx_meeting_project_id ON meeting_records(project_id);
    CREATE INDEX idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX idx_tasks_assignee ON tasks(assignee);
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_tasks_due_date ON tasks(due_date);
    ```

  - [ ] マイグレーション実行スクリプトの作成 (`src/db/migrations/run-migrations.ts`)

    ```typescript
    // src/db/migrations/run-migrations.ts
    import { Pool } from 'pg';
    import fs from 'fs';
    import path from 'path';
    import dotenv from 'dotenv';

    dotenv.config(); // Load .env file

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    async function runMigrations() {
      const client = await pool.connect();
      try {
        const migrationsDir = __dirname; // Assumes script is in migrations dir
        const files = fs
          .readdirSync(migrationsDir)
          .filter(file => file.endsWith('.sql'))
          .sort(); // Ensure order

        for (const file of files) {
          console.log(`Applying migration: ${file}`);
          const filePath = path.join(migrationsDir, file);
          const sql = fs.readFileSync(filePath, 'utf-8');
          await client.query(sql);
          console.log(`Applied migration: ${file}`);
        }
        console.log('All migrations applied successfully.');
      } catch (err) {
        console.error('Migration failed:', err);
        // Consider adding transaction rollback here if needed
      } finally {
        client.release();
        await pool.end();
      }
    }

    runMigrations();
    ```

- [ ] **テスト:** マイグレーションの実行
  ```bash
  npm run db:migrate
  # データベースクライアントでテーブルが作成されたことを確認
  ```

## 4. データベース接続の実装

- [ ] データベース接続設定 (`src/db/index.ts`)

  ```typescript
  // src/db/index.ts
  import { Pool } from 'pg';
  import pgPromise from 'pg-promise';
  import { env } from '../utils/env'; // 環境変数ユーティリティを使用

  const pgp = pgPromise({
    /* Initialization Options */
  });

  const dbConfig = {
    connectionString: env.DATABASE_URL,
    // Add other options like SSL if needed
  };

  // For simple queries using node-postgres Pool
  export const pool = new Pool(dbConfig);

  // For more complex queries using pg-promise
  export const db = pgp(dbConfig);

  // Database connection test function
  export async function testConnection() {
    let client;
    try {
      client = await pool.connect();
      console.log('✅ Database connection successful');
      return true;
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      return false;
    } finally {
      client?.release();
    }
  }

  // Graceful shutdown
  process.on('exit', () => {
    pgp.end();
    pool.end();
    console.log('Database connections closed.');
  });
  ```

- [ ] **テスト:** データベース接続テスト
  ```bash
  npm run test:db
  # コンソールに "✅ Database connection successful" が表示されることを確認
  ```

## 5. ベクトルストアの実装

- [ ] ベクトルストア設定 (`src/mastra/memory/vectorStore.ts`)

  ```typescript
  // src/mastra/memory/vectorStore.ts
  import { PgVector } from '@mastra/pg';
  import { OpenAIEmbedding } from '@ai-sdk/openai'; // Or your chosen embedding model
  import { env } from '../../utils/env';

  // Initialize embedding model (ensure OPENAI_API_KEY is set in .env)
  const embeddingModel = new OpenAIEmbedding({
    model: 'text-embedding-ada-002', // Or another model
    dimensions: env.PGVECTOR_EMBEDDING_DIMENSIONS,
  });

  // Initialize PgVector store
  export const vectorStore = new PgVector({
    connectionString: env.DATABASE_URL,
    tableName: env.PGVECTOR_TABLE_NAME,
    dimensions: env.PGVECTOR_EMBEDDING_DIMENSIONS,
    columns: {
      idColumn: env.PGVECTOR_ID_COLUMN,
      vectorColumn: env.PGVECTOR_VECTOR_COLUMN,
      contentColumn: env.PGVECTOR_CONTENT_COLUMN,
      metadataColumn: env.PGVECTOR_METADATA_COLUMN,
    },
    embedding: embeddingModel, // Provide the embedding model instance
  });

  // Function to initialize the vector store (create table if not exists)
  export async function initializeVectorStore() {
    try {
      // This method internally checks and creates the table and HNSW index
      await vectorStore.createTableIfNotExists();
      console.log(\`✅ Vector store table '\${env.PGVECTOR_TABLE_NAME}' initialized successfully.\`);
      return true;
    } catch (error) {
      console.error('❌ Vector store initialization failed:', error);
      return false;
    }
  }
  ```

- [ ] **テスト:** ベクトルストア初期化テスト
  ```bash
  npm run test:vector
  # コンソールに "✅ Vector store table 'embeddings' initialized successfully." が表示されること、
  # 及びデータベースに \`embeddings\` テーブル (または設定した名前) と HNSW インデックスが作成されることを確認
  ```

## 6. メモリシステムの実装 (例: Conversation Memory)

- [ ] (必要であれば) メモリシステム設定 (`src/mastra/memory/index.ts`)
  ```typescript
  // src/mastra/memory/index.ts
  // 基本的な会話メモリは Agent 定義時に直接指定できることが多い
  // より複雑なメモリ戦略が必要な場合にここで定義
  export * from './vectorStore';
  ```

## 7. ツールの実装

- [ ] ツールエクスポートファイル (`src/mastra/tools/index.ts`)

  ```typescript
  // src/mastra/tools/index.ts
  export * from './projectTools';
  export * from './taskTools';
  // Add the vector search tool here or directly in the agent definition
  export * from './searchTools';
  ```

- [ ] プロジェクト関連ツール (`src/mastra/tools/projectTools.ts`)

  - [ ] プロジェクト情報取得ツール (`getProjectDetails`)
  - [ ] プロジェクト検索/一覧ツール (`listProjects`)
  - [ ] プロジェクト作成/更新ツール (必要に応じて)

- [ ] タスク管理ツール (`src/mastra/tools/taskTools.ts`)

  - [ ] タスク一覧取得ツール (`listTasks`)
  - [ ] タスク詳細取得ツール (`getTaskDetails`)
  - [ ] タスク作成ツール (`createTask`)
  - [ ] タスクステータス更新ツール (`updateTaskStatus`)
  - [ ] タスク保存用ヘルパー関数 (`saveTasks` - ワークフロー用)

- [ ] 検索関連ツール (`src/mastra/tools/searchTools.ts`)

  - [ ] ベクトル検索ツール (`searchProjectInformation`)

- [ ] **テスト:** ツール定義の構文確認
  ```bash
  npx tsc --noEmit
  # TypeScriptコンパイルエラーが出ないことを確認
  ```

## 8. ワークフローの実装

- [ ] ワークフローエクスポートファイル (`src/mastra/workflows/index.ts`)

  ```typescript
  // src/mastra/workflows/index.ts
  export * from './meetingWorkflow';
  ```

- [ ] 会議情報処理ワークフロー (`src/mastra/workflows/meetingWorkflow.ts`)

  - [ ] ワークフローとステップの定義 (`createWorkflow`, `createStep`)
  - [ ] メタデータ検証ステップ
  - [ ] 会議内容分析ステップ (LLM呼び出し)
  - [ ] タスク抽出ステップ (LLM呼び出し)
  - [ ] データ永続化ステップ (ベクトルストアへの `addDocuments`、`tasks` テーブルへの `saveTasks`、`meeting_records` テーブルへの保存)
  - [ ] ワークフローのグラフ定義

- [ ] **テスト:** ワークフロー定義の構文確認とPlaygroundでの実行
  ```bash
  npx tsc --noEmit # まず構文エラーがないか確認
  npm run dev      # アプリケーションを起動
  ```
  - [ ] ブラウザで Playground UI (`http://localhost:4111/` など) を開く
  - [ ] "Workflows" タブに `meeting-processing` (または定義したID) が表示されていることを確認
  - [ ] 適切な入力 (projectId, meetingDate, transcript) をJSON形式で与えてワークフローを実行
  - [ ] 各ステップが成功し、期待される出力が得られるか確認
  - [ ] データベース (`meeting_records`, `tasks`) とベクトルストア (`embeddings`) にデータが正しく保存されているか確認

## 9. エージェントの実装

- [ ] エージェントエクスポートファイル (`src/mastra/agents/index.ts`)

  ```typescript
  // src/mastra/agents/index.ts
  export * from './projectAgent';
  ```

- [ ] プロジェクト質問対応エージェント (`src/mastra/agents/projectAgent.ts`)

  - [ ] エージェント定義 (`new Agent`)
    - [ ] 名前 (`name`), 説明 (`description`), 指示 (`instructions`)
    - [ ] 使用するモデル (`model: openai('gpt-4o')` など)
    - [ ] 使用するツール (`tools`: projectTools, taskTools, searchTools を展開して含める)
    - [ ] メモリ設定 (`memory: 'conversation'` またはカスタムメモリ)

- [ ] **テスト:** エージェント定義の構文確認とPlaygroundでの対話
  ```bash
  npx tsc --noEmit # まず構文エラーがないか確認
  npm run dev      # アプリケーションを起動
  ```
  - [ ] ブラウザで Playground UI (`http://localhost:4111/` など) を開く
  - [ ] "Agents" タブに `ProjectAssistant` (または定義した名前) が表示されていることを確認
  - [ ] 様々な質問を入力して対話を開始
    - [ ] 例: 「プロジェクトXYZの概要を教えて」
    - [ ] 例: 「田中さんの未完了タスクをリストして」
    - [ ] 例: 「前回の会議での決定事項は何？」
  - [ ] エージェントが適切に応答するか確認
  - [ ] 必要に応じてツール (`listTasks`, `searchProjectInformation` など) が呼び出され、その結果が応答に反映されるか確認 (Playgroundの "Trace" やコンソールログで確認)
  - [ ] 会話履歴が保持されているか確認 (メモリ設定が有効な場合)

## 10. APIエンドポイントの実装 (Expressを使用する場合)

- [ ] APIルーター (`src/api/index.ts`)

  ```typescript
  // src/api/index.ts
  import express from 'express';
  import meetingRouter from './meeting';
  import projectRouter from './project';
  // import agentRouter from './agent'; // エージェント用のAPIが必要な場合

  const router = express.Router();

  router.use('/meeting', meetingRouter);
  router.use('/project', projectRouter);
  // router.use('/agent', agentRouter);

  // Simple health check
  router.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  export default router;
  ```

- [ ] 会議情報APIエンドポイント (`src/api/meeting.ts`)

  - [ ] `/process` (POST): 会議情報を受け取り、`meetingWorkflow` を開始する

- [ ] プロジェクト情報APIエンドポイント (`src/api/project.ts`)

  - [ ] `/` (GET): プロジェクト一覧取得
  - [ ] `/:projectId` (GET): 特定プロジェクト詳細取得
  - [ ] `/:projectId/tasks` (GET): 特定プロジェクトのタスク一覧取得
  - [ ] `/tasks` (POST): タスク作成 (エージェント経由でない場合)
  - [ ] `/tasks/:taskId` (PUT/PATCH): タスク更新 (エージェント経由でない場合)

- [ ] (オプション) エージェントAPIエンドポイント (`src/api/agent.ts`)

  - [ ] `/:agentName/generate` (POST): 特定エージェントと対話するエンドポイント (Mastraが提供するミドルウェアを使わない場合)

- [ ] **テスト:** APIエンドポイントの疎通確認
  ```bash
  npm run dev # アプリケーションを起動
  ```
  - [ ] `curl` や Postman, Insomnia などのツールを使用
  - [ ] ヘルスチェック: `curl http://localhost:4111/api/health` -> `{"status":"ok"}`
  - [ ] 会議処理:
    ```bash
    curl -X POST http://localhost:4111/api/meeting/process \\
      -H "Content-Type: application/json" \\
      -d '{
        "projectId": "proj-api-test",
        "meetingDate": "2024-07-27T10:00:00Z",
        "participants": ["API User"],
        "transcript": "これはAPI経由でのテスト会議のトランスクリプトです。タスクAをアサインします。"
      }'
    # -> ワークフローの実行結果 (JSON) が返ることを確認
    # -> データベースとベクトルストアにデータが保存されることを確認
    ```
  - [ ] プロジェクト/タスク取得 (データ投入後):
    ```bash
    curl http://localhost:4111/api/project/proj-api-test/tasks
    # -> 作成されたタスクが含まれるJSON配列が返ることを確認
    ```

## 11. メインアプリケーションの実装

- [ ] Mastraインスタンスの初期化とAPI設定 (`src/mastra/index.ts`)

  ```typescript
  // src/mastra/index.ts
  import { Mastra } from '@mastra/core';
  import { createLogger } from '@mastra/loggers';
  import { projectAgent } from './agents'; // index.ts からインポート
  import { meetingWorkflow } from './workflows'; // index.ts からインポート
  import { env } from '../utils/env';

  // ロガーの設定
  const logger = createLogger({
    level: env.LOG_LEVEL,
  });

  // Mastraインスタンスの初期化
  export const mastra = new Mastra({
    agents: {
      projectAgent, // projectAgent: projectAgent と同じ
    },
    workflows: {
      meetingWorkflow, // meetingWorkflow: meetingWorkflow と同じ
    },
    logger,
    // 必要に応じて他の設定 (メモリプロバイダなど)
  });

  // 必要であれば、ここで初期化処理を呼び出す
  // import { initializeVectorStore } from './memory/vectorStore';
  // initializeVectorStore(); // アプリケーション起動時にベクトルストアを初期化
  ```

- [ ] アプリケーションのエントリーポイント (`src/index.ts` - Expressを使用する場合)

  ```typescript
  // src/index.ts
  import express from 'express';
  import { mastra } from './mastra'; // mastra インスタンスをインポート
  import apiRouter from './api';
  import { testConnection } from './db';
  import { initializeVectorStore } from './mastra/memory/vectorStore';
  import { env } from './utils/env';

  const app = express();
  const port = env.PORT;

  // Middleware
  app.use(express.json()); // JSON body parser
  // Add other middleware like CORS if needed: import cors from 'cors'; app.use(cors());

  // API Routes
  app.use('/api', apiRouter);

  // Mastra Middleware (includes Playground UI and agent/workflow APIs)
  // これにより /playground, /swagger-ui, /api/agents/:agentName/generate などが有効になる
  app.use(mastra.middleware());

  // Start server function
  async function startServer() {
    try {
      // 1. Test DB connection
      if (!await testConnection()) {
        throw new Error('Database connection failed. Please check DATABASE_URL.');
      }

      // 2. Initialize Vector Store
      if (!await initializeVectorStore()) {
        // Decide if this is critical. Maybe just log a warning?
        console.warn('Vector store initialization failed. Search functionality might be limited.');
      }

      // 3. Start listening
      app.listen(port, () => {
        console.log(\`\\n🚀 Project Management AI Server listening on port \${port}\`);
        console.log(\`   API Base URL: http://localhost:\${port}/api\`);
        console.log(\`   Playground:   http://localhost:\${port}/playground\`);
        console.log(\`   Swagger UI:   http://localhost:\${port}/swagger-ui\`);
        mastra.logStatus(); // Log registered agents and workflows
      });

    } catch (error) {
      console.error("💥 Failed to start server:", error);
      process.exit(1); // Exit if critical setup fails
    }
  }

  startServer();
  ```

- [ ] **テスト:** アプリケーションの起動と初期ログ確認
  ```bash
  npm run dev
  ```
  - [ ] コンソールにエラーなく起動メッセージが表示されることを確認
    - [ ] 例: `✅ Database connection successful`
    - [ ] 例: `✅ Vector store table 'embeddings' initialized successfully.`
    - [ ] 例: `🚀 Project Management AI Server listening on port 4111`
    - [ ] 例: `   Playground:   http://localhost:4111/playground`
    - [ ] 例: Mastraのログ (`Registered Agent: ProjectAssistant`, `Registered Workflow: meeting-processing` など)
  - [ ] ブラウザで Playground UI (`http://localhost:4111/playground`) と Swagger UI (`http://localhost:4111/swagger-ui`) にアクセスできることを確認

## 12. 統合テスト

- [ ] **テスト:** エンドツーエンドのシナリオ実行
  - [ ] 1. アプリケーションを起動 (`npm run dev`)
  - [ ] 2. **会議情報の登録:**
    - [ ] Playground UI の "Workflows" タブで `meeting-processing` を選択し、実際の会議データに近い内容で実行。
    - [ ] または、API経由 (`curl` など) で `/api/meeting/process` エンドポイントにデータをPOST。
    - [ ] データベース (`meeting_records`, `tasks`) とベクトルストア (`embeddings`) にデータが正しく保存されたことを確認。
  - [ ] 3. **エージェントへの質問:**
    - [ ] Playground UI の "Agents" タブで `ProjectAssistant` を選択。
    - [ ] 登録した会議情報に関する質問をする (例: 「[プロジェクトID] の最新の会議の要約は？」、「[プロジェクトID] で [担当者名] に割り当てられたタスクは？」)。
    - [ ] エージェントがベクトル検索ツールやタスクリストツールを適切に使用し、正しい情報に基づいて応答するか確認。
    - [ ] 新しいタスクの作成を依頼する (例: 「[プロジェクトID] に『ドキュメント作成』タスクを追加して」)。
    - [ ] 作成されたタスクがデータベースに登録されているか確認。
  - [ ] 4. **タスクステータス更新:**
    - [ ] エージェントにタスクのステータス更新を依頼する (例: 「タスクID [タスクID] を完了にして」)。
    - [ ] または、API経由で `/api/project/tasks/:taskId` にPATCH/PUTリクエストを送る。
    - [ ] データベースでタスクの `status` と `completed_at` (完了の場合) が更新されているか確認。
  - [ ] 5. **繰り返し:** いくつかの異なる会議データと質問パターンで上記ステップを繰り返し、エッジケースや予期しない動作がないか確認。
