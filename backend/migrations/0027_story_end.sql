-- The Keeper ends the story: from then on every member of the channel can read the whole story in the campaign log
-- (Keeper-only lines stay with the Keeper unless the Keeper reveals them too). Before the end, the Keeper decides
-- whether players may open the Log Studio at all.
ALTER TABLE channels
    ADD COLUMN story_status TEXT NOT NULL DEFAULT 'ongoing' CHECK (story_status IN ('ongoing', 'ended')),
    ADD COLUMN story_ended_at TIMESTAMPTZ,
    ADD COLUMN story_reveal_all BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN studio_player_access BOOLEAN NOT NULL DEFAULT true;

-- A scenario the Keeper prepared is not part of the played story until it is entered.
UPDATE log_events SET visibility_scope = 'gm'
 WHERE source_kind = 'channel_event' AND source_reference->>'channel_event_kind' = 'scene.created';
