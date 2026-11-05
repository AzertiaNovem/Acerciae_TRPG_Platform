-- A fork is a new audience and a bounded view of old messages, never a copy of them.
ALTER TABLE chat_windows ADD COLUMN fork_parent_id uuid REFERENCES chat_windows(id) ON DELETE CASCADE;
ALTER TABLE chat_windows ADD COLUMN fork_seq bigint;
ALTER TABLE chat_windows ADD COLUMN archived_at timestamptz;
ALTER TABLE chat_windows ADD COLUMN fork_request_id text;
ALTER TABLE chat_windows ADD COLUMN fork_request_fingerprint text;
ALTER TABLE chat_windows ADD CONSTRAINT window_fork_boundary CHECK
  ((fork_parent_id IS NULL AND fork_seq IS NULL) OR (fork_parent_id IS NOT NULL AND fork_seq >= 0 AND fork_parent_id <> id AND kind <> 'main'));
CREATE INDEX chat_windows_parent ON chat_windows(fork_parent_id) WHERE fork_parent_id IS NOT NULL;
CREATE UNIQUE INDEX chat_windows_fork_request ON chat_windows(channel_id, created_by, fork_request_id) WHERE fork_request_id IS NOT NULL;

-- Joining an ongoing scene grants future messages, not the other party's private past.
-- Existing memberships retain their original access; group members still share the union.
ALTER TABLE chat_window_members ADD COLUMN history_after_seq bigint NOT NULL DEFAULT 0 CHECK (history_after_seq >= 0);
ALTER TABLE chat_window_members ADD COLUMN visibility_paused boolean NOT NULL DEFAULT false;
CREATE TABLE chat_window_member_periods (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_window_id uuid NOT NULL,
  user_id uuid NOT NULL,
  after_seq bigint NOT NULL DEFAULT 0,
  through_seq bigint,
  FOREIGN KEY(chat_window_id,user_id) REFERENCES chat_window_members(chat_window_id,user_id) ON DELETE CASCADE,
  CHECK (after_seq >= 0 AND (through_seq IS NULL OR through_seq >= after_seq))
);
CREATE INDEX window_member_period_lookup ON chat_window_member_periods(chat_window_id,user_id,after_seq);
CREATE UNIQUE INDEX window_member_open_period ON chat_window_member_periods(chat_window_id,user_id) WHERE through_seq IS NULL;
INSERT INTO chat_window_member_periods(chat_window_id,user_id) SELECT chat_window_id,user_id FROM chat_window_members;
CREATE FUNCTION open_window_member_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chat_window_member_periods(chat_window_id,user_id,after_seq) VALUES(NEW.chat_window_id,NEW.user_id,NEW.history_after_seq);
  RETURN NEW;
END $$;
CREATE TRIGGER window_member_period AFTER INSERT ON chat_window_members FOR EACH ROW EXECUTE FUNCTION open_window_member_period();
CREATE OR REPLACE VIEW player_group_readable_messages AS
SELECT DISTINCT pg.id AS group_id, m.id AS message_id
FROM player_groups pg JOIN player_group_members pm ON pm.group_id=pg.id
JOIN channel_members cm ON cm.channel_id=pm.channel_id AND cm.user_id=pm.user_id AND cm.role='player'
JOIN chat_window_members wm ON wm.user_id=pm.user_id
JOIN messages m ON m.chat_window_id=wm.chat_window_id AND m.channel_id=pg.channel_id
WHERE EXISTS(SELECT 1 FROM chat_window_member_periods p WHERE p.chat_window_id=wm.chat_window_id AND p.user_id=wm.user_id AND m.seq>p.after_seq AND (p.through_seq IS NULL OR m.seq<=p.through_seq))
AND (m.visibility='window' OR (m.visibility='whisper' AND EXISTS
  (SELECT 1 FROM characters c WHERE c.channel_id=pg.channel_id AND c.user_id=pm.user_id AND c.kind='pc' AND c.id=ANY(m.whisper_to))));
-- Pausing/resuming changes only future access; it must not erase accumulated player memory.
DROP TRIGGER player_chat_access_changed ON chat_window_members;
CREATE TRIGGER player_chat_access_changed AFTER INSERT OR DELETE OR UPDATE OF character_id,user_id,chat_window_id ON chat_window_members
 FOR EACH ROW EXECUTE FUNCTION player_chat_access_changed();
