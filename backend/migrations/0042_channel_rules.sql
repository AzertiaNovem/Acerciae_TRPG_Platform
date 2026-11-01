-- Rules are a channel's own: the GM picks the rule system (BRP-based Call of Cthulhu 7e, or D&D 2024 from SRD 5.2)
-- and whether role cards follow point buy. Point buy was a server feature; each channel starts with its server's value.
ALTER TABLE channels ADD COLUMN point_buy BOOLEAN NOT NULL DEFAULT false;
UPDATE channels c SET point_buy = ss.feature_coc7_points FROM server_settings ss WHERE ss.server_id = c.server_id;
UPDATE channels SET rule_system = 'coc7e' WHERE rule_system NOT IN ('coc7e', 'dnd2024');
ALTER TABLE channels ADD CONSTRAINT channels_rule_system_check CHECK (rule_system IN ('coc7e', 'dnd2024'));

-- Initiative (D&D): one order per chat window; the GM moves the turn and clears it.
CREATE TABLE initiative_entries (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    chat_window_id UUID NOT NULL REFERENCES chat_windows(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    total          INT NOT NULL,
    tiebreak       INT NOT NULL DEFAULT 0,          -- the DEX modifier: higher goes first on equal totals
    character_id   UUID REFERENCES characters(id) ON DELETE SET NULL,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chat_window_id, name)
);
CREATE INDEX initiative_entries_window ON initiative_entries (chat_window_id);
ALTER TABLE chat_windows ADD COLUMN initiative_turn UUID REFERENCES initiative_entries(id) ON DELETE SET NULL,
                         ADD COLUMN initiative_round INT NOT NULL DEFAULT 0;

-- Module import (D&D adventures): creatures with their stat blocks (in data.stat_block).
ALTER TABLE module_nodes DROP CONSTRAINT IF EXISTS module_nodes_node_type_check;
ALTER TABLE module_nodes ADD CONSTRAINT module_nodes_node_type_check
    CHECK (node_type IN ('npc','creature','location','item','clue','secret','stage','scene','condition','twist','ending'));
