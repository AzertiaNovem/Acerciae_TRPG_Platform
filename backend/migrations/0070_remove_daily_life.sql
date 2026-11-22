-- Daily life (the story running while players are absent) was removed: no more stand-in lines or passive presence.
-- Old stand-in lines stay as ordinary lines of the GM account. Not reversible without re-adding both columns (0065).
ALTER TABLE messages DROP COLUMN stand_in;
ALTER TABLE characters DROP COLUMN passive_since;
UPDATE events SET payload = payload - 'stand_in' WHERE payload ? 'stand_in';
UPDATE log_events SET metadata = metadata - 'stand_in' WHERE metadata ? 'stand_in';
