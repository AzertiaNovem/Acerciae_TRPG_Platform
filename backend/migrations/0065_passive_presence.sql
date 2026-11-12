-- Explicit AI stand-ins stay distinguishable from their player's own words.
ALTER TABLE messages ADD COLUMN stand_in BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE characters ADD COLUMN passive_since TIMESTAMPTZ;
