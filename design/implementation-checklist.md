# プロジェクト管理AIシステム実装チェックリスト

このチェックリストは、設計書に基づいてMastraフレームワークを使用したプロジェクト管理AIシステムを実装するためのステップバイステップガイドです。

## 1. 環境構築

- [x] Node.js v20.0以上をインストール
- [x] プロジェクトの初期化
  ```bash
  mkdir project-management
  cd project-management
  npm init -y
  ```
- [x] TypeScript関連パッケージのインストール
  ```bash
  npm install typescript tsx @types/node --save-dev
  npx tsc --init
  ```
- [x] Mastra関連パッケージのインストール
  ```bash
  npm install @mastra/core @mastra/memory @mastra/pg zod @ai-sdk/openai
  ```
- [x] 必要に応じて追加パッケージのインストール
  ```bash
  npm install pg pg-promise pgvector express dotenv @mastra/loggers
  # APIサーバーが必要な場合
  npm install express @types/express
  ```

## 2. プロジェクト構造の設定

- [x] ディレクトリ構造の作成
  ```bash
  mkdir -p src/mastra/{agents,tools,workflows,memory} src/api src/db/migrations src/utils
  ```
- [x] `.env` ファイルの作成と環境変数の設定

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

- [x] `package.json` にスクリプトを追加
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
- [x] `tsconfig.json` の設定
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
- [x] 環境変数読み込みユーティリティ (`src/utils/env.ts`) - オプションだが推奨

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

- [x] PostgreSQLデータベースの作成
  ```bash
  createdb project_management_ai
  # またはSQLクライアントを使用
  ```
- [x] pgvector拡張のインストール
  ```sql
  -- SQLクライアントで実行
  CREATE EXTENSION IF NOT EXISTS vector;
  ```
- [x] データベーススキーマの作成

  - [x] マイグレーションファイルの作成 (`src/db/migrations/001-initial-schema.sql`)

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

  - [x] マイグレーション実行スクリプトの作成 (`src/db/migrations/run-migrations.ts`)

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

- [x] **テスト:** マイグレーションの実行
  ```bash
  npm run db:migrate
  # データベースクライアントでテーブルが作成されたことを確認
  ```

## 4. データベース接続の実装

- [x] データベース接続設定 (`src/db/index.ts`)

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

- [x] **テスト:** データベース接続テスト
  ```bash
  npm run test:db
  # コンソールに "✅ Database connection successful" が表示されることを確認
  ```

## 5. ベクトルストアの実装

- [x] ベクトルストア設定 (`src/mastra/memory/vectorStore.ts`) - Embedding Model のみ実装

## 6. メモリシステムの実装 (例: Conversation Memory)

- [ ] (必要であれば) メモリシステム設定 (`src/mastra/memory/index.ts`) - スキップ (Agentで設定)

## 7. ツールの実装

- [x] ツールエクスポートファイル (`src/mastra/tools/index.ts`)

  ```typescript
  // src/mastra/tools/index.ts
  export * from './projectTools';
  export * from './taskTools';
  // Add the vector search tool here or directly in the agent definition
  export * from './searchTools';
  ```

- [x] プロジェクト関連ツール (`src/mastra/tools/projectTools.ts`)

  - [x] プロジェクト情報取得ツール (`getProjectDetails`)
  - [x] プロジェクト検索/一覧ツール (`listProjects`)
  - [x] プロジェクト作成/更新ツール (必要に応じて)

- [x] タスク管理ツール (`src/mastra/tools/taskTools.ts`)

  - [x] タスク一覧取得ツール (`listTasks`)
  - [x] タスク詳細取得ツール (`getTaskDetails`)
  - [x] タスク作成ツール (`createTask`)
  - [x] タスクステータス更新ツール (`updateTaskStatus`)
  - [x] タスク保存用ヘルパー関数 (`saveTasks` - ワークフロー用)

- [ ] 検索関連ツール (`src/mastra/tools/searchTools.ts`) - Agentで直接実装予定

- [x] **テスト:** ツール定義の構文確認
  ```bash
  npx tsc --noEmit
  # TypeScriptコンパイルエラーが出ないことを確認
  ```

## 8. ワークフローの実装 (保留 - アプローチ変更)

**方針変更:** Workflow API のデバッグ困難のため、会議処理ロジックはセクション10の API エンドポイント (`src/api/meeting.ts`) で直接実装します。

- [ ] ~~ワークフローエクスポートファイル (`src/mastra/workflows/index.ts`)~~
- [ ] ~~会議情報処理ワークフロー (`src/mastra/workflows/meetingWorkflow.ts`)~~
  - [ ] ~~ワークフローとステップの定義~~
  - [ ] ~~メタデータ検証ステップ~~
  - [ ] ~~会議内容分析ステップ (LLM呼び出し)~~
  - [ ] ~~タスク抽出ステップ (LLM呼び出し)~~
  - [ ] ~~データ永続化ステップ~~
  - [ ] ~~ワークフローのグラフ定義~~
- [ ] ~~**テスト:** ワークフロー定義の構文確認とPlaygroundでの実行~~

## 9. エージェントの実装

- [x] エージェントエクスポートファイル (`src/mastra/agents/index.ts`)
- [x] プロジェクト質問対応エージェント (`src/mastra/agents/projectAgent.ts`)
  - [x] エージェント定義 (`new Agent`)
    - [x] 名前 (`name`), 指示 (`instructions`)
    - [x] 使用するモデル (`model: openai('gpt-4o')` など)
    - [x] 使用するツール (`tools`: projectTools, taskTools, searchTools を展開して含める)
    - [x] メモリ設定 (`memory: new Memory()`)
- [x] **テスト:** エージェント定義の構文確認とPlaygroundでの対話 - 構文確認OK (Workflowエラーは無視)

## 10. APIエンドポイントの実装 (Expressを使用する場合)

- [x] APIルーター (`src/api/index.ts`)
- [x] 会議情報APIエンドポイント (`src/api/meeting.ts`)
  - [x] `/process` (POST): 会議情報を受け取り、**会議処理ロジック (分析、タスク抽出、DB/Vector保存) を実行する**
- [x] プロジェクト情報APIエンドポイント (`src/api/project.ts`)
  - [x] `/` (GET): プロジェクト一覧取得
  - [x] `/:projectId` (GET): 特定プロジェクト詳細取得
  - [x] `/:projectId/tasks` (GET): 特定プロジェクトのタスク一覧取得
  - [x] `/tasks` (POST): タスク作成 (エージェント経由でない場合)
  - [x] `/tasks/:taskId` (PUT/PATCH): タスク更新 (エージェント経由でない場合)
- [ ] (オプション) エージェントAPIエンドポイント (`src/api/agent.ts`) - スキップ (Mastraミドルウェア使用)
- [ ] **テスト:** APIエンドポイントの疎通確認 - 未実施

## 11. メインアプリケーションの実装

- [x] Mastraインスタンスの初期化とAPI設定 (`src/mastra/index.ts`)
- [x] アプリケーションのエントリーポイント (`src/index.ts` - Expressを使用する場合)
- [ ] **テスト:** アプリケーションの起動と初期ログ確認 - 未実施

## 12. 統合テスト

// ... (rest of the checklist) ...
