-- KP and each player group own independent memories. Never copy legacy AI output to players.
CREATE TABLE player_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(id, channel_id)
);
CREATE TABLE player_group_members (
    group_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    user_id UUID NOT NULL,
    PRIMARY KEY(channel_id, user_id),
    FOREIGN KEY(group_id, channel_id) REFERENCES player_groups(id, channel_id) ON DELETE CASCADE,
    FOREIGN KEY(channel_id, user_id) REFERENCES channel_members(channel_id, user_id) ON DELETE CASCADE
);
CREATE INDEX player_group_members_group ON player_group_members(group_id);
CREATE INDEX events_message_reference ON events(message_id) WHERE message_id IS NOT NULL;
ALTER TABLE documents ADD COLUMN player_group_id UUID REFERENCES player_groups(id) ON DELETE CASCADE;
ALTER TABLE knowledge_facts ADD COLUMN player_group_id UUID REFERENCES player_groups(id) ON DELETE CASCADE;
ALTER TABLE entities ADD COLUMN player_group_id UUID REFERENCES player_groups(id) ON DELETE CASCADE;
ALTER TABLE documents ADD CONSTRAINT documents_group_channel FOREIGN KEY(player_group_id,channel_id) REFERENCES player_groups(id,channel_id) ON DELETE CASCADE;
ALTER TABLE knowledge_facts ADD CONSTRAINT facts_group_channel FOREIGN KEY(player_group_id,channel_id) REFERENCES player_groups(id,channel_id) ON DELETE CASCADE;
ALTER TABLE entities ADD CONSTRAINT entities_group_channel FOREIGN KEY(player_group_id,channel_id) REFERENCES player_groups(id,channel_id) ON DELETE CASCADE;
ALTER TABLE documents DROP CONSTRAINT documents_channel_id_doc_type_key;
CREATE UNIQUE INDEX documents_kp_type ON documents(channel_id, doc_type) WHERE player_group_id IS NULL;
CREATE UNIQUE INDEX documents_group_type ON documents(player_group_id, doc_type) WHERE player_group_id IS NOT NULL;
ALTER TABLE entities DROP CONSTRAINT entities_channel_id_kind_name_key;
CREATE UNIQUE INDEX entities_kp_name ON entities(channel_id, kind, name) WHERE player_group_id IS NULL;
CREATE UNIQUE INDEX entities_group_name ON entities(player_group_id, kind, name) WHERE player_group_id IS NOT NULL;
CREATE INDEX facts_player_group ON knowledge_facts(player_group_id, kind);
-- Historical documents/revisions retain their IDs and content, exclusively in KP's partition.
UPDATE documents SET gm_only=true;
ALTER TABLE documents ADD CONSTRAINT document_partition_scope CHECK (gm_only = (player_group_id IS NULL));
-- Legacy audience mappings remain as historical metadata; partition checks supersede them.
UPDATE document_proposals SET status='rejected', rejection_reason='Retired: knowledge must be learned from chat', decided_at=now()
 WHERE status='needs_gm_review' AND ops->0->>'op'='share_knowledge';

-- Union of group members' actual readable chat. Never administrative events or module metadata.
CREATE VIEW player_group_readable_messages AS
SELECT DISTINCT pg.id AS group_id, m.id AS message_id
FROM player_groups pg JOIN player_group_members pm ON pm.group_id=pg.id
JOIN channel_members cm ON cm.channel_id=pm.channel_id AND cm.user_id=pm.user_id AND cm.role='player'
JOIN chat_window_members wm ON wm.user_id=pm.user_id
JOIN messages m ON m.chat_window_id=wm.chat_window_id AND m.channel_id=pg.channel_id
WHERE m.visibility='window' OR (m.visibility='whisper' AND EXISTS
   (SELECT 1 FROM characters c WHERE c.channel_id=pg.channel_id AND c.user_id=pm.user_id AND c.kind='pc' AND c.id=ANY(m.whisper_to)));
CREATE VIEW player_group_chat_events AS
SELECT rm.group_id,e.id AS event_id FROM player_group_readable_messages rm
JOIN events e ON e.message_id=rm.message_id WHERE e.kind='message.posted' AND e.visibility<>'gm_only';

CREATE FUNCTION reset_player_memory(gid UUID) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Version invalidates in-flight model output and retrieval contexts.
  UPDATE player_groups SET version=version+1, updated_at=now() WHERE id=gid;
  IF NOT FOUND THEN RETURN; END IF;
  DELETE FROM knowledge_facts WHERE player_group_id=gid;
  DELETE FROM entities WHERE player_group_id=gid;
  DELETE FROM documents WHERE player_group_id=gid;
  INSERT INTO documents(channel_id,player_group_id,doc_type,title,gm_only)
  SELECT g.channel_id,g.id,t.kind,t.title,false FROM player_groups g CROSS JOIN
   (VALUES ('current_scene','Current Scene'),('clue_journal','Clue Journal'),('relationships','Relationship Journal'),
           ('open_threads','Open Threads'),('timeline','Timeline')) t(kind,title) WHERE g.id=gid;
END $$;
CREATE FUNCTION player_group_members_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN PERFORM reset_player_memory(OLD.group_id); END IF;
  IF TG_OP<>'DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM channel_members WHERE channel_id=NEW.channel_id AND user_id=NEW.user_id AND role='player') THEN
      RAISE EXCEPTION 'Only players may belong to a player group';
    END IF;
    IF TG_OP='INSERT' OR NEW.group_id<>OLD.group_id THEN PERFORM reset_player_memory(NEW.group_id); END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER player_group_members_changed AFTER INSERT OR UPDATE OR DELETE ON player_group_members
 FOR EACH ROW EXECUTE FUNCTION player_group_members_changed();
CREATE FUNCTION assign_default_player_group() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gid UUID; mode TEXT; label TEXT;
BEGIN
 IF NEW.role<>'player' THEN DELETE FROM player_group_members WHERE channel_id=NEW.channel_id AND user_id=NEW.user_id; RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM player_group_members WHERE channel_id=NEW.channel_id AND user_id=NEW.user_id) THEN RETURN NEW; END IF;
 -- Serialize default allocation for concurrent invitations.
 SELECT knowledge_mode INTO mode FROM channels WHERE id=NEW.channel_id FOR UPDATE;
 IF mode='public' THEN SELECT id INTO gid FROM player_groups WHERE channel_id=NEW.channel_id ORDER BY created_at LIMIT 1; END IF;
 IF gid IS NULL THEN
   SELECT display_name INTO label FROM users WHERE id=NEW.user_id;
   INSERT INTO player_groups(channel_id,name) VALUES(NEW.channel_id,CASE WHEN mode='public' THEN 'Players' ELSE left(label,90)||' group' END) RETURNING id INTO gid;
 END IF;
 INSERT INTO player_group_members(group_id,channel_id,user_id) VALUES(gid,NEW.channel_id,NEW.user_id);
 RETURN NEW;
END $$;
CREATE TRIGGER default_player_group AFTER INSERT OR UPDATE OF role ON channel_members
 FOR EACH ROW EXECUTE FUNCTION assign_default_player_group();
-- Invokes the same migration rule as future invitations: public -> one group; isolated -> per player.
UPDATE channel_members SET role=role WHERE role='player';

CREATE FUNCTION player_chat_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE uid UUID; wid UUID; gid UUID;
BEGIN
 IF TG_OP='DELETE' THEN uid=OLD.user_id; wid=OLD.chat_window_id; ELSE uid=NEW.user_id; wid=NEW.chat_window_id; END IF;
 FOR gid IN SELECT pm.group_id FROM player_group_members pm JOIN chat_windows w ON w.channel_id=pm.channel_id
   WHERE pm.user_id=uid AND w.id=wid LOOP PERFORM reset_player_memory(gid); END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER player_chat_access_changed AFTER INSERT OR UPDATE OR DELETE ON chat_window_members
 FOR EACH ROW EXECUTE FUNCTION player_chat_access_changed();

-- Prevent cross-partition references even if a future code path misses a filter.
CREATE FUNCTION enforce_memory_partition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fg UUID; dg UUID; fc UUID; dc UUID;
BEGIN
 IF TG_TABLE_NAME='document_entries' THEN
   SELECT player_group_id,channel_id INTO fg,fc FROM knowledge_facts WHERE id=NEW.fact_id;
   SELECT player_group_id,channel_id INTO dg,dc FROM documents WHERE id=NEW.document_id;
 ELSIF TG_TABLE_NAME='fact_entities' THEN
   SELECT player_group_id,channel_id INTO fg,fc FROM knowledge_facts WHERE id=NEW.fact_id;
   SELECT player_group_id,channel_id INTO dg,dc FROM entities WHERE id=NEW.entity_id;
 ELSE
   SELECT player_group_id,channel_id INTO fg,fc FROM entities WHERE id=NEW.from_entity_id;
   SELECT player_group_id,channel_id INTO dg,dc FROM entities WHERE id=NEW.to_entity_id;
 END IF;
 IF fg IS DISTINCT FROM dg OR fc IS DISTINCT FROM dc THEN RAISE EXCEPTION 'Cross-partition memory reference'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER memory_entry_partition BEFORE INSERT OR UPDATE ON document_entries FOR EACH ROW EXECUTE FUNCTION enforce_memory_partition();
CREATE TRIGGER memory_entity_partition BEFORE INSERT OR UPDATE ON fact_entities FOR EACH ROW EXECUTE FUNCTION enforce_memory_partition();
CREATE TRIGGER memory_relation_partition BEFORE INSERT OR UPDATE ON entity_relations FOR EACH ROW EXECUTE FUNCTION enforce_memory_partition();
