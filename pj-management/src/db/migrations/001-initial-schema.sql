CREATE EXTENSION IF NOT EXISTS vector;

-- プロジェクトテーブル
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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

-- ベクトルストアテーブル (環境変数に基づいて作成)
CREATE TABLE embeddings (
  id TEXT PRIMARY KEY,
  embedding vector(1536), -- Dimensions from .env (PGVECTOR_EMBEDDING_DIMENSIONS)
  content TEXT,
  metadata JSONB
);

-- ベクトルインデックス (HNSW)
CREATE INDEX hnsw_idx ON embeddings USING hnsw (embedding vector_cosine_ops); 