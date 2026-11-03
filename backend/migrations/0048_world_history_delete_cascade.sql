-- Keep partition validation compatible with bulk entity deletion and player-memory resets.
CREATE OR REPLACE FUNCTION enforce_world_partition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eg UUID; ec UUID; lg UUID; lc UUID;
BEGIN
 IF TG_TABLE_NAME='entity_state_history' THEN
   SELECT player_group_id,channel_id INTO eg,ec FROM entities WHERE id=NEW.entity_id;
   -- Deleting an entity set can queue SET NULL for a history location before CASCADE deletes the history itself.
   -- Its owner is already absent in that statement's snapshot. Let the entity_id foreign key handle this row:
   -- CASCADE removes it, while an INSERT/UPDATE pointing to a genuinely missing owner still fails the FK check.
   IF NOT FOUND THEN RETURN NEW; END IF;
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
