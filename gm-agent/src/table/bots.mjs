// bots: table is the explicit runtime context supplied by Table; no service singleton.
//
// The platform's bots (docs/BOTS.md) are AI members of a server who play their own characters at this table, like
// players: their lines arrive as players' lines (`author_is_bot`), which the GM answers, but they are not people at
// the table (no presence, sessions, wishes or control commands). While this client runs the table it paces them:
// after a turn that answered a person and let the players' side act, the bots seated in that window are asked for
// their turn (`pace`, so the platform leaves the bots' turns after players' and GM lines to this client for a while);
// the GM's answer to their lines asks nothing more of them until a person speaks again.
// What every bot at the table is told each turn ("notes for bots") is the public world as this client knows it: the
// world's bible, the date and routine, the public worldbook entries that came up, the players' corrections.
import { describeCalendar, describeRoutine } from "../calendar.mjs";

const BRIEF_BYTES = 12000;
const BRIEF_EVERY_MS = 2 * 60000;
const PACE_EVERY_MS = 5 * 60000;   // the platform leaves the pacing to this client for ten minutes per call

// The characters in this window that a platform bot plays.
export function botsIn(table, windowId) {
  const bots = new Set(table.characters.filter((c) => c.player_is_bot).map((c) => c.id));
  if (!bots.size) return [];
  return [...new Set(table.presentPlayers(windowId))].filter((id) => bots.has(id));
}

// Tells the platform this client paces the channel's bots (it then gives them no turn of its own for players' or GM
// lines, and drops any it owed), at most every five minutes while a bot plays here; at once with `force`.
export async function paceBots(table, { force = false } = {}) {
  if (!table.characters.some((c) => c.player_is_bot)) return false;
  const now = table.now();
  if (!force && now - (table.botsPacedAt ?? -Infinity) < PACE_EVERY_MS) return false;
  const windowId = table.primaryWindowId?.() ?? table.windows[0]?.id;
  if (!windowId) return false;
  table.botsPacedAt = now;
  try { await table.api.botTurns(table.channelId, windowId, { pace: true, character_ids: [] }); return true; }
  catch (e) { table.log(`bots: ${e.message}`); return false; }
}

// Asks the bots seated in the window for their turn now, pacing them. An older platform, or bots switched off on the
// server, answer with an error: logged, and play goes on without them.
export async function callBots(table, windowId) {
  const ids = botsIn(table, windowId);
  if (!ids.length) return [];
  try {
    const { called = [] } = (await table.api.botTurns(table.channelId, windowId, { pace: true, character_ids: ids })) ?? {};
    table.botsPacedAt = table.now();
    if (called.length) table.log(`bots: asked ${called.map((b) => b.name).join(", ")} for their turn in "${table.windowName(windowId)}"`);
    return called;
  } catch (e) {
    table.log(`bots: ${e.message}`);
    return [];
  }
}

// The notes for bots: what every bot at this table may know of the world. "" when there is nothing to tell.
export function botBrief(table) {
  const parts = [];
  if (table.improv.on && String(table.improv.world ?? "").trim()) parts.push(`THE WORLD (the setting everyone at the table shares):\n${table.improv.world.trim()}`);
  if (table.calendarOn()) {
    const today = describeCalendar(table.calendar);
    const routine = describeRoutine(table.calendar);
    if (today) parts.push(`TODAY IN THE STORY: ${today}`);
    if (routine) parts.push(`${routine} (common knowledge: everyone in the story knows it)`);
  }
  // The public worldbook entries that came up in the lines everyone could read.
  const hidden = table.hiddenLines();
  const lines = table.windows.flatMap((w) => table.history.lines(w.id)).filter((m) => m.visibility === "window" && !hidden.has(m.id)).sort((a, b) => a.seq - b.seq).slice(-60);
  const lore = table.publicLore({ lines });
  if (lore) parts.push(lore);
  const corrections = (table.planner?.table ?? []).filter((n) => n.kind === "correction");
  if (corrections.length) parts.push(`TABLE CORRECTIONS (out of character, from the players: keep to them from now on):\n${corrections.map((n) => `- ${n.text}`).join("\n")}`);
  let text = parts.join("\n\n");
  while (Buffer.byteLength(text) > BRIEF_BYTES) text = text.slice(0, Math.floor(text.length * 0.9));
  return text;
}

// Sends the notes for bots when they changed, at most every two minutes (at once with `force`), and only while a bot
// plays a character here.
export async function syncBotBrief(table, { force = false } = {}) {
  if (!table.characters.some((c) => c.player_is_bot)) return false;
  const now = table.now();
  if (!force && now - (table.botBriefAt ?? 0) < BRIEF_EVERY_MS) return false;
  const text = botBrief(table);
  // Nothing to tell yet: the GM's own notes for bots stay as they are.
  if (text === (table.botBriefSent ?? "")) return false;
  table.botBriefAt = now;
  try {
    await table.api.setBotBrief(table.channelId, text);
    table.botBriefSent = text;
    return true;
  } catch (e) {
    table.log(`bots: notes for bots: ${e.message}`);
    return false;
  }
}
