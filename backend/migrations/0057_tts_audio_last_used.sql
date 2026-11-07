-- When a cached voice line was last used (served from the cache, or played). The storage cleanup deletes a line no
-- visual-novel line and no live publication uses once it has gone unused for RETENTION_VOICE_AUDIO_DAYS. Existing
-- lines start their wait now.
ALTER TABLE tts_audio_assets ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS tts_audio_last_used_idx ON tts_audio_assets(last_used_at);
