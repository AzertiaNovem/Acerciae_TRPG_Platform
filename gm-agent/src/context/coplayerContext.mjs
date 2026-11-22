// What a co-player may read of the chat: only the lines its own character could have witnessed. Besides this log, a
// co-player gets its own card and its companions' profiles (profiles.mjs), never documents, reminders, board, script
// knowledge, highlights or other platform AI tips.
//
// The client signs in as the GM, and the GM's API view includes every line. So the filter is applied here,
// the same way the platform filters for a player (backend knowledge/Visibility):
//   * only windows the co-player sat in, and only lines posted while it sat there (its seats);
//   * `window` lines, plus `whisper` lines addressed to the co-player's own character;
//   * never `gm_only` lines (GM notes, hidden roll results) and never whispers to anyone else.

export function visibleToCoplayer(coplayer, message) {
  if (!message) return false;
  const present = coplayer.seats.some((s) => s.windowId === message.chat_window_id && message.seq >= s.fromSeq && (s.toSeq === null || message.seq <= s.toSeq));
  if (!present) return false;
  if (message.visibility === "window") return true;
  if (message.visibility === "whisper") return (message.whisper_to ?? []).includes(coplayer.characterId);
  return false;
}

// The co-player's whole context: its own lines and everyone else's, oldest first, limited to the newest `limit`.
export function coplayerLog(coplayer, messages, limit = 60) {
  return messages
    .filter((m) => visibleToCoplayer(coplayer, m))
    .sort((a, b) => a.seq - b.seq)
    .slice(-limit);
}
