-- Bots speak (bots/BotRuntime, bots/BotPacing). One row per bot and chat window it is in: how far it has read, the turn
-- it owes and why, and the lease of a turn in progress (so two backend instances never take the same turn). Every turn
-- is logged once per trigger (bot_turns), so an interrupted turn is never posted twice.
CREATE TABLE bot_window_state (
    bot_id          UUID NOT NULL REFERENCES server_bots(id) ON DELETE CASCADE,
    chat_window_id  UUID NOT NULL REFERENCES chat_windows(id) ON DELETE CASCADE,
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    cursor_seq      BIGINT NOT NULL DEFAULT 0,
    owed            TEXT CHECK (owed IN ('player', 'addressed', 'mention', 'called', 'adopt', 'unprompted')),
    owed_seq        BIGINT NOT NULL DEFAULT 0,
    owed_at         TIMESTAMPTZ,
    gm_seen         BOOLEAN NOT NULL DEFAULT false,
    last_line_at    TIMESTAMPTZ,
    chain           INT NOT NULL DEFAULT 0,
    last_turn_at    TIMESTAMPTZ,
    lease_until     TIMESTAMPTZ,
    lease_token     TEXT,
    failures        INT NOT NULL DEFAULT 0,
    retry_after     TIMESTAMPTZ,
    last_error      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (bot_id, chat_window_id)
);
CREATE INDEX bot_window_state_owed ON bot_window_state(bot_id) WHERE owed IS NOT NULL;

CREATE TABLE bot_turns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id          UUID NOT NULL REFERENCES server_bots(id) ON DELETE CASCADE,
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    chat_window_id  UUID NOT NULL REFERENCES chat_windows(id) ON DELETE CASCADE,
    trigger         TEXT NOT NULL,
    trigger_seq     BIGINT NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('table', 'self')),
    status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'posted', 'passed', 'discarded', 'failed')),
    action          TEXT NOT NULL DEFAULT '',
    message_ids     UUID[] NOT NULL DEFAULT '{}',
    error           TEXT NOT NULL DEFAULT '',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    UNIQUE (bot_id, chat_window_id, trigger, trigger_seq)
);
CREATE INDEX bot_turns_recent ON bot_turns(bot_id, started_at);

-- What the GM tells every bot at this table (the public world, the current situation); and, while a GM agent paces
-- the bots itself, until when the platform leaves their turns after players' lines to it.
ALTER TABLE channels ADD COLUMN bot_brief TEXT NOT NULL DEFAULT '' CHECK (octet_length(bot_brief) <= 12000);
ALTER TABLE channels ADD COLUMN bot_pacing_until TIMESTAMPTZ;
