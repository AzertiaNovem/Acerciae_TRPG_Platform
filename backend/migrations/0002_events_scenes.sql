-- 0002_events_scenes: scenes, messages, event store (single source of truth)
CREATE TABLE scenes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    location      TEXT NOT NULL DEFAULT '',
    narrative_time TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    summary       TEXT NOT NULL DEFAULT '',
    module_node_id UUID,                       -- link to module scene when it maps to one
    off_module    BOOLEAN NOT NULL DEFAULT false,
    sequence      INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at     TIMESTAMPTZ
);
CREATE INDEX scenes_channel_idx ON scenes(channel_id, sequence);

ALTER TABLE channels ADD CONSTRAINT channels_current_scene_fk
    FOREIGN KEY (current_scene_id) REFERENCES scenes(id) ON DELETE SET NULL;
ALTER TABLE chat_windows ADD CONSTRAINT chat_windows_scene_fk
    FOREIGN KEY (active_scene_id) REFERENCES scenes(id) ON DELETE SET NULL;

-- A window may span many scenes and a scene may span many windows.
CREATE TABLE chat_window_scenes (
    chat_window_id UUID NOT NULL REFERENCES chat_windows(id) ON DELETE CASCADE,
    scene_id       UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    entered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_window_id, scene_id)
);

-- visibility: 'window' (all window members), 'gm_only', 'whisper' (listed character ids only)
CREATE TABLE messages (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    chat_window_id UUID NOT NULL REFERENCES chat_windows(id) ON DELETE CASCADE,
    scene_id       UUID REFERENCES scenes(id) ON DELETE SET NULL,
    author_id      UUID NOT NULL REFERENCES users(id),
    author_role    TEXT NOT NULL CHECK (author_role IN ('gm','player')),
    character_id   UUID REFERENCES characters(id) ON DELETE SET NULL,
    kind           TEXT NOT NULL DEFAULT 'ic' CHECK (kind IN ('ic','ooc','narration','roll','system')),
    content        TEXT NOT NULL,
    visibility     TEXT NOT NULL DEFAULT 'window' CHECK (visibility IN ('window','gm_only','whisper')),
    whisper_to     UUID[] NOT NULL DEFAULT '{}',
    seq            BIGSERIAL NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at      TIMESTAMPTZ,
    search         TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX messages_window_seq_idx ON messages(chat_window_id, seq);
CREATE INDEX messages_channel_seq_idx ON messages(channel_id, seq);
CREATE INDEX messages_search_idx ON messages USING GIN(search);
CREATE INDEX messages_trgm_idx ON messages USING GIN(content gin_trgm_ops);

-- Event store. Every state change relevant to the narrative is an event.
-- seq is a channel-wide monotonically increasing order. The observer reads by seq.
CREATE TABLE events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    chat_window_id UUID REFERENCES chat_windows(id) ON DELETE CASCADE,
    scene_id       UUID REFERENCES scenes(id) ON DELETE SET NULL,
    message_id     UUID REFERENCES messages(id) ON DELETE CASCADE,
    actor_user_id  UUID REFERENCES users(id),
    actor_role     TEXT NOT NULL DEFAULT 'system' CHECK (actor_role IN ('gm','player','system','ai')),
    character_id   UUID REFERENCES characters(id) ON DELETE SET NULL,
    kind           TEXT NOT NULL,                 -- message.posted, scene.entered, gm.declared, document.corrected, ...
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
    visibility     TEXT NOT NULL DEFAULT 'window' CHECK (visibility IN ('window','gm_only','whisper','public')),
    audience       UUID[] NOT NULL DEFAULT '{}',  -- character ids who witnessed the event (knowledge scope)
    seq            BIGSERIAL NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_channel_seq_idx ON events(channel_id, seq);
CREATE INDEX events_window_idx ON events(chat_window_id, seq);
CREATE INDEX events_scene_idx ON events(scene_id);
CREATE INDEX events_payload_search_idx ON events USING GIN ((to_tsvector('english', coalesce(payload->>'content',''))));
