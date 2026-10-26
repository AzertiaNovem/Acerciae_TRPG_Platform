-- Recall replaces the consistency score and the drafted inspiration reply. A recall answers "what has already
-- been said about this?" from two pools the caller may read: verbatim chat messages and the chronicler's existing
-- records. The model only chooses and groups; it writes nothing. Old consistency_checks / inspiration_drafts rows
-- stay for history and are no longer written.
CREATE TABLE chat_recalls (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    chat_window_id UUID REFERENCES chat_windows(id) ON DELETE SET NULL,
    user_id        UUID NOT NULL REFERENCES users(id),
    character_id   UUID REFERENCES characters(id) ON DELETE SET NULL,
    mode           TEXT NOT NULL CHECK (mode IN ('hint','draft')),
    query          TEXT NOT NULL,
    query_source   TEXT NOT NULL DEFAULT 'hint' CHECK (query_source IN ('hint','draft','recent_chat')),
    topics         JSONB NOT NULL DEFAULT '[]'::jsonb,     -- [{label, message_ids, fact_ids}] (ids only; readers refetch)
    message_ids    UUID[] NOT NULL DEFAULT '{}',
    fact_ids       UUID[] NOT NULL DEFAULT '{}',
    llm_mode       TEXT NOT NULL DEFAULT 'mock',
    player_group_id UUID REFERENCES player_groups(id) ON DELETE SET NULL,
    player_group_version INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_recalls_channel_idx ON chat_recalls(channel_id, user_id, created_at DESC);
