-- Private chats with a bot (docs/BOTS.md): a hidden channel of kind 'bot_chat' holding one person (chat_user_id) and
-- one of the server's bots (chat_bot_id), with a single window. It is never listed, spectated or shown to admins, and
-- nobody else can be added to it. One chat per person and bot.
ALTER TABLE channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'campaign' CHECK (kind IN ('campaign', 'bot_chat'));
ALTER TABLE channels ADD COLUMN chat_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE channels ADD COLUMN chat_bot_id UUID REFERENCES server_bots(id) ON DELETE CASCADE;
ALTER TABLE channels ADD CONSTRAINT channels_bot_chat_pair CHECK ((kind = 'bot_chat') = (chat_user_id IS NOT NULL AND chat_bot_id IS NOT NULL));
CREATE UNIQUE INDEX channels_bot_chat_unique ON channels(chat_user_id, chat_bot_id) WHERE kind = 'bot_chat';
