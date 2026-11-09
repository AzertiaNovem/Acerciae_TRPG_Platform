-- Pinned lines: a member marks a chat line as important, and it joins their group's context bubbles (the GM's for the
-- GM) as a reminder of kind 'pinned': outside the model's maintenance, never expiring, until its pinner or the GM
-- unpins it. The reminder planner's private reading of where a group stands (its outlook: the situation, the likely
-- next move and what that move needs) is kept per group for the players' helpers; it is never shown as such.
ALTER TABLE reminders DROP CONSTRAINT reminders_kind_check;
ALTER TABLE reminders ADD CONSTRAINT reminders_kind_check CHECK (kind IN ('forgotten','needed','plan','note','pinned'));
ALTER TABLE reminders ADD COLUMN pinned_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE reminders ADD COLUMN pinned_message_id UUID REFERENCES messages(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX reminders_pinned_once ON reminders(channel_id, coalesce(player_group_id, '00000000-0000-0000-0000-000000000000'::uuid), pinned_message_id) WHERE kind='pinned' AND status='active';
CREATE TABLE group_outlooks (
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    player_group_id UUID REFERENCES player_groups(id) ON DELETE CASCADE,   -- NULL = the GM
    situation       TEXT NOT NULL DEFAULT '',
    next_move       TEXT NOT NULL DEFAULT '',
    needs           JSONB NOT NULL DEFAULT '[]'::jsonb,
    through_seq     BIGINT NOT NULL DEFAULT 0,
    llm_mode        TEXT NOT NULL DEFAULT 'mock',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX group_outlooks_key ON group_outlooks(channel_id, coalesce(player_group_id, '00000000-0000-0000-0000-000000000000'::uuid));
