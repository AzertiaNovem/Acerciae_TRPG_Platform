-- 0067_hypertext: interactive messages (kind 'hypertext', shown as "Interactive message"). A channel's GMs post them
-- through the API: declarative controls plus an optional script that runs on each viewer's device (docs/HYPERTEXT.md).
-- `messages.hypertext` is the public document. The sender's reply templates stay in hypertext_cards, which no message
-- query joins; each viewer's state stays in hypertext_states, readable only by its owner. A line a card produces names
-- the card and the person who acted (via_*); with an interaction id its origin is unique, so a retried action never
-- posts twice. Everything cascades from messages, channels and users.
-- The constraints on messages are added NOT VALID and validated below, but Db::runMigrations applies every pending file
-- in one transaction, so the ACCESS EXCLUSIVE lock the ALTERs take is held through the validation scans and the index
-- builds until it commits: the split does not shorten that lock. The deploy stops the service before it migrates
-- (scripts/deploy/deploy.py), so no request waits on it; any other session touching messages meanwhile does.
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;   -- the inline CHECK of 0002_events_scenes.sql
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('ic','ooc','narration','roll','system','hypertext')) NOT VALID;
ALTER TABLE messages ADD COLUMN hypertext JSONB;              -- the public document; never reply texts
ALTER TABLE messages ADD COLUMN via_hypertext_id UUID;        -- the card that produced this line
ALTER TABLE messages ADD COLUMN via_user_id UUID;             -- who acted on it
ALTER TABLE messages ADD COLUMN via_interaction_id UUID;      -- the action (NULL on a hidden roll's notice)
ALTER TABLE messages ADD COLUMN via_effect SMALLINT;          -- 0: said as the clicker, 1: replied as the sender
ALTER TABLE messages ADD CONSTRAINT messages_via_hypertext_id_fkey FOREIGN KEY (via_hypertext_id) REFERENCES messages(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE messages ADD CONSTRAINT messages_via_user_id_fkey FOREIGN KEY (via_user_id) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE messages ADD CONSTRAINT messages_via_effect_check CHECK (via_effect IN (0,1)) NOT VALID;
-- A document only on that kind, and always there until the card is recalled.
ALTER TABLE messages ADD CONSTRAINT messages_hypertext_shape CHECK ((hypertext IS NULL OR kind='hypertext') AND (kind<>'hypertext' OR hypertext IS NOT NULL OR recalled_at IS NOT NULL)) NOT VALID;
ALTER TABLE messages ADD CONSTRAINT messages_hypertext_size CHECK (hypertext IS NULL OR octet_length(hypertext::text) <= 65536) NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_kind_check;
ALTER TABLE messages VALIDATE CONSTRAINT messages_via_hypertext_id_fkey;
ALTER TABLE messages VALIDATE CONSTRAINT messages_via_user_id_fkey;
ALTER TABLE messages VALIDATE CONSTRAINT messages_via_effect_check;
ALTER TABLE messages VALIDATE CONSTRAINT messages_hypertext_shape;
ALTER TABLE messages VALIDATE CONSTRAINT messages_hypertext_size;
CREATE UNIQUE INDEX messages_via_origin_uniq ON messages(via_hypertext_id, via_user_id, via_interaction_id, via_effect) WHERE via_interaction_id IS NOT NULL;
CREATE INDEX messages_via_hypertext_idx ON messages(via_hypertext_id) WHERE via_hypertext_id IS NOT NULL;
CREATE INDEX messages_hypertext_author_idx ON messages(channel_id, author_id, created_at) WHERE kind='hypertext';   -- posts per author per minute

-- Server-only side of a card: the sender's private reply templates
-- ({id: {text, kind, character_id, audience, slots, allow_dice, per_viewer, total, group}}) and whether it is closed.
-- A posted card never changes; closing is recorded here.
CREATE TABLE hypertext_cards (
    message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    replies    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(replies::text) <= 65536),
    closes_at  TIMESTAMPTZ NOT NULL,
    closed_at  TIMESTAMPTZ,
    closed_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

-- One row per action a viewer takes on a card: idempotency (the same interaction id replays its result), the limits
-- (runs per viewer, per-minute rates, reply per_viewer/total/group) and a lease while its effects are being posted.
-- `failed` rows (the first effect failed) free runs and reply limits but still count towards the rates.
CREATE TABLE hypertext_interactions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id     UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interaction_id UUID NOT NULL,
    node_id        TEXT NOT NULL DEFAULT '',                  -- from the client: diagnostics only
    request        JSONB NOT NULL,                            -- the normalized effects, state and base version
    request_hash   TEXT NOT NULL,
    reply_id       TEXT,
    reply_group    TEXT,
    reply_ok       BOOLEAN,                                   -- NULL while pending or without a reply; false when it failed
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
    lease_until    TIMESTAMPTZ,                               -- a pending row's claim; another request may take it over after
    result_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,        -- ids of the lines posted, never their rows
    error          JSONB,                                     -- {error, message} of a failed or partial action
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, user_id, interaction_id)
);
CREATE INDEX hypertext_interactions_rate ON hypertext_interactions(channel_id, user_id, created_at);
CREATE INDEX hypertext_interactions_reply ON hypertext_interactions(message_id, reply_id);
CREATE INDEX hypertext_interactions_pending ON hypertext_interactions(lease_until) WHERE status='pending';

-- Each viewer's own state of a card (checkboxes, choices, drafts), readable only by that viewer through any route.
CREATE TABLE hypertext_states (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state      JSONB NOT NULL CHECK (octet_length(state::text) <= 16384),
    version    INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);
