// The worldbook of an improvised campaign: the world is not one text that every prompt carries whole.
//   bible   – always in use: what everyone in the story knows (the world setting of earlier versions);
//   hidden  – the GM's always-present hidden layer (the secrets file of earlier versions);
//   entries – places, groups, people, customs, history: each read only when it is needed. An entry is in play in a
//             window when its title or one of its keys came up in that window's recent lines (or, for a co-player,
//             in what it witnessed), or when the GM opened it with the worldbook_read tool. A secret entry is the
//             GM's alone: the GM, the real NPCs and the planner read it, never a co-player or a stand-in.
// Nothing of it is posted in the chat. It lives in `<channel>.worldbook.json` in the state directory, edited in the
// host's Web UI (operator-files.mjs); the table keeps the bible and the hidden layer in its state as well, so every
// older reader of the world setting keeps working.
import { WORLD_MAX, SECRETS_MAX } from "./improv.mjs";
import { estimateTokens } from "./memory.mjs";

export const ENTRIES_MAX = 300, TITLE_MAX = 120, BODY_MAX = 6000, KEYS_MAX = 24, KEY_MAX = 80;
export const WORLDBOOK_DEFAULTS = Object.freeze({ gm_tokens: 3000, coplayer_tokens: 1200, recent_lines: 30 });

const text = (v, max) => String(v ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
const oneLine = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const ID = /^e[1-9]\d{0,5}$/;

function keysOf(v) {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/[,，、;；\n]/);
  return [...new Set(list.map((k) => oneLine(k, KEY_MAX)).filter(Boolean))].slice(0, KEYS_MAX);
}

// Lenient: whatever the file holds becomes a usable book (bad entries are left out, long texts are cut).
export function worldbookState(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const seen = new Set();
  const entries = [];
  for (const e of Array.isArray(b.entries) ? b.entries : []) {
    if (!e || typeof e !== "object" || !ID.test(String(e.id)) || seen.has(e.id)) continue;
    const title = oneLine(e.title, TITLE_MAX), body = text(e.body, BODY_MAX);
    if (!title || !body) continue;
    seen.add(e.id);
    entries.push({ id: e.id, title, keys: keysOf(e.keys), body, secret: e.secret === true, enabled: e.enabled !== false });
    if (entries.length >= ENTRIES_MAX) break;
  }
  const top = Math.max(0, ...entries.map((e) => Number(e.id.slice(1))));
  return {
    revision: Number(b.revision) || 0,
    bible: text(b.bible, WORLD_MAX),
    hidden: text(b.hidden, SECRETS_MAX),
    entries,
    nextId: Math.max(Number(b.nextId) || 1, top + 1),
    updatedAt: typeof b.updatedAt === "string" ? b.updatedAt : null,
  };
}

// Strict, for an edit from the Web UI: the whole book as the editor sends it. Entries without an id are new and get
// one. Returns the normalized book (without revision); throws with a message that names the problem.
export function validateWorldbook(input, { nextId = 1 } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("the worldbook must be an object");
  const raw = { bible: input.bible ?? "", hidden: input.hidden ?? "" };
  for (const [key, max, what] of [["bible", WORLD_MAX, "bible"], ["hidden", SECRETS_MAX, "hidden bible"]]) {
    if (typeof raw[key] !== "string") throw new Error(`the ${what} must be text`);
    if (raw[key].trim().length > max) throw new Error(`the ${what} is ${raw[key].trim().length} characters; at most ${max}`);
  }
  if (!Array.isArray(input.entries ?? [])) throw new Error("entries must be a list");
  if ((input.entries ?? []).length > ENTRIES_MAX) throw new Error(`at most ${ENTRIES_MAX} entries`);
  const ids = new Set(), titles = new Set();
  let next = Math.max(1, Number(nextId) || 1);
  for (const e of input.entries ?? []) if (e && ID.test(String(e.id))) next = Math.max(next, Number(e.id.slice(1)) + 1);
  const entries = (input.entries ?? []).map((e, i) => {
    const where = `entry ${i + 1}`;
    if (!e || typeof e !== "object") throw new Error(`${where} is not an entry`);
    const title = oneLine(e.title, Infinity);
    if (!title) throw new Error(`${where} has no title`);
    if (title.length > TITLE_MAX) throw new Error(`"${title.slice(0, 40)}…": the title is longer than ${TITLE_MAX} characters`);
    if (titles.has(title.toLowerCase())) throw new Error(`two entries are titled "${title}"`);
    titles.add(title.toLowerCase());
    const body = String(e.body ?? "").trim();
    if (!body) throw new Error(`"${title}" has no text`);
    if (body.length > BODY_MAX) throw new Error(`"${title}": the text is ${body.length} characters; at most ${BODY_MAX}`);
    const keys = Array.isArray(e.keys) ? e.keys : String(e.keys ?? "").split(/[,，、;；\n]/);
    if (keys.filter((k) => String(k).trim()).length > KEYS_MAX) throw new Error(`"${title}": at most ${KEYS_MAX} keys`);
    if (keys.some((k) => String(k).trim().length > KEY_MAX)) throw new Error(`"${title}": a key is longer than ${KEY_MAX} characters`);
    let id = ID.test(String(e.id)) && !ids.has(e.id) ? e.id : `e${next++}`;
    ids.add(id);
    return { id, title, keys: keysOf(keys), body: text(body, BODY_MAX), secret: e.secret === true, enabled: e.enabled !== false };
  });
  return { bible: text(raw.bible, WORLD_MAX), hidden: text(raw.hidden, SECRETS_MAX), entries, nextId: next };
}

// ---- when an entry is needed

const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matchers = new WeakMap();

// A key matches a whole word in Latin scripts ("Guild" is not found in "Guildford"), anywhere in CJK text. Case and
// spacing do not matter. Keys of a single character are ignored: they would match almost anything.
export function keyMatcher(key) {
  const k = oneLine(key, KEY_MAX).toLowerCase();
  if ([...k].length < 2) return null;
  if (CJK.test(k)) return (t) => t.toLowerCase().includes(k);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(k).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu");
  return (t) => re.test(t);
}

function entryMatchers(e) {
  if (!matchers.has(e)) matchers.set(e, [e.title, ...e.keys].map(keyMatcher).filter(Boolean));
  return matchers.get(e);
}

// The entries in play. `texts` are what the reader has in front of it, newest first (recent lines, the place, a
// co-player's intention…); `requested` are entry ids opened on purpose. Requested entries come first, then the ones
// mentioned most recently, as long as they fit `budget` tokens. They are returned in the book's own order, so the
// section reads the same while the set does not change (the prompt cache holds).
export function entriesInPlay(book, { texts = [], requested = [], secret = false, budget = WORLDBOOK_DEFAULTS.gm_tokens } = {}) {
  const pool = (book?.entries ?? []).filter((e) => e.enabled && (secret || !e.secret));
  const rank = new Map();
  for (const e of pool) {
    if (requested.includes(e.id)) { rank.set(e.id, -1); continue; }
    const ms = entryMatchers(e);
    const at = texts.findIndex((t) => t && ms.some((m) => m(String(t))));
    if (at >= 0) rank.set(e.id, at);
  }
  const chosen = new Set();
  let used = 0;
  for (const e of pool.filter((x) => rank.has(x.id)).sort((x, y) => rank.get(x.id) - rank.get(y.id))) {
    const cost = estimateTokens(e.body) + estimateTokens(e.title) + 4;
    if (used + cost > budget) continue;
    chosen.add(e.id);
    used += cost;
  }
  return pool.filter((e) => chosen.has(e.id));
}

// The entry an opener asked for: its exact title or id first, then a key, then a title that contains the words.
export function findEntry(book, query, { secret = false } = {}) {
  const q = oneLine(query, TITLE_MAX * 2).toLowerCase();
  const pool = (book?.entries ?? []).filter((e) => e.enabled && (secret || !e.secret));
  if (!q) return null;
  return pool.find((e) => e.title.toLowerCase() === q || e.id === q)
    ?? pool.find((e) => e.keys.some((k) => k.toLowerCase() === q))
    ?? pool.find((e) => e.title.toLowerCase().includes(q)) ?? null;
}

// ---- what the models read

// The GM's list of everything beyond the bible (cached with the campaign: it changes only with the book).
export function renderIndex(book) {
  const entries = (book?.entries ?? []).filter((e) => e.enabled);
  if (!entries.length) return "";
  return [
    "## Worldbook (entries beyond the world bible. An entry is shown in full under \"Worldbook: in play\" when its title or a key comes up in this window; open any other with the worldbook_read tool when the story needs it)",
    ...entries.map((e) => `- ${e.title}${e.secret ? " [secret: yours alone]" : ""}${e.keys.length ? ` (keys: ${e.keys.join(", ")})` : ""}`),
  ].join("\n");
}

export function renderInPlay(entries, { gm = false } = {}) {
  if (!entries.length) return "";
  return [
    gm ? "## Worldbook: in play (the entries this window has come to; keep to them)" : "WHAT YOU KNOW ABOUT WHAT CAME UP (common knowledge of the world; you know it as anyone there would):",
    ...entries.map((e) => `### ${e.title}${gm && e.secret ? " [secret: never state it outright; let it surface through play]" : ""}\n${e.body}`),
  ].join("\n");
}

export const WORLDBOOK_TOOL = {
  name: "worldbook_read",
  description: "Read one worldbook entry in full: give its title from the Worldbook list (a key works too). Entries whose title or keys came up in this window are already shown under \"Worldbook: in play\"; an entry you open stays in play here for a while.",
  schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
};

export const WORLDBOOK_TOOL_RULE = "Worldbook: the world bible is always with you; other entries are listed under Worldbook. When the story reaches a place, group, person or custom that has an entry not yet in play, open it with worldbook_read before you describe it, so you keep to it. Do not open entries the scene does not need.";
