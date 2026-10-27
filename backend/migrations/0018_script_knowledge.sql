-- The Keeper's script knowledge: what the uploaded module says, read by the model before anything else.
-- Built from the structured module (nodes, edges, pages) as relationships, clues, foreshadowing, background
-- and, most importantly, the flow of the script. It lives in the Keeper's memory partition only and is never
-- reachable by a player group. During play the model may propose changes (a stage reached, a clue revealed,
-- a twist paid off); a second model reviews every proposal before it is applied. Keeper edits are final.
CREATE TABLE script_knowledge (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id       UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    module_id        UUID REFERENCES modules(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('relationship','clue','foreshadowing','background','flow')),
    title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    body             TEXT NOT NULL DEFAULT '',
    data             JSONB NOT NULL DEFAULT '{}'::jsonb,   -- relationship {from,to,relation}; foreshadowing {payoff}; flow {location, prerequisites[], keeper_actions[], leads_to[]}
    citations        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{page, excerpt}] from the module pages
    node_ids         UUID[] NOT NULL DEFAULT '{}',
    position         INTEGER NOT NULL DEFAULT 0,           -- flow order
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','done','skipped')),
    status_event_ids UUID[] NOT NULL DEFAULT '{}',         -- chat events that moved the status
    origin           TEXT NOT NULL DEFAULT 'script' CHECK (origin IN ('script','play','gm')),
    gm_edited        BOOLEAN NOT NULL DEFAULT false,
    llm_mode         TEXT NOT NULL DEFAULT 'mock',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    search           TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED
);
CREATE INDEX script_knowledge_channel_idx ON script_knowledge(channel_id, kind, position);
CREATE INDEX script_knowledge_search_idx ON script_knowledge USING GIN(search);

-- Every automatic change the first model proposed, the reviewer's verdict, and whether it was applied.
CREATE TABLE script_knowledge_changes (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id       UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    knowledge_id     UUID REFERENCES script_knowledge(id) ON DELETE SET NULL,
    op               TEXT NOT NULL CHECK (op IN ('add','update','status')),
    proposal         JSONB NOT NULL,
    evidence         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{event_id, text}] verified verbatim quotes
    source_event_ids UUID[] NOT NULL DEFAULT '{}',
    verdict          TEXT NOT NULL CHECK (verdict IN ('approved','rejected')),
    reviewer_reason  TEXT NOT NULL DEFAULT '',
    applied          BOOLEAN NOT NULL DEFAULT false,
    ai_job_id        UUID,
    llm_mode         TEXT NOT NULL DEFAULT 'mock',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX script_knowledge_changes_idx ON script_knowledge_changes(channel_id, created_at DESC);

-- The two cards pinned at the top of the Keeper's dock: what the script plans next, and the Keeper's notes.
CREATE TABLE kp_board (
    channel_id       UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    slot             TEXT NOT NULL CHECK (slot IN ('next','notes')),
    content          JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_event_ids UUID[] NOT NULL DEFAULT '{}',
    ai_job_id        UUID,
    llm_mode         TEXT NOT NULL DEFAULT 'mock',
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, slot)
);

-- Keeper reminders may point at the script as well as at the chat.
ALTER TABLE reminders ADD COLUMN script_refs JSONB NOT NULL DEFAULT '[]'::jsonb;   -- [{knowledge_id, kind, title, page, excerpt}]
