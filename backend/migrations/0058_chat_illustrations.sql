-- Illustrations in chat: a player or the GM describes a moment, picks characters as visual references, and the
-- image-generation job posts the picture into the chat window as an out-of-character line.
ALTER TABLE asset_generation_jobs DROP CONSTRAINT asset_generation_jobs_kind_check;
ALTER TABLE asset_generation_jobs ADD CONSTRAINT asset_generation_jobs_kind_check
    CHECK (kind IN ('background','standee','portrait','avatar','illustration'));
-- The picture a line shows. Served only to those who may read the line (GET .../messages/{id}/image).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL;
-- One illustration in flight per person and channel, and an hourly cap, are checked against these rows.
CREATE INDEX IF NOT EXISTS asset_generation_jobs_illustrations_idx ON asset_generation_jobs(channel_id, created_by, created_at) WHERE kind = 'illustration';
