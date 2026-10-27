-- The character space: what a character looks like and who they are, kept on the character itself.
-- Avatar (chat), main portrait and per-subtitle portraits (IDLE, SAY, FIGHT, …) are media assets; the
-- COC7-styled role card is JSON (basic, characteristics, derived, skills, background, items, wealth) and
-- its numbers are mirrored into sheet.attrs for the dice. Every character is either in "uploaded" mode (the
-- actor supplies images) or "generated" mode (an appearance prompt plus the campaign's era drive image AI).
ALTER TABLE characters
    ADD COLUMN avatar_asset_id   UUID REFERENCES media_assets(id) ON DELETE SET NULL,
    ADD COLUMN portrait_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
    ADD COLUMN asset_mode        TEXT NOT NULL DEFAULT 'uploaded' CHECK (asset_mode IN ('uploaded','generated')),
    ADD COLUMN appearance_prompt TEXT NOT NULL DEFAULT '',
    ADD COLUMN bio               TEXT NOT NULL DEFAULT '',
    ADD COLUMN role_card         JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN updated_at        TIMESTAMPTZ NOT NULL DEFAULT now();
-- The time the campaign plays in; image generation takes it into account.
ALTER TABLE channels ADD COLUMN era TEXT NOT NULL DEFAULT '1920s';
-- Image jobs may now produce a character's portrait or avatar as well.
ALTER TABLE asset_generation_jobs DROP CONSTRAINT asset_generation_jobs_kind_check;
ALTER TABLE asset_generation_jobs ADD CONSTRAINT asset_generation_jobs_kind_check CHECK (kind IN ('background','standee','portrait','avatar'));
