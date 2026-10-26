-- 0008: ownership of preview audio, generic studio notifications bookkeeping
ALTER TABLE tts_audio_assets ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tts_jobs ADD COLUMN IF NOT EXISTS voice_profile_id UUID REFERENCES voice_profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tts_audio_channel_idx ON tts_audio_assets(channel_id, created_at DESC);
