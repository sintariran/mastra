CREATE TABLE meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    transcript TEXT NOT NULL,
    summary TEXT,
    decisions JSONB,
    action_items JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);

-- Optional: Add index for faster project_id lookups
CREATE INDEX idx_meetings_project_id ON meetings(project_id); 