-- Observer retries: a failing batch backs off exponentially and is skipped after a few attempts.
ALTER TABLE ai_processing_cursors
    ADD COLUMN failures INT NOT NULL DEFAULT 0,
    ADD COLUMN retry_after TIMESTAMPTZ,
    ADD COLUMN last_error TEXT;

-- A proposal being applied is claimed first, so two accepts cannot both apply it.
ALTER TABLE document_proposals DROP CONSTRAINT document_proposals_status_check;
ALTER TABLE document_proposals ADD CONSTRAINT document_proposals_status_check
    CHECK (status IN ('pending', 'committed', 'rejected', 'needs_gm_review', 'applying'));

-- Hot lookups that had no index.
CREATE INDEX IF NOT EXISTS asset_generation_jobs_queue_idx ON asset_generation_jobs(created_at) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS presentation_events_audio_idx ON presentation_events(audio_asset_id) WHERE audio_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS presentation_events_canonical_idx ON presentation_events(canonical_event_id);
CREATE INDEX IF NOT EXISTS log_events_source_event_idx ON log_events(project_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_channel_kind_seq_idx ON events(channel_id, seq) INCLUDE (kind, chat_window_id, scene_id);
