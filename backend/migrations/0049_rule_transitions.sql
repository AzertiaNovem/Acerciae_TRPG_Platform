-- Switching a channel's rule system keeps every character's story and rebuilds its numbers. The story part of a card
-- (basic information, background, items; the name, bio, speaking style, appearance and images live on the character
-- row) stays as it is. The number part of the old system (Call of Cthulhu: characteristics, derived values, skills,
-- career and skill points, wealth; D&D: the build in role_card.dnd) and the dice values in sheet.attrs move to a
-- read-only archive, the card gets the new system's blank numbers, and the character is flagged until they are rebuilt.
CREATE TABLE character_card_archives (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    rule_system  TEXT NOT NULL,                   -- the system these numbers belong to
    numbers      JSONB NOT NULL,                  -- the number part of role_card for that system
    attrs        JSONB NOT NULL DEFAULT '{}',     -- sheet.attrs as the dice knew them
    reason       TEXT NOT NULL DEFAULT 'rule_change' CHECK (reason IN ('rule_change', 'restore', 'legacy')),
    archived_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    archived_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX character_card_archives_character ON character_card_archives (character_id, archived_at DESC);
ALTER TABLE characters ADD COLUMN card_pending BOOLEAN NOT NULL DEFAULT false;   -- numbers still to rebuild for the channel's system

-- Channels that switched before this existed may still carry the old system's numbers next to the new ones. They are
-- archived the same way (reason 'legacy'; the dice values are left alone, as they may already mix both systems).
INSERT INTO character_card_archives (character_id, channel_id, rule_system, numbers, reason)
SELECT c.id, c.channel_id, 'coc7e',
       jsonb_strip_nulls(jsonb_build_object('characteristics', c.role_card->'characteristics', 'derived', c.role_card->'derived',
           'skills', c.role_card->'skills', 'career', c.role_card->'career', 'skill_points', c.role_card->'skill_points',
           'wealth', c.role_card->'wealth')),
       'legacy'
FROM characters c JOIN channels ch ON ch.id = c.channel_id
WHERE ch.rule_system = 'dnd2024' AND jsonb_typeof(c.role_card) = 'object'
  AND (coalesce(c.role_card->'characteristics', '{}') NOT IN ('{}'::jsonb, 'null'::jsonb)
       OR coalesce(c.role_card->'skills', '{}') NOT IN ('{}'::jsonb, 'null'::jsonb)
       OR coalesce(c.role_card->'skill_points', '{}') NOT IN ('{}'::jsonb, 'null'::jsonb)
       OR c.role_card ? 'career'
       OR (jsonb_typeof(c.role_card->'derived') = 'object' AND (c.role_card->'derived') - 'db' <> '{}'::jsonb)
       OR coalesce(c.role_card->'derived'->>'db', '') <> ''
       OR coalesce(c.role_card->'wealth'->>'cash', '') <> '' OR coalesce(c.role_card->'wealth'->>'assets', '') <> ''
       OR coalesce(c.role_card->'wealth'->>'spending_level', '') <> '');

INSERT INTO character_card_archives (character_id, channel_id, rule_system, numbers, reason)
SELECT c.id, c.channel_id, 'dnd2024', jsonb_build_object('dnd', c.role_card->'dnd'), 'legacy'
FROM characters c JOIN channels ch ON ch.id = c.channel_id
WHERE ch.rule_system = 'coc7e' AND jsonb_typeof(c.role_card->'dnd') = 'object'
  AND (coalesce(c.role_card->'dnd'->>'class', '') <> '' OR coalesce(c.role_card->'dnd'->>'species', '') <> ''
       OR coalesce(c.role_card->'dnd'->>'background', '') <> '' OR coalesce(c.role_card->'dnd'->>'subclass', '') <> ''
       OR coalesce(c.role_card->'dnd'->'base', '{}') NOT IN ('{}'::jsonb, 'null'::jsonb)
       OR coalesce(c.role_card->'dnd'->'skills', '{}') NOT IN ('{}'::jsonb, 'null'::jsonb)
       OR coalesce(c.role_card->'dnd'->>'features', '') <> '' OR coalesce(c.role_card->'dnd'->>'spells', '') <> ''
       OR coalesce(c.role_card->'dnd'->>'hp_max', '0') NOT IN ('0', ''));

-- Those characters are asked to rebuild unless their card already has the current system's numbers.
UPDATE characters c SET card_pending = true
FROM channels ch
WHERE ch.id = c.channel_id AND c.id IN (SELECT character_id FROM character_card_archives WHERE reason = 'legacy')
  AND ((ch.rule_system = 'dnd2024' AND coalesce(c.role_card->'dnd'->>'class', '') = '')
       OR (ch.rule_system = 'coc7e' AND coalesce(c.role_card->'characteristics', '{}') IN ('{}'::jsonb, 'null'::jsonb)));

-- The active card keeps only the current system's numbers.
UPDATE characters c SET role_card = c.role_card - 'characteristics' - 'derived' - 'skills' - 'career' - 'skill_points' - 'wealth'
FROM channels ch
WHERE ch.id = c.channel_id AND ch.rule_system = 'dnd2024' AND jsonb_typeof(c.role_card) = 'object'
  AND c.role_card ?| ARRAY['characteristics', 'derived', 'skills', 'career', 'skill_points', 'wealth'];
UPDATE characters c SET role_card = c.role_card - 'dnd'
FROM channels ch
WHERE ch.id = c.channel_id AND ch.rule_system = 'coc7e' AND jsonb_typeof(c.role_card) = 'object' AND c.role_card ? 'dnd';
