-- LLM-organised visual-novel scripts. A job reads one frozen snapshot (whose scope already decides which chat
-- windows and lines are included), asks the model to organise the lines into scenes and staging, validates the
-- result against that snapshot, and builds a new draft presentation. The script only references canonical log
-- events by id; it never carries rewritten dialogue.
CREATE TABLE vn_script_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES log_projects(id) ON DELETE CASCADE,
    snapshot_id     UUID NOT NULL REFERENCES log_snapshots(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
    provider        TEXT NOT NULL DEFAULT 'mock',          -- 'mock' or the LLM mode that planned it
    model           TEXT NOT NULL DEFAULT '',
    params          JSONB NOT NULL DEFAULT '{}'::jsonb,    -- {title, template, instructions, cloud_authorized}
    progress        JSONB NOT NULL DEFAULT '{}'::jsonb,    -- {chunks_total, chunks_done, lines}
    script          JSONB,                                 -- validated script (docs/VN_SCRIPT_SCHEMA.json)
    presentation_id UUID REFERENCES log_presentations(id) ON DELETE SET NULL,
    error           TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 2,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vn_script_jobs_channel_idx ON vn_script_jobs(channel_id, created_at DESC);
CREATE INDEX vn_script_jobs_pending_idx ON vn_script_jobs(status, created_at) WHERE status IN ('pending','running');
