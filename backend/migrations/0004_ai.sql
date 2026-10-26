-- 0004_ai: AI job bookkeeping, processing cursors, proposals, consistency checks

-- One row per analysis run. The partial unique index is the task lock: at most one running job per group.
CREATE TABLE ai_jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('observe','consolidate','consistency','inspiration','module_import','highlight_cleanup')),
    group_key     TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT,
    status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','skipped')),
    from_seq      BIGINT,
    to_seq        BIGINT,
    event_count   INTEGER NOT NULL DEFAULT 0,
    llm_calls     INTEGER NOT NULL DEFAULT 0,
    llm_mode      TEXT NOT NULL DEFAULT 'mock',
    error         TEXT,
    result        JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX ai_jobs_running_lock ON ai_jobs(channel_id, kind, group_key) WHERE status = 'running';
CREATE UNIQUE INDEX ai_jobs_idempotency_idx ON ai_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ai_jobs_channel_idx ON ai_jobs(channel_id, started_at DESC);

-- Last successfully processed event seq per (channel, group, scheduler kind).
CREATE TABLE ai_processing_cursors (
    channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    group_key    TEXT NOT NULL DEFAULT '',
    last_seq     BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, kind, group_key)
);

-- Update proposals: what the AI asked for, what the validator decided.
CREATE TABLE document_proposals (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id       UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    document_id      UUID REFERENCES documents(id) ON DELETE CASCADE,
    ai_job_id        UUID REFERENCES ai_jobs(id) ON DELETE SET NULL,
    expected_version INTEGER,
    ops              JSONB NOT NULL,
    source_event_ids UUID[] NOT NULL DEFAULT '{}',
    evidence         JSONB NOT NULL DEFAULT '[]'::jsonb,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','rejected','needs_gm_review')),
    rejection_reason TEXT,
    committed_version INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at       TIMESTAMPTZ
);
CREATE INDEX document_proposals_channel_idx ON document_proposals(channel_id, status);

CREATE TABLE consistency_checks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    chat_window_id UUID REFERENCES chat_windows(id) ON DELETE SET NULL,
    user_id        UUID NOT NULL REFERENCES users(id),
    character_id   UUID REFERENCES characters(id) ON DELETE SET NULL,
    draft          TEXT NOT NULL,
    score          INTEGER,                                -- NULL when evidence insufficient
    insufficient_evidence BOOLEAN NOT NULL DEFAULT false,
    rationale      TEXT NOT NULL DEFAULT '',
    conflicts      JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence       JSONB NOT NULL DEFAULT '[]'::jsonb,
    recommended_entry_ids UUID[] NOT NULL DEFAULT '{}',
    llm_mode       TEXT NOT NULL DEFAULT 'mock',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consistency_checks_channel_idx ON consistency_checks(channel_id, created_at DESC);

CREATE TABLE inspiration_drafts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    chat_window_id UUID REFERENCES chat_windows(id) ON DELETE SET NULL,
    user_id        UUID NOT NULL REFERENCES users(id),
    character_id   UUID REFERENCES characters(id) ON DELETE SET NULL,
    hint           TEXT NOT NULL DEFAULT '',
    draft          TEXT NOT NULL,
    used_fact_ids  UUID[] NOT NULL DEFAULT '{}',
    llm_mode       TEXT NOT NULL DEFAULT 'mock',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
