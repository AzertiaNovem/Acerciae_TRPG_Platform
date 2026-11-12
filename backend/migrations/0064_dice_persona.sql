-- 0064_dice_persona: the dice speak as a persona. A text group carries the dice's nickname and avatar, and any reply
-- text may hold several templates (a JSON array) of which one is picked at random. Each reader chooses whether a roll's
-- result shows as a separate message from the dice (default) or under the command, as before.
ALTER TABLE dice_text_groups ADD COLUMN dice_name TEXT NOT NULL DEFAULT '';
ALTER TABLE dice_text_groups ADD COLUMN avatar_data TEXT;      -- base64, at most 128 KiB decoded
ALTER TABLE dice_text_groups ADD COLUMN avatar_mime TEXT;
ALTER TABLE dice_text_groups ADD COLUMN avatar_version INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN dice_display TEXT NOT NULL DEFAULT 'separate' CHECK (dice_display IN ('separate', 'inline'));
