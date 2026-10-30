-- The same planner creates and maintains reminders. Original chat citations are never rewritten.
ALTER TABLE reminders DROP CONSTRAINT reminders_status_check;
ALTER TABLE reminders ADD CONSTRAINT reminders_status_check CHECK (status IN ('active','deferred','resolved','dismissed','expired'));
ALTER TABLE reminders
    ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN reviewed_through_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN status_reason TEXT NOT NULL DEFAULT '',
    ADD COLUMN review_citations JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE reminder_revisions (
    id BIGSERIAL PRIMARY KEY,
    reminder_id UUID NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    action TEXT NOT NULL,
    before_state JSONB NOT NULL,
    after_state JSONB NOT NULL,
    citations JSONB NOT NULL DEFAULT '[]'::jsonb,
    ai_job_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(reminder_id, version)
);
CREATE INDEX reminders_review_idx ON reminders(channel_id, player_group_id, status, updated_at DESC);
