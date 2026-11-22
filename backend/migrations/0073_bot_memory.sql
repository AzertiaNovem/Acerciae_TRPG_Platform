-- What a bot remembers (bots/BotMemory, docs/BOTS.md), so players can keep it as a friend from table to table:
--   table          a channel's story as the bot saw it (window lines only), with the moment that struck it most;
--   table_private  what was whispered to its characters there: it never leaves that channel's table;
--   person         its notes on someone it played with;
--   note           what the server's maintainers want it to remember;
--   briefing       what a channel's GM tells this bot privately (it reads it at that table only).
CREATE TABLE bot_memories (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id           UUID NOT NULL REFERENCES server_bots(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('table', 'table_private', 'person', 'note', 'briefing')),
    channel_id       UUID REFERENCES channels(id) ON DELETE CASCADE,
    subject_user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
    text             TEXT NOT NULL DEFAULT '' CHECK (octet_length(text) <= 8000),
    highlight        TEXT NOT NULL DEFAULT '' CHECK (octet_length(highlight) <= 1000),
    source           TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'edited')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind IN ('table', 'table_private', 'briefing')) = (channel_id IS NOT NULL)),
    CHECK ((kind = 'person') = (subject_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX bot_memories_channel ON bot_memories(bot_id, kind, channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX bot_memories_person ON bot_memories(bot_id, subject_user_id) WHERE kind = 'person';
CREATE INDEX bot_memories_bot ON bot_memories(bot_id, updated_at DESC);

-- How far each window's lines are folded into the bot's memory, and whether to fold them soon (a scenario closed);
-- the memory work's own lease and back-off. heard/last_eval_at: human lines since the bot last asked itself whether
-- to join in on its own (outside the table), and when it did.
ALTER TABLE bot_window_state
    ADD COLUMN memory_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN memory_flush BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN memory_lease_until TIMESTAMPTZ,
    ADD COLUMN memory_lease_token TEXT,
    ADD COLUMN memory_failures INT NOT NULL DEFAULT 0,
    ADD COLUMN memory_retry_after TIMESTAMPTZ,
    ADD COLUMN heard INT NOT NULL DEFAULT 0,
    ADD COLUMN last_eval_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE bot_window_state SET memory_seq = cursor_seq;

-- The GM's switch for bots joining in on their own in this channel (outside the table).
ALTER TABLE channels ADD COLUMN bot_chatter_enabled BOOLEAN NOT NULL DEFAULT true;
