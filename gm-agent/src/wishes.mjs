// The players' words to the story planner. A window of its own ("To the story planner"), with every player in it,
// where the people at the table say where they would like the story to go (a wish) or what it got wrong against their
// setting, stated or implicit (a correction: a character acting against their nature, a fact of the world contradicted,
// a tone they do not want). No turn is played there, and the lines start no planner run: they wait in the planner's
// inbox, and its next run (whatever triggered it) reads them, keeps the standing wishes and corrections as table notes,
// and answers in the window along the way.
//
// Who reads what: the GM and the planner read every note. A co-player reads only the corrections, those about it or
// about no one in particular, as out-of-character table rules: a wish is the planner's to weave in, and a co-player
// told it would play to it. State: `planner.inbox` (lines not yet read), `planner.table` (the notes), `planner.window`.

import { leaksSecret } from "./planner.mjs";

export const WISH_WINDOW = "To the story planner";
const MAX_NOTES = 20, MAX_INBOX = 30, NOTE_MAX = 300;
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const norm = (s) => String(s ?? "").trim().toLowerCase();

export function inboxState(x) { return (Array.isArray(x) ? x : []).filter((l) => l && l.text).slice(-MAX_INBOX); }
export function tableNotesState(x) {
  return (Array.isArray(x) ? x : []).filter((n) => n && /^N\d+$/.test(n.id) && n.text && (n.kind === "wish" || n.kind === "correction")).map((n) => ({ ...n, about: Array.isArray(n.about) ? n.about.map(String) : [] })).slice(-MAX_NOTES);
}

// A player's line in the window: kept for the next planner run.
export function addToInbox(inbox, { seq, who, text, at }) {
  inbox.push({ seq, who: clip(who, 80), text: clip(text, 1000), at });
  if (inbox.length > MAX_INBOX) inbox.splice(0, inbox.length - MAX_INBOX);
}

// The planner's table notes: ids kept across versions ("new" gets the next number), `drop` removes one, at most
// MAX_NOTES (the oldest wishes go first; corrections are kept longer). Returns {notes, nextId, changed}.
export function mergeTableNotes(current, list, { nextId = 1, now = Date.now() } = {}) {
  const notes = current.map((n) => ({ ...n }));
  let id = nextId, changed = 0;
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x !== "object") continue;
    const known = notes.find((n) => n.id === String(x.id ?? "").trim());
    if (x.drop === true || x.drop === "true") { if (known) { notes.splice(notes.indexOf(known), 1); changed++; } continue; }
    const kind = x.kind === "correction" ? "correction" : x.kind === "wish" ? "wish" : null;
    const text = clip(x.text, NOTE_MAX);
    if (!kind || !text) continue;
    const about = (Array.isArray(x.about) ? x.about : []).map((a) => clip(a, 80)).filter(Boolean).slice(0, 6);
    if (known) {
      if (known.text !== text || known.kind !== kind || JSON.stringify(known.about) !== JSON.stringify(about)) { Object.assign(known, { kind, text, about }); changed++; }
      continue;
    }
    if (notes.some((n) => norm(n.text) === norm(text))) continue;
    notes.push({ id: `N${id++}`, kind, text, about, since: new Date(now).toISOString() });
    changed++;
  }
  while (notes.length > MAX_NOTES) notes.splice(notes.findIndex((n) => n.kind === "wish") >= 0 ? notes.findIndex((n) => n.kind === "wish") : 0, 1);
  return { notes, nextId: id, changed };
}

// The GM's section (part C).
export function renderTableNotes(notes) {
  if (!notes.length) return "";
  const corr = notes.filter((n) => n.kind === "correction"), wish = notes.filter((n) => n.kind === "wish");
  return [
    "## The players' wishes and corrections (they wrote these to the story planner, out of character)",
    ...(corr.length ? ["Corrections: things the story got wrong against their setting. Keep to them strictly, from now on:", ...corr.map((n) => `- ${n.id}: ${n.text}${n.about.length ? ` (about ${n.about.join(", ")})` : ""}`)] : []),
    ...(wish.length ? ["Wishes: where they would like the story to go. Steer toward them as the story allows, without forcing them:", ...wish.map((n) => `- ${n.id}: ${n.text}${n.about.length ? ` (about ${n.about.join(", ")})` : ""}`)] : []),
  ].join("\n");
}

// What a co-player reads: the corrections about it, or about no one in particular.
export function renderCorrectionsFor(notes, name) {
  const mine = notes.filter((n) => n.kind === "correction" && (!n.about.length || n.about.some((a) => norm(a) === norm(name) || norm(String(name).split(/\s+/)[0]) === norm(a))));
  return mine.length ? `TABLE CORRECTIONS (out of character, from the players: keep to them from now on):\n${mine.map((n) => `- ${n.text}`).join("\n")}` : "";
}

// The planner's answer in the window: short, and never a quoted secret or hidden truth (else a plain acknowledgement).
export function plannerReply(text, secrets) {
  const t = clip(text, 600);
  if (!t) return "";
  return leaksSecret(t, secrets) ? "Noted: the story will take this into account." : t;
}

// The briefing block for the planner: the players' new lines, then the standing notes.
export function renderInbox(inbox, notes) {
  return [
    inbox.length ? `## The players' words to you (from the planner window, oldest first; answer them in "reply")\n${inbox.map((l) => `- ${l.who}: ${l.text}`).join("\n")}` : "",
    notes.length ? `## Standing table notes (keep, change or drop by id)\n${notes.map((n) => `- ${n.id} [${n.kind}] ${n.text}${n.about.length ? ` (about ${n.about.join(", ")})` : ""}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
