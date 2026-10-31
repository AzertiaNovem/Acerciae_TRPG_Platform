-- Visual-novel bundles are built in the background, stored for a limited time (the public R2 bucket when one is
-- configured) and deleted when they expire.
CREATE TABLE vn_bundle_jobs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id       UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    presentation_id  UUID NOT NULL REFERENCES log_presentations(id) ON DELETE CASCADE,
    requested_by     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ready','failed','expired')),
    progress         JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {files_done, files_total}
    object_key       TEXT,                                  -- NULL once expired and deleted
    file_name        TEXT NOT NULL DEFAULT 'visual-novel.zip',
    bytes            BIGINT,
    error            TEXT,
    expires_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ
);
CREATE INDEX vn_bundle_jobs_requester_idx ON vn_bundle_jobs(presentation_id, requested_by, created_at DESC);
CREATE INDEX vn_bundle_jobs_expiry_idx ON vn_bundle_jobs(expires_at) WHERE status = 'ready';
