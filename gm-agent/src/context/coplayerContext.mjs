// What a co-player may know: only the chat log its own character could have witnessed. Nothing else reaches a
// co-player's model: no documents, reminders, board, script knowledge, highlights or other platform AI tips.
//
// The client signs in as the Keeper, and the Keeper's API view includes every line. So the filter is applied here,
// the same way the platform filters for a player (backend knowledge/Visibility):
//   * only windows the co-player sits in;
//   * `window` lines, plus `whisper` lines addressed to the co-player's own character;
//   * never `gm_only` lines (Keeper notes, hidden roll results) and never whispers to anyone else.

export function visibleToCoplayer(coplayer, message) {
  if (!message || !coplayer.windows.includes(message.chat_window_id)) return false;
  if (message.visibility === "window") return true;
  if (message.visibility === "whisper") return (message.whisper_to ?? []).includes(coplayer.characterId);
  return false;
}

export function speakerOf(m) {
  if (m.character_name) return m.character_name;
  if (m.author_role === "gm") return "Keeper";
  return m.author_name || "someone";
}

export function renderLine(m, { markVisibility = false } = {}) {
  const text = m.kind === "roll" && m.dice?.text ? `${m.content} → ${m.dice.text}` : m.content;
  const who = m.kind === "narration" ? `${m.character_name ? m.character_name : "Keeper"} (narration)` : speakerOf(m);
  const tag = m.kind === "ooc" ? " (out of character)" : "";
  let vis = "";
  if (markVisibility && m.visibility === "gm_only") vis = " [Keeper only]";
  if (markVisibility && m.visibility === "whisper") vis = ` [whisper to ${(m.whisper_to_names ?? m.whisper_to ?? []).join(", ")}]`;
  return `#${m.seq} ${who}${tag}${vis}: ${String(text).replace(/\s+/g, " ").trim()}`;
}

// The co-player's whole context: its own lines and everyone else's, oldest first, limited to the newest `limit`.
export function coplayerLog(coplayer, messages, limit = 60) {
  return messages
    .filter((m) => visibleToCoplayer(coplayer, m))
    .sort((a, b) => a.seq - b.seq)
    .slice(-limit);
}
