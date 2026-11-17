// Co-player intentions: a standing aim the host's operator gives an AI co-player by hand in the Web UI, now and then
// ("win Mina's trust while keeping the guild together"). Nothing sets, advances or ends an intention automatically.
// Only that co-player reads it, as its own long-term aim; the GM, the planner, the other co-players and the stand-ins
// never do. It lives in `<channel>.intentions.json` in the state directory (operator-files.mjs), keyed by the
// co-player's character id, so a rename keeps it.
export const INTENTION_MAX = 1000;

const text = (v) => String(v ?? "").replace(/\r\n?/g, "\n").trim();
const ID = /^[A-Za-z0-9_-]{1,128}$/;

// Lenient: whatever the file holds, as {revision, intentions: {characterId: {text, at}}}.
export function intentionsState(raw) {
  const x = raw && typeof raw === "object" ? raw : {};
  const intentions = {};
  for (const [id, v] of Object.entries(x.intentions && typeof x.intentions === "object" ? x.intentions : {})) {
    const t = text(v?.text).slice(0, INTENTION_MAX);
    if (ID.test(id) && t) intentions[id] = { text: t, at: typeof v.at === "string" ? v.at : null };
  }
  return { revision: Number(x.revision) || 0, intentions };
}

// Strict, for an edit from the Web UI: {characterId: text} for the co-players changed; an empty text clears one.
// `coplayers` are the ids that may hold an intention. Returns the full map to write, starting from `current`.
export function applyIntentions(current, changes, { coplayers = [], now = new Date().toISOString() } = {}) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("intentions must be an object of co-player id to text");
  const out = { ...intentionsState(current).intentions };
  for (const [id, value] of Object.entries(changes)) {
    if (!coplayers.includes(id)) throw new Error(`${id} is not a co-player of this channel`);
    if (typeof value !== "string") throw new Error("an intention must be text");
    const t = text(value);
    if (t.length > INTENTION_MAX) throw new Error(`an intention is at most ${INTENTION_MAX} characters`);
    if (t) out[id] = { text: t, at: now }; else delete out[id];
  }
  return out;
}

// The co-player's own section (uncached: it may change between turns). "" without an intention.
export function renderIntention(t) {
  const s = text(t);
  return s ? `YOUR STANDING INTENTION (your own long-term aim, set for you by the table's host; keep it to yourself and pursue it in character, step by step, through your own choices when the moment allows. It never overrides how to play: never decide for a player character, never press someone passive, keep to the players' corrections):\n${s}` : "";
}
