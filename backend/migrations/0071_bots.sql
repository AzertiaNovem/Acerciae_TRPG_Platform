-- Bots: AI members a server's maintainers set up (name, speaking style, a persona for outside the table). Each bot is
-- a user row of its own (is_bot), so its lines are ordinary player lines; it never signs in. Members invite bots into
-- their channels; the GM can remove them and turn invitations off. Bots speak from a later migration on.
ALTER TABLE users ADD COLUMN is_bot BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE server_bots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id           UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    persona             TEXT NOT NULL DEFAULT '' CHECK (octet_length(persona) <= 8000),
    speaking_style      TEXT NOT NULL DEFAULT '' CHECK (octet_length(speaking_style) <= 1000),
    enabled             BOOLEAN NOT NULL DEFAULT true,
    -- Lines a bot may start on its own outside the table, per hour (0: only when spoken to).
    unprompted_per_hour INT NOT NULL DEFAULT 2 CHECK (unprompted_per_hour BETWEEN 0 AND 60),
    -- Every turn it takes, per hour: a ceiling on its model use.
    turns_per_hour      INT NOT NULL DEFAULT 60 CHECK (turns_per_hour BETWEEN 1 AND 600),
    -- Whether what it saw at one table may come up at another (false: each table's story stays with its players).
    share_tables        BOOLEAN NOT NULL DEFAULT false,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);
CREATE INDEX server_bots_server ON server_bots(server_id) WHERE deleted_at IS NULL;

ALTER TABLE server_settings ADD COLUMN feature_bots BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE server_settings ADD COLUMN bots_per_channel INT NOT NULL DEFAULT 3 CHECK (bots_per_channel BETWEEN 1 AND 8);
ALTER TABLE channels ADD COLUMN bot_invites_enabled BOOLEAN NOT NULL DEFAULT true;
-- Who brought a member in (bots: the member who invited it).
ALTER TABLE channel_members ADD COLUMN invited_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE server_ai_uses DROP CONSTRAINT server_ai_uses_use_check;
ALTER TABLE server_ai_uses ADD CONSTRAINT server_ai_uses_use_check
    CHECK (use IN ('text', 'text_chronicle', 'text_assist', 'text_writing', 'text_bots', 'embedding', 'image_generation', 'image_edit', 'tts'));

-- A bot never joins a player group: joining one rebuilds the group's shared memory, and a bot reads only what it
-- witnessed itself. Otherwise as 0013.
CREATE OR REPLACE FUNCTION assign_default_player_group() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gid UUID; mode TEXT; label TEXT;
BEGIN
 IF NEW.role<>'player' THEN DELETE FROM player_group_members WHERE channel_id=NEW.channel_id AND user_id=NEW.user_id; RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND is_bot) THEN RETURN NEW; END IF;
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
