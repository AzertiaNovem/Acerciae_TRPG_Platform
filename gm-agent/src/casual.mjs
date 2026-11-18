// Casual mode: an option of this client (the platform knows nothing of it), usually but not necessarily used with
// improvisation. Each player character gets a phone: a private window (`Phone: <name>`) with only its player in it.
// The player texts anyone in the story from there:
//   * `@Silas Mott where are you?` texts Silas; a line without `@` goes to the last person they texted;
//   * an NPC answers through the GM (a `text` action), a co-player answers in character, after a believable delay
//     (or not at all: left on read); pending replies are kept in the state file, so they survive a restart;
//   * another player gets the message in their own phone at once, posted as the sender's character.
// NPCs (through the GM) and co-players may also text a player first. The GM reads every phone; a co-player knows only
// the messages it sent or received.
// Texts with no player character in them (co-player to co-player, co-player to NPC, NPC to co-player) go to the phone
// log, a window with only the GM in it: the recipient answers there, after a delay, through its own model (a
// co-player) or the GM (an NPC). An exchange between two AI characters stops after CASUAL_AI_CHAIN messages until a
// person writes again, and at most CASUAL_AI_TEXTS_PER_HOUR such texts are answered an hour, never while everyone is
// away. A phone is private only on an isolated channel with one player per group, so the
// mode refuses to start anywhere else. In a solemn game (the default) there are no phones.
import { formatTurn } from "./turn-format.mjs";
import { renderIntention } from "./intentions.mjs";

export const PHONE_PREFIX = "Phone: ";
export const PHONE_LOG = "Phone log (GM only)";
export const pairKey = (a, b) => [a, b].sort().join("|");
const PENDING_KEPT = 200;

export function casualState(s) {
  const x = s && typeof s === "object" ? s : {};
  return {
    on: Boolean(x.on),
    phones: x.phones && typeof x.phones === "object" ? { ...x.phones } : {},   // player character id → window id
    last: x.last && typeof x.last === "object" ? { ...x.last } : {},           // character id → who it last texted
    pending: Array.isArray(x.pending) ? x.pending.filter((p) => p && p.windowId && p.from && p.text).slice(-PENDING_KEPT) : [],
    log: typeof x.log === "string" ? x.log : null,                              // the GM-only phone log window
    chain: x.chain && typeof x.chain === "object" ? { ...x.chain } : {},       // AI pair → texts since a person wrote
    aiTexts: Array.isArray(x.aiTexts) ? x.aiTexts.filter(Number.isFinite).slice(-100) : [],   // answers in the last hour
  };
}

const norm = (s) => String(s ?? "").trim().toLowerCase();
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

// The contact a line is addressed to. `@` followed by a contact's full name or first name (longest match wins);
// `contacts` are {id, name}. Returns {to, body}: `to` is null when the line names no known contact.
export function parseAddress(text, contacts) {
  const s = String(text ?? "").trim();
  if (!s.startsWith("@")) return { to: null, body: s, addressed: false };
  const rest = s.slice(1);
  const lower = norm(rest);
  let best = null;
  for (const c of contacts) {
    for (const [key, full] of [[norm(c.name), true], [norm(String(c.name).split(/\s+/)[0]), false]]) {
      if (!key || !lower.startsWith(key)) continue;
      // A name ends at a space or punctuation; CJK names need no separator ("@张三在吗").
      const next = rest.charAt(key.length);
      if (next && !/[\s:,.!?，：。！？、]/.test(next) && !CJK.test(key.slice(-1))) continue;
      const score = key.length + (full ? 0.5 : 0);   // a full name beats someone else's first name of the same length
      if (!best || score > best.score) best = { c, len: key.length, score };
    }
  }
  if (!best) return { to: null, body: s, addressed: true };
  return { to: best.c.id, body: rest.slice(best.len).replace(/^[\s:,，：]+/, "").trim(), addressed: true };
}

// Minutes the model asked for, as a timestamp: 0 means now; the delay is capped by CASUAL_MAX_DELAY_MINUTES.
export const dueAt = (now, minutes, max) => now + Math.round(Math.max(0, Math.min(Number(minutes) || 0, max)) * 60000);

// A co-player answers a text in character (or leaves it on read). It is given its own card and memories (in `self`,
// stable-first) and the thread with this person only.
export async function coplayerPhoneReply(llm, { language, self, name, from, thread, maxDelay, pc = "investigator", lore = "", intention = "", canFormat, formatting }) {
  const system = `You play ${name}, an ${pc} in a tabletop roleplaying game, and you are reading your phone. Text messages are part of this casual game, even when the setting has no phones: treat them as natural. Reply in character, as a text message would read: short, in your own voice, true to what you know. You may wait before answering, as people do, or leave it unanswered if that is what ${name} would do. Write in ${language}.
Write only your text message as plain text, without JSON. If you would leave it unread, write Pass. If the answer should arrive later, add a separate Table directions: paragraph saying how many minutes to wait (up to ${maxDelay}).`;
  const user = [
    { text: `${self}\n\n`, cache: true },
    { text: `${[renderIntention(intention), lore].filter(Boolean).map((x) => `${x}\n\n`).join("")}YOUR MESSAGES WITH ${from} (oldest first):\n${thread || "(none before)"}\n\n${from} just texted you. Your answer?` },
  ];
  return await formatTurn(llm, {
    system, user, purpose: "coplayer_phone", canFormat, formatting,
    schema: 'For a co-player phone reply return {"reply":1,"delay_minutes":0} with the drafted delay, or {"reply":null} for no reply.',
    bind: (x, take) => x?.reply == null ? x : { ...x, reply: take(x.reply, 'public').text },
    validate: (x) => ({ reply: x.reply ?? null, delay: Math.max(0, Math.min(Number(x.delay_minutes) || 0, maxDelay)) }),
  }) ?? { reply: null, delay: 0 };
}

// A thread, as lines "#seq Name → Name: text", oldest first.
export function renderThread(rows, nameOf) {
  return rows.map((r) => `#${r.seq} ${nameOf(r.from)} → ${nameOf(r.to)}: ${String(r.text).replace(/\s+/g, " ").trim()}`).join("\n");
}
