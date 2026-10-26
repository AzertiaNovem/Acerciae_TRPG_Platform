-- 0001_core: identity, servers, channels, chat windows, characters
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_tokens (
    token_hash  TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens(user_id);

CREATE TABLE servers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    owner_id    UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE server_members (
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, user_id)
);
CREATE INDEX server_members_user_idx ON server_members(user_id);

-- A channel is one campaign. knowledge_mode: 'public' (Mode A) or 'isolated' (Mode B)
CREATE TABLE channels (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id        UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    rule_system      TEXT NOT NULL DEFAULT 'coc7e',
    knowledge_mode   TEXT NOT NULL DEFAULT 'isolated' CHECK (knowledge_mode IN ('public','isolated')),
    current_scene_id UUID,
    ai_enabled       BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX channels_server_idx ON channels(server_id);

-- role: 'gm' or 'player'
CREATE TABLE channel_members (
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('gm','player')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_user_idx ON channel_members(user_id);

CREATE TABLE characters (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL for GM-controlled NPC sheets
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'pc' CHECK (kind IN ('pc','npc')),
    speaking_style TEXT NOT NULL DEFAULT '',
    sheet         JSONB NOT NULL DEFAULT '{}'::jsonb,   -- BRP/CoC stats, skills
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX characters_channel_idx ON characters(channel_id);
CREATE INDEX characters_user_idx ON characters(user_id);

CREATE TABLE chat_windows (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'group' CHECK (kind IN ('main','group','private')),
    active_scene_id UUID,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_windows_channel_idx ON chat_windows(channel_id);

CREATE TABLE chat_window_members (
    chat_window_id UUID NOT NULL REFERENCES chat_windows(id) ON DELETE CASCADE,
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_id   UUID REFERENCES characters(id) ON DELETE SET NULL,
    joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_window_id, user_id)
);
CREATE INDEX chat_window_members_user_idx ON chat_window_members(user_id);
