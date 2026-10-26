-- Freeze snapshot data as well as membership; old snapshots preserve their current materialized state.
ALTER TABLE log_snapshot_events ADD COLUMN frozen_event JSONB;
UPDATE log_snapshot_events se SET frozen_event = to_jsonb(e) || jsonb_build_object('event_id',e.id,'timestamp',extract(epoch from e.occurred_at)::bigint)
FROM log_events e WHERE e.id=se.log_event_id;
ALTER TABLE log_snapshot_events ALTER COLUMN frozen_event SET NOT NULL;
ALTER TABLE pdf_render_jobs ADD COLUMN render_payload JSONB NOT NULL DEFAULT '{}';
ALTER TABLE pdf_render_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE pdf_render_jobs ADD COLUMN lease_expires_at TIMESTAMPTZ;
ALTER TABLE published_logs ADD COLUMN frozen_content JSONB NOT NULL DEFAULT '{}';
ALTER TABLE asset_generation_jobs ADD COLUMN idempotency_key TEXT UNIQUE;
ALTER TABLE asset_generation_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 2;
ALTER TABLE asset_generation_jobs ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
