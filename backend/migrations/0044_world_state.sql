-- The living world record: what is true about each entity NOW (alive/dead/missing, whereabouts, a short state),
-- kept per memory partition next to the chronicle. Every change is versioned and kept in entity_state_history.
ALTER TABLE entities
    ADD COLUMN state TEXT NOT NULL DEFAULT '',
    ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('active','inactive','missing','dead','destroyed','unknown')),
    ADD COLUMN location_entity_id UUID NULL REFERENCES entities(id) ON DELETE SET NULL,
    ADD COLUMN state_version INT NOT NULL DEFAULT 0,
    ADD COLUMN state_updated_at TIMESTAMPTZ NULL,
    ADD COLUMN state_source_event_ids UUID[] NOT NULL DEFAULT '{}',
    -- 'gm' when the Keeper set it (a gm.declared event or an accepted review); the AI cannot silently override it.
    ADD COLUMN state_by TEXT NULL CHECK (state_by IN ('ai','gm'));
CREATE INDEX entities_location_idx ON entities(location_entity_id) WHERE location_entity_id IS NOT NULL;

CREATE TABLE entity_state_history (
    id                 BIGSERIAL PRIMARY KEY,
    channel_id         UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    entity_id          UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    player_group_id    UUID NULL REFERENCES player_groups(id) ON DELETE CASCADE,
    version            INT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('active','inactive','missing','dead','destroyed','unknown')),
    state              TEXT NOT NULL DEFAULT '',
    location_entity_id UUID NULL REFERENCES entities(id) ON DELETE SET NULL,
    source_event_ids   UUID[] NOT NULL DEFAULT '{}',
    actor              TEXT NOT NULL CHECK (actor IN ('ai','gm')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (entity_id, version),
    FOREIGN KEY (player_group_id, channel_id) REFERENCES player_groups(id, channel_id) ON DELETE CASCADE
);
CREATE INDEX entity_state_history_partition_idx ON entity_state_history(channel_id, player_group_id, id DESC);

-- Same rule as 0013/0015: a whereabouts or history row never points across memory partitions.
CREATE FUNCTION enforce_world_partition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eg UUID; ec UUID; lg UUID; lc UUID;
BEGIN
 IF TG_TABLE_NAME='entity_state_history' THEN
   SELECT player_group_id,channel_id INTO eg,ec FROM entities WHERE id=NEW.entity_id;
   IF eg IS DISTINCT FROM NEW.player_group_id OR ec IS DISTINCT FROM NEW.channel_id THEN RAISE EXCEPTION 'Cross-partition world history'; END IF;
 ELSE
   eg=NEW.player_group_id; ec=NEW.channel_id;
 END IF;
 IF NEW.location_entity_id IS NOT NULL THEN
   SELECT player_group_id,channel_id INTO lg,lc FROM entities WHERE id=NEW.location_entity_id;
   IF lg IS DISTINCT FROM eg OR lc IS DISTINCT FROM ec THEN RAISE EXCEPTION 'Cross-partition entity location'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER world_location_partition BEFORE INSERT OR UPDATE OF location_entity_id, player_group_id, channel_id ON entities
 FOR EACH ROW EXECUTE FUNCTION enforce_world_partition();
CREATE TRIGGER world_history_partition BEFORE INSERT OR UPDATE ON entity_state_history
 FOR EACH ROW EXECUTE FUNCTION enforce_world_partition();
