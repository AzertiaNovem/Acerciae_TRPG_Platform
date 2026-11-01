-- A PC owned by a Keeper account (a "GM-cast" PC, such as an AI co-player) is voiced by the Keeper like an NPC, so it
-- is never the Keeper's identity in a window. Creating one used to bind it into every window the Keeper sat in, which
-- counted it as present in all of them; those bindings are cleared.
UPDATE chat_window_members wm SET character_id = NULL
FROM chat_windows w, channel_members cm, characters c
WHERE w.id = wm.chat_window_id AND cm.channel_id = w.channel_id AND cm.user_id = wm.user_id AND cm.role = 'gm'
  AND c.id = wm.character_id AND c.user_id = wm.user_id AND c.kind = 'pc';
