-- Outfits: a generated character may change clothes. Each outfit is a named attire with its own avatar, main portrait
-- and poses (standees by subtitle), drawn with the character's base portrait as the face reference so the person stays
-- recognisable. The outfit a character wears now (characters.outfit_id; NULL = the base look) is what the chat shows,
-- and each line keeps the outfit it was written in (messages.outfit_id), so a visual novel shows every line in the
-- clothes worn at the time. An outfit's images carry its id (media_assets.outfit_id) so they never stand in for the
-- base look's.
CREATE TABLE character_outfits (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id        UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    character_id      UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    attire            TEXT NOT NULL DEFAULT '',
    avatar_asset_id   UUID REFERENCES media_assets(id) ON DELETE SET NULL,
    portrait_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
    expressions       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX character_outfits_name_idx ON character_outfits(character_id, lower(name));
CREATE INDEX character_outfits_channel_idx ON character_outfits(channel_id);
ALTER TABLE characters ADD COLUMN outfit_id UUID REFERENCES character_outfits(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN outfit_id UUID REFERENCES character_outfits(id) ON DELETE SET NULL;
ALTER TABLE media_assets ADD COLUMN outfit_id UUID REFERENCES character_outfits(id) ON DELETE SET NULL;
-- Deleting an outfit clears these references.
CREATE INDEX messages_outfit_idx ON messages(outfit_id) WHERE outfit_id IS NOT NULL;
CREATE INDEX media_assets_outfit_idx ON media_assets(outfit_id) WHERE outfit_id IS NOT NULL;
