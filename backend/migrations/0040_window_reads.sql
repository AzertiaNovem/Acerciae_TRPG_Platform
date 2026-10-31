-- How far each user has read each chat window (the unread counters next to the windows). Everyone starts with what is
-- already there read, so the counters begin at zero.
CREATE TABLE chat_window_reads (
    chat_window_id UUID NOT NULL REFERENCES chat_windows(id) ON DELETE CASCADE,
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_seq  BIGINT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_window_id, user_id)
);
INSERT INTO chat_window_reads(chat_window_id, user_id, last_read_seq)
SELECT w.id, cm.user_id, coalesce((SELECT max(seq) FROM messages m WHERE m.chat_window_id = w.id), 0)
FROM chat_windows w JOIN channel_members cm ON cm.channel_id = w.channel_id
ON CONFLICT DO NOTHING;
