ALTER TABLE server_settings ADD COLUMN feature_atmosphere BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN atmosphere_enabled BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE channel_atmosphere_state (
 channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
 last_review_seq BIGINT NOT NULL DEFAULT 0,
 next_review_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 next_generation_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_generation_seq BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE channel_atmospheres (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 scene_label TEXT NOT NULL, mood TEXT NOT NULL, reason TEXT NOT NULL,
 prompts JSONB NOT NULL, source_event_ids UUID[] NOT NULL,
 created_by UUID NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX channel_atmospheres_history ON channel_atmospheres(channel_id,created_at DESC);
CREATE TABLE channel_atmosphere_variants (
 atmosphere_id UUID NOT NULL REFERENCES channel_atmospheres(id) ON DELETE CASCADE,
 variant TEXT NOT NULL CHECK(variant IN ('day_landscape','night_landscape','day_portrait','night_portrait')),
 job_id UUID NOT NULL REFERENCES asset_generation_jobs(id) ON DELETE CASCADE,
 asset_version INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(atmosphere_id,variant)
);
