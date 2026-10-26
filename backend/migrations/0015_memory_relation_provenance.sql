-- A relation's supporting fact must belong to the same channel and memory partition.
CREATE FUNCTION enforce_relation_fact_partition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eg UUID; fg UUID; ec UUID; fc UUID;
BEGIN
 IF NEW.fact_id IS NOT NULL THEN
   SELECT player_group_id,channel_id INTO eg,ec FROM entities WHERE id=NEW.from_entity_id;
   SELECT player_group_id,channel_id INTO fg,fc FROM knowledge_facts WHERE id=NEW.fact_id;
   IF eg IS DISTINCT FROM fg OR ec IS DISTINCT FROM fc THEN
     RAISE EXCEPTION 'Cross-partition relation provenance';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER memory_relation_fact_partition BEFORE INSERT OR UPDATE ON entity_relations
 FOR EACH ROW EXECUTE FUNCTION enforce_relation_fact_partition();
