CREATE TABLE script_build_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    module_id UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
    completed_batches INTEGER NOT NULL DEFAULT 0,
    total_batches INTEGER NOT NULL DEFAULT 0,
    result JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX script_build_active ON script_build_jobs(module_id) WHERE status IN ('pending','running');
CREATE INDEX script_build_channel ON script_build_jobs(channel_id,created_at DESC);
