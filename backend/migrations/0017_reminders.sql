-- Reminder bubbles: what a player group (or, later, the Keeper) most likely forgot or needs right now.
-- A reminder's text is the model's short note, but its evidence is the chat log: every reminder is anchored
-- to verbatim quotes from lines the group can read, and readers re-check message access when they open it.
CREATE TABLE reminders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    player_group_id UUID REFERENCES player_groups(id) ON DELETE CASCADE,     -- NULL = Keeper
    scene_id        UUID REFERENCES scenes(id) ON DELETE SET NULL,            -- scenario it was raised in
    kind            TEXT NOT NULL CHECK (kind IN ('forgotten','needed','plan','note')),
    title           TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    why             TEXT NOT NULL DEFAULT '',
    citations       JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{event_id, message_id, chat_window_id, scene_id, quotes:[verbatim substrings]}]
    source_event_ids UUID[] NOT NULL DEFAULT '{}',
    priority        INTEGER NOT NULL DEFAULT 2,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dismissed','expired')),
    dedupe_key      TEXT NOT NULL,
    ai_job_id       UUID,
    llm_mode        TEXT NOT NULL DEFAULT 'mock',
    player_group_version INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '3 days'
);
CREATE UNIQUE INDEX reminders_dedupe ON reminders(channel_id, coalesce(player_group_id, '00000000-0000-0000-0000-000000000000'::uuid), dedupe_key) WHERE status='active';
CREATE INDEX reminders_list_idx ON reminders(channel_id, player_group_id, status, created_at DESC);
CREATE TABLE reminder_dismissals (
    reminder_id UUID NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (reminder_id, user_id)
);

-- The players' story index: one outline per scenario, written from the group's readable chat only.
-- It is part of the hidden knowledge prelude for the model and is never shown to users.
CREATE TABLE player_scenario_outlines (
    group_id         UUID NOT NULL REFERENCES player_groups(id) ON DELETE CASCADE,
    scene_id         UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    outline          TEXT NOT NULL,
    key_points       JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_event_ids UUID[] NOT NULL DEFAULT '{}',
    through_seq      BIGINT NOT NULL DEFAULT 0,
    group_version    INTEGER NOT NULL DEFAULT 0,
    llm_mode         TEXT NOT NULL DEFAULT 'mock',
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, scene_id)
);

-- A group's derived memory now also includes its reminders and outlines.
CREATE OR REPLACE FUNCTION reset_player_memory(gid UUID) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE player_groups SET version=version+1, updated_at=now() WHERE id=gid;
  IF NOT FOUND THEN RETURN; END IF;
  DELETE FROM knowledge_facts WHERE player_group_id=gid;
  DELETE FROM entities WHERE player_group_id=gid;
  DELETE FROM documents WHERE player_group_id=gid;
  DELETE FROM reminders WHERE player_group_id=gid;
  DELETE FROM player_scenario_outlines WHERE group_id=gid;
  INSERT INTO documents(channel_id,player_group_id,doc_type,title,gm_only)
  SELECT g.channel_id,g.id,t.kind,t.title,false FROM player_groups g CROSS JOIN
   (VALUES ('current_scene','Current Scene'),('clue_journal','Clue Journal'),('relationships','Relationship Journal'),
           ('open_threads','Open Threads'),('timeline','Timeline')) t(kind,title) WHERE g.id=gid;
END $$;
