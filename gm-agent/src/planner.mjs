// The story planner: a second, slower model role above the GM. The GM reads the recent chat and plays step by step; in
// a long campaign that stretches one trivial event over many turns, because nobody holds the whole story. The planner
// does: now and then, in the background and with its own model, it rereads the campaign, keeps a plan of twists and
// plots (inventing and weaving them when the campaign is improvised), reviews its own draft, and tells the GM when the
// current event has run its course. The GM is advised, not commanded: it steers toward the plan and deviates when the
// players surprise it. Co-players get at most one private impulse each, an in-character urge that never names a secret.
//
// Nothing here runs on the turn queue: planStory() is a Memory.run("planner") job beside the turns, and its result is
// adopted at the next turn boundary. The compact plan lives in the state file (key `planner`); every version's full
// record (draft, critique, final) is in the store's `plans` table.
//
// The planner never runs on its own while nobody is at the table (plannerDue), with one exception: the final review.
// When a session of human play ends (no human line for the idle time, or the operator stops `run`), it reviews the
// whole session once and prepares the next one, more boldly than mid-session: it moves the calendar on, records what
// the world did off-screen meanwhile, and says how the next session should open (`between`, read by the Keeper at the
// first turn of the next session).
import { completeJson } from "./llm/index.mjs";
import { estimateTokens } from "./memory.mjs";

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const STATUSES = new Set(["seed", "live", "ripe", "resolved", "dropped"]);
const MAX_THREADS = 8, MAX_NEXT = 3, MAX_HOOKS = 3, MAX_NOTES = 5, IMPULSE_MAX = 240;

export function plannerState(s) {
  const x = s && typeof s === "object" ? s : {};
  return {
    on: x.on === undefined ? true : Boolean(x.on),
    arc: x.arc && typeof x.arc === "object" ? x.arc : null,
    impulses: Array.isArray(x.impulses) ? x.impulses.filter((i) => i && i.coplayerId && i.text) : [],
    nextThreadId: Number.isInteger(x.nextThreadId) && x.nextThreadId > 0 ? x.nextThreadId : 1,
    lastRunAt: Number(x.lastRunAt) || 0,
    lastRunSeq: Number(x.lastRunSeq) || 0,
    runs: Array.isArray(x.runs) ? x.runs.filter(Number.isFinite) : [],
    scenarioId: x.scenarioId ?? null,
    stall: { turns: Number(x.stall?.turns) || 0, sig: x.stall?.sig ?? null },
    notes: Array.isArray(x.notes) ? x.notes.filter((n) => n && n.text).slice(-MAX_NOTES) : [],
    asked: x.asked && typeof x.asked === "object" ? x.asked : null,
    notedVersion: Number(x.notedVersion) || 0,
    pending: x.pending && typeof x.pending === "object" ? x.pending : null,
    // The human session in progress (for the final review), and what the last final review left for the next one.
    session: x.session && typeof x.session === "object" && Number.isFinite(x.session.lastAt) ? x.session : null,
    between: x.between && typeof x.between === "object" ? x.between : null,
    lastFinalAt: Number(x.lastFinalAt) || 0,
    // The planner window (wishes.mjs): its id, the players' lines not read yet, the standing wishes and corrections.
    window: typeof x.window === "string" ? x.window : null,
    inbox: Array.isArray(x.inbox) ? x.inbox.filter((l) => l && l.text).slice(-30) : [],
    table: Array.isArray(x.table) ? x.table.filter((n) => n && /^N\d+$/.test(n.id) && n.text && ["wish", "correction"].includes(n.kind)).map((n) => ({ ...n, about: Array.isArray(n.about) ? n.about.map(String) : [] })).slice(-20) : [],
    nextNoteId: Number.isInteger(x.nextNoteId) && x.nextNoteId > 0 ? x.nextNoteId : 1,
  };
}

// A human line: the session goes on, or a new one begins (a stale one, never reviewed, is dropped and returned).
export function noteSessionLine(p, { at, seq, idleMs }) {
  const s = p.session;
  if (s && at - s.lastAt <= idleMs) { s.lastAt = Math.max(s.lastAt, at); s.lines++; return null; }
  p.session = { startedAt: at, lastAt: at, lines: 1, fromSeq: seq };
  return s;
}

// Whether the session has ended: null (still going, or none), "short" (too little play to review) or "review".
export function sessionEnded(session, { now, idleMs, minLines }) {
  if (!session || now - session.lastAt <= idleMs) return null;
  return session.lines >= minLines ? "review" : "short";
}

// full: an improvised campaign (plots are the planner's to invent); pace: a module-led one (pace only); off.
export const plannerModeOf = (planner, improv) => (!planner?.on ? "off" : improv?.on ? "full" : "pace");

// Why a plan should be made now, or null. `s` is a snapshot: {on, busy, overBudget, now, lastHumanAt, idleMs, runs,
// lastRunAt, lastRunSeq, lastSeq, arc, asked, scenarioId, plannerScenarioId, stallTurns}.
// `noDate`: the story has no date yet, so the first plan (which chooses it) runs at the first turn boundary.
export function plannerDue(s, cfg) {
  if (!s.on || s.busy || s.overBudget) return null;
  if (s.now - s.lastHumanAt > s.idleMs) return null;                                  // nobody at the table
  if (s.runs.filter((t) => s.now - t < 3600000).length >= cfg.maxRunsPerHour) return null;
  const lines = s.lastSeq - s.lastRunSeq;
  if (!s.arc) return lines >= 10 || s.noDate ? "first" : null;
  if (s.now - s.lastRunAt < cfg.cooldownMs) return null;
  if (s.asked) return "asked";
  if (s.scenarioId !== s.plannerScenarioId) return "scenario";
  if (s.stallTurns >= cfg.stallTurns) return "stall";
  if (cfg.intervalMs > 0 && s.now - s.lastRunAt >= cfg.intervalMs && lines >= cfg.minLines) return "interval";
  return null;
}

// What a turn leaves unchanged when the story is standing still: same scenario, place, world record, truths, threads.
export const stallSignature = ({ scenarioId, place, worldVersion, worldChange, truths, threads }) => JSON.stringify([scenarioId ?? null, place ?? "", worldVersion ?? null, worldChange ?? null, truths ?? 0, threads ?? 0]);

const grams = (text, n, cjk = false) => {
  const out = new Set();
  if (cjk) { const s = text.replace(/\s+/g, ""); for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n)); return out; }
  const w = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
};
const hasCjk = (t) => /[⺀-鿿가-힯]/.test(t);

// The last Keeper narrations repeating themselves (word trigrams; CJK: character 4-grams) is a secondary sign of a stall.
export function narrationRepeats(narrations, { last = 3, share = 0.5 } = {}) {
  const recent = narrations.slice(-last).map((t) => String(t ?? "")).filter((t) => t.trim());
  if (recent.length < 2) return false;
  const sets = recent.map((t) => (hasCjk(t) ? grams(t, 4, true) : grams(t, 3)));
  const newest = sets.at(-1);
  if (!newest.size) return false;
  let shared = 0;
  for (const g of newest) if (sets.slice(0, -1).some((s) => s.has(g))) shared++;
  return shared / newest.size >= share;
}

// Does `text` quote a hidden truth or secret? Word 5-grams, character 12-grams for CJK runs.
export function leaksSecret(text, secrets) {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  const words = grams(t, 5), chars = hasCjk(t) ? grams(t, 12, true) : new Set();
  for (const s of secrets ?? []) {
    const src = String(s ?? "");
    if (!src.trim()) continue;
    for (const g of grams(src, 5)) if (words.has(g)) return true;
    if (chars.size) for (const g of grams(src, 12, true)) if (chars.has(g)) return true;
  }
  return false;
}

const META = /\b(plan(ner|ned|s)?|keeper|game ?master|\bGM\b|player|prompt|instruction|secret)\b|计划|守秘人|玩家|剧本|提示词/i;

// At most one impulse per co-player, by name; nothing that quotes a secret or talks about the game itself.
export function validateImpulses(list, { coplayers = [], secrets = [], version = 0, lastSeq = 0, lifetime = 60 } = {}) {
  const out = [];
  for (const i of Array.isArray(list) ? list : []) {
    const cp = coplayers.find((c) => String(c.name).trim().toLowerCase() === String(i?.who ?? "").trim().toLowerCase());
    const text = clip(i?.text, IMPULSE_MAX);
    if (!cp || !text || out.some((o) => o.coplayerId === cp.characterId)) continue;
    if (leaksSecret(text, secrets) || META.test(text)) continue;
    out.push({ coplayerId: cp.characterId, name: cp.name, text, version, expiresSeq: lastSeq + lifetime });
  }
  return out;
}

// The critique never fails validation: a reply that is not an object counts as "no faults found".
export function validateCritique(x) {
  const arr = (v) => (Array.isArray(v) ? v.map((s) => clip(s, 300)).filter(Boolean).slice(0, 8) : []);
  if (!x || typeof x !== "object") return { boring: [], implausible: [], contradictions: [], stale: [], merge: [], beat_done: null, must_fix: [] };
  return { boring: arr(x.boring), implausible: arr(x.implausible), contradictions: arr(x.contradictions), stale: arr(x.stale), merge: arr(x.merge), beat_done: typeof x.beat_done === "boolean" ? x.beat_done : null, must_fix: arr(x.must_fix) };
}

// The plan the GM will read: clipped, capped, ids kept across versions. Throws only when the shape is unusable (no
// object, no beat), so completeJson's one repair round fires; everything else is dropped or clipped.
export function validateStoryPlan(x, { mode = "full", prev = null, nextId = 1, seq = 0, trigger = "", now = Date.now() } = {}) {
  if (!x || typeof x !== "object") throw new Error("expected an object");
  const beatTitle = clip(x.beat?.title, 80);
  if (!beatTitle) throw new Error("beat.title is required");
  let id = nextId;
  const known = new Set((prev?.threads ?? []).map((t) => t.id));
  const threads = [];
  if (mode === "full") {
    for (const t of Array.isArray(x.threads) ? x.threads : []) {
      if (!t || typeof t !== "object") continue;
      const title = clip(t.title, 80);
      if (!title) continue;
      let tid = String(t.id ?? "").trim();
      if (!/^P\d+$/.test(tid) || !known.has(tid) && threads.some((o) => o.id === tid)) tid = "";
      if (!tid || !known.has(tid)) tid = `P${id++}`;
      if (threads.some((o) => o.id === tid)) continue;
      const status = STATUSES.has(t.status) ? t.status : "live";
      threads.push({ id: tid, title, status, stakes: clip(t.stakes, 200), hooks: (Array.isArray(t.hooks) ? t.hooks : []).map((h) => clip(h, 120)).filter(Boolean).slice(0, MAX_HOOKS), twist: clip(t.twist, 300), ripeWhen: clip(t.ripe_when ?? t.ripeWhen, 160), weaveWith: /^P\d+$/.test(String(t.weave_with ?? t.weaveWith ?? "")) ? String(t.weave_with ?? t.weaveWith) : null });
    }
    // Open threads first; the cap keeps the compact plan compact.
    const open = threads.filter((t) => !["resolved", "dropped"].includes(t.status)).slice(0, MAX_THREADS);
    threads.splice(0, threads.length, ...open, ...threads.filter((t) => ["resolved", "dropped"].includes(t.status)).slice(0, 4));
  }
  const sameBeat = prev?.beat && prev.beat.title === beatTitle;
  const beat = { title: beatTitle, purpose: clip(x.beat?.purpose, 200), exit: clip(x.beat?.exit, 200), startedSeq: sameBeat ? prev.beat.startedSeq : seq, startedVersion: sameBeat ? prev.beat.startedVersion : (prev?.version ?? 0) + 1, closed: false };
  const next = mode === "full" ? (Array.isArray(x.next) ? x.next : []).map((n) => ({ what: clip(n?.what, 200), when: clip(n?.when, 120) })).filter((n) => n.what).slice(0, MAX_NEXT) : [];
  const verdict = { moveOn: x.verdict?.move_on === true || x.verdict?.moveOn === true || x.verdict?.move_on === "true", why: clip(x.verdict?.why, 200), sinceSeq: seq };
  const arc = {
    version: (prev?.version ?? 0) + 1, updatedAt: new Date(now).toISOString(), trigger: String(trigger || "manual"), mode,
    throughline: mode === "full" ? clip(x.throughline, 300) : "",
    threads, beat, next, verdict,
    played: clip(x.played, 400), review: { critique: clip(prev?.pendingCritique ?? x.critique, 600), changed: clip(x.changed, 400) },
    calendar: { start: clip(x.calendar?.start, 80), time: clip(x.calendar?.time, 80), advice: clip(x.calendar?.advice, 200), routine: clip(x.calendar?.routine, 400), upcoming: (Array.isArray(x.calendar?.upcoming) ? x.calendar.upcoming : []).map((u) => ({ when: clip(u?.when, 80), what: clip(u?.what, 200) })).filter((u) => u.what).slice(0, 3) },
  };
  return { arc, nextId: id, rawImpulses: Array.isArray(x.impulses) ? x.impulses : [], rawBonds: mode === "full" && Array.isArray(x.bonds) ? x.bonds.slice(0, 12) : [] };
}

// The final review's `between`: how far the calendar moves (a missing value counts as one day: the world moves on
// between sessions), what happened off-screen (improvised campaigns only), how the next session opens.
export function validateBetween(x, { mode = "full", maxDays = 30 } = {}) {
  const b = x && typeof x === "object" ? x : {};
  const raw = b.advance_days ?? b.advanceDays;
  const days = raw === undefined || raw === null || raw === "" ? 1 : Math.round(Number(raw));
  const offscreen = mode === "full" ? (Array.isArray(b.offscreen) ? b.offscreen : []).map((o) => (typeof o === "string" ? { text: o } : o)).map((o) => ({ text: clip(o?.text, 300), secret: o?.secret === true || o?.secret === "true" })).filter((o) => o.text).slice(0, 4) : [];
  return {
    advanceDays: Number.isFinite(days) ? Math.max(0, Math.min(maxDays, days)) : 1,
    date: clip(b.date, 80), time: clip(b.time, 80), why: clip(b.why, 200),
    offscreen, opening: clip(b.opening, 400), recap: clip(b.recap, 600),
  };
}

// The Keeper-only note after a final review.
export function renderFinalNote({ session, between, calendar, declared = 0, secret = 0, bonds = 0 }) {
  const minutes = Math.max(1, Math.round((session.lastAt - session.startedAt) / 60000));
  return clip([
    `Final review of the session (${session.lines} player lines over ${minutes} min).`,
    calendar === null ? "" : calendar?.changed ? `Calendar: ${calendar.from || "(no date)"} → ${calendar.to}${between.why ? ` — ${between.why}` : ""}.` : calendar?.refused ? `Calendar unchanged (${calendar.refused}).` : "Calendar unchanged.",
    declared ? `Off-screen: ${declared} development(s) recorded in the world record${secret ? ` (${secret} secret)` : ""}.` : "",
    bonds ? `Relationships: ${bonds} change(s).` : "",
    between.opening ? `Next session opens: ${between.opening}` : "",
    between.recap ? `Recap: ${between.recap}` : "",
  ].filter(Boolean).join(" "), 1400);
}

// The GM's section, within `budget` tokens: resolved and dropped threads go first, then seeds.
export function renderStoryPlan(arc, budget = 1500) {
  if (!arc) return "";
  const pace = arc.mode === "pace";
  const head = pace
    ? "## Story plan (pace only, from the story planner: the module has the plots; this is about when to let an event go. Strong guidance, not orders)"
    : "## Story plan (your private plan from the story planner: strong guidance, not orders — follow it unless the players' choices lead elsewhere; never state it or its twists outright)";
  const verdict = arc.verdict?.moveOn ? `MOVE ON — ${arc.verdict.why || "this event has run its course"}` : `continue${arc.verdict?.why ? ` — ${arc.verdict.why}` : ""}`;
  const render = (threads) => [
    head,
    arc.throughline ? `Throughline: ${arc.throughline}` : "",
    `Current beat: "${arc.beat.title}"${arc.beat.purpose ? ` — purpose: ${arc.beat.purpose}` : ""}${arc.beat.exit ? ` — exit: ${arc.beat.exit}` : ""}${arc.beat.closed ? " (closed)" : ""}`,
    `Verdict: ${verdict}`,
    arc.next?.length ? `Next twists: ${arc.next.map((n, i) => `${i + 1}. ${n.what}${n.when ? ` (when ${n.when})` : ""}`).join(" ")}` : "",
    threads.length ? `Threads to weave:\n${threads.map((t) => `- ${t.id} "${t.title}" [${t.status}]${t.stakes ? ` stakes: ${t.stakes}` : ""}${t.hooks?.length ? ` hooks: ${t.hooks.join("; ")}` : ""}${t.twist ? ` twist: ${t.twist}` : ""}${t.ripeWhen ? ` ripe when: ${t.ripeWhen}` : ""}${t.weaveWith ? ` weave with ${t.weaveWith}` : ""}`).join("\n")}` : "",
    arc.calendar?.advice ? `Calendar: ${arc.calendar.advice}` : "",
    arc.review?.changed ? `Planner's last review: ${arc.review.changed}` : "",
  ].filter(Boolean).join("\n");
  let threads = [...(arc.threads ?? [])];
  let text = render(threads);
  for (const drop of [["resolved", "dropped"], ["seed"]]) {
    if (estimateTokens(text) <= budget) break;
    threads = threads.filter((t) => !drop.includes(t.status));
    text = render(threads);
  }
  while (estimateTokens(text) > budget && threads.length) { threads.pop(); text = render(threads); }
  return text;
}

// The Keeper-only note posted once per version.
export function renderPlanNote(arc, impulses = []) {
  const open = (arc.threads ?? []).filter((t) => !["resolved", "dropped"].includes(t.status));
  const bits = [
    `Story plan v${arc.version} (${arc.trigger}) — beat "${arc.beat.title}"${arc.beat.exit ? `: exit when ${arc.beat.exit}` : ""}. Verdict: ${arc.verdict?.moveOn ? `MOVE ON — ${arc.verdict.why}` : "continue"}.`,
    arc.next?.[0] ? `Next: ${arc.next[0].what}.` : "",
    open.length ? `Threads: ${open.map((t) => `${t.id} ${t.status}`).join(", ")}.` : "",
    impulses.length ? `Impulse for ${impulses.map((i) => i.name).join(", ")}.` : "",
    arc.review?.changed ? `Changed: ${arc.review.changed}` : "",
    "Full plan: `plan show`.",
  ].filter(Boolean).join(" ");
  return clip(bits, 900);
}

// The one line a co-player reads: its own urge, quoted.
export const renderImpulse = (impulse) => (impulse ? `SOMETHING ON YOUR MIND (your own thought, no one else's; pursue it when it fits, in your own way, without announcing it): "${impulse.text}"` : "");

// `calendar`: a casual game, whose story keeps a date (calendar.mjs); a solemn game has none.
// `table`: the planner window is open, so the reply carries table notes and an answer to the players (wishes.mjs).
export function plannerSystem(language, { mode = "full", final = false, calendar = false, table = false } = {}) {
  const common = `You are the story planner of a long tabletop roleplaying campaign played in chat. You are not the Keeper (GM) and you never speak in the chat: the Keeper reads your plan and decides; you advise. You read the whole campaign slowly, while the Keeper plays step by step. Your job is the global view: where the story is going, what should happen next, and above all when the current event has run its course, so that nobody stretches a trivial scene over many turns. Prefer closing events over stretching them. Write in ${language}.`;
  const full = `
The campaign is improvised: there is no module. Be bold. Invent original plots, weave several into one situation, raise the stakes, pay off what was planted. Every invention must fit the World setting and every Hidden truth and The world now; record each as a secret twist the Keeper reveals through play, never a fact stated to the players. Keep thread ids across versions; resolve or drop what has gone stale rather than letting it linger.
An impulse is one co-player's own urge, written to that character in the second person, in character ("you want to see the warehouse tonight; the watchman's lie bothers you"). It never reveals a hidden truth or a twist, never mentions a plan, the Keeper, the game or other players as players, and never tells the character what will happen.
Keep the Relationships current in "bonds": every relationship the profiles or the chat state between characters at the table (who lives together, family, lovers, friends, colleagues, rivals) that is not listed yet, and the ones you invent between co-players and NPCs or among NPCs, to tie the plots to people. A bond with a player character only when its profile or the chat already states it: never decide what a player character feels. Mark a bond secret when the investigators do not know it.`;
const CALENDAR_RULE = `
Time (a casual game: the story keeps a calendar): the Calendar section is the story's date, always YYYY-MM-DD. If no date is set yet, choosing the first one is your job: put it in calendar.start (YYYY-MM-DD, a year within the campaign's era) and its time of day in calendar.time, fitting the era, the World setting (when its calendar says the story usually opens) and the plots you plan. Let events breathe: say in calendar.advice when the calendar should move on next and how far (a night's sleep, a week of research, a journey).
Routine: everyday life follows a calendar too (a school year, a working week, a fishing or harvest season, holidays, festivals); the World setting may describe it. In calendar.routine say what everyday life is busy with on the current date (the date you set in calendar.start, or the one a final review moves to), and in calendar.upcoming the routine events of the next weeks. Take them from the world's calendar and the era, and invent fitting ones where it says nothing. The routine is common knowledge that everyone in the story shares: never a secret, a twist or a plan. Use it: tie plots to it, and let the investigators' days fill with it between events.`;
const TABLE_RULE = `
The players can write to you in a window of their own (The players' words to you), out of character. A wish is where they would like the story to go: weave it into the plan, unless it would break the World setting, a Hidden truth or another player's fun; then say so kindly in reply. A correction is something the story got wrong against their setting, stated or implicit: a character acting against their nature, a fact of the world contradicted, a tone they do not want. Record it as a standing correction for the Keeper and the co-players, fix the plan to match it, and never repeat the mistake. Keep "table_notes" current: one note per standing wish or correction, in your own clear words, with the characters it is about; keep ids, change a note when the players refine it, drop it when it is fulfilled or withdrawn. When the players wrote to you, answer them in "reply": what you will steer toward and what you corrected, in a sentence or two; never a twist, a secret, a hidden truth or what will happen.`;
const FINAL_RULE = (mode, calendar) => `
FINAL REVIEW: the players have just left the table; this session is over. Review the whole session and prepare the next one. Be more proactive than in a plan made during play: nobody is waiting, and the world moves on between sessions.${calendar ? " Decide how much time passes before the next session in between.advance_days (usually one day or more; longer when the story has a natural pause; 0 only when the next session must pick up the very same moment, such as mid-fight or mid-conversation) and the time of day it resumes." : ""}${mode === "pace" ? ` The module has the plots: record no off-screen developments${calendar ? ", only what time passes" : ""}.` : " Record what the world did meanwhile in between.offscreen: people acting on their own plans, consequences of what the investigators did, threads ripening; each one a fact about the world now, secret when the investigators would not know it yet."} Say how the next session should open (between.opening) and sum up this session for the Keeper (between.recap).`;
  const pace = `
The campaign follows a module: the module has the plots. Do not invent plots, people or twists. Judge pace only: name the current event and its exit (what must happen for it to be done, from the script knowledge and the Keeper board), say whether the Keeper should let it go, and what the next beat is according to the module.`;
  return common + (mode === "pace" ? pace : full) + (calendar ? CALENDAR_RULE : "") + (table ? TABLE_RULE : "") + (final ? FINAL_RULE(mode, calendar) : "");
}

const CALENDAR_SCHEMA = `"calendar": {"start": "YYYY-MM-DD: the story's first date, only if none is set yet", "time": "the time of day it opens, with start", "advice": "when the calendar should move on next, and how far", "routine": "what everyday life is busy with on the current date (common knowledge)", "upcoming": [{"when": "...", "what": "a routine event of the next weeks"}]}`;
const BETWEEN_SCHEMA = (mode, calendar) => `"between": {${calendar ? `"advance_days": 1, "date": "YYYY-MM-DD: the new date, if you would rather name it", "time": "the time of day the next session resumes", "why": "...", ` : ""}${mode === "pace" ? "" : `"offscreen": [{"text": "what is now true in the world", "secret": true}], `}"opening": "how the next session should open", "recap": "this session in a few sentences"}`;
const TABLE_SCHEMA = `"table_notes": [{"id": "N1 (keep ids) | new", "kind": "wish | correction", "text": "the standing wish or correction, in your words", "about": ["<character names>"], "drop": false}],
 "reply": "your answer to the players' words, or empty when they wrote nothing new"`;
const DRAFT_SCHEMA = (mode, final = false, calendar = false, table = false) => {
  const extra = `${calendar ? `,\n ${CALENDAR_SCHEMA}` : ""}${table ? `,\n ${TABLE_SCHEMA}` : ""}${final ? `,\n ${BETWEEN_SCHEMA(mode, calendar)}` : ""}`;
  const base = mode === "pace"
  ? `{"beat": {"title": "...", "purpose": "...", "exit": "what must happen for this event to be done"}, "verdict": {"move_on": false, "why": "..."}, "played": "how the previous plan played out", "changed": "what you changed and why"}`
  : `{"throughline": "what the story is really about and where it heads (≤300 chars)",
 "threads": [{"id": "P1 (keep ids from the previous plan) | new", "title": "...", "status": "seed|live|ripe|resolved|dropped", "stakes": "...", "hooks": ["how the investigators can get into it"], "twist": "the secret turn (for the Keeper)", "ripe_when": "...", "weave_with": "P3 | null"}],
 "beat": {"title": "the current event", "purpose": "...", "exit": "what must happen for this event to be done"},
 "next": [{"what": "the next twist", "when": "..."}],
 "verdict": {"move_on": false, "why": "..."},
 "impulses": [{"who": "<co-player name>", "text": "their own urge, in character, second person"}],
 "bonds": [{"a": "<character name>", "b": "<character name>", "kind": "lives with | married | lovers | friends | family | colleagues | rivals | ...", "note": "which way, since when", "secret": false, "end": false}],
 "played": "how the previous plan played out", "changed": "what you changed and why"}`;
  return `${base.slice(0, -1)}${extra}}`;
};

const FINAL_CRITIQUE = ` This is the final review of a session: also check that "between" moves the story on (time passes, the world acts off-screen, as the game allows) without contradicting anything, and that the opening hands the players a situation, not a summary.`;
const CRITIQUE = `STEP: critique
You are now a second Keeper, a harsh script editor who did not write the draft above. Read it against everything you were given and find at least three concrete faults, or say explicitly that there are none and why. Look for: what is boring or repetitive; what is implausible, or contradicts the World setting, the Hidden truths or The world now; which threads are stale (untouched for long) and should be resolved, dropped or merged; where two plots can be joined into one situation; whether the current beat has run its course (its exit met, or the players plainly done with it) and the verdict is honest; whether an impulse reveals a secret or talks about the game. Reply with only this JSON:
{"boring": ["..."], "implausible": ["..."], "contradictions": ["..."], "stale": ["..."], "merge": ["..."], "beat_done": true | false | null, "must_fix": ["the changes the revision must make"]}`;

// The planning job: draft, critique, revise, as one growing conversation (the big context is cached once and read
// twice). `contextText` is the Keeper's context plus planner-only blocks; `prev` the previous compact plan.
// `final` ({maxDays}) makes it the final review of a session: the reply also carries `between`.
// `calendar`: the story keeps a date (casual games only).
// `table`: the planner window is open; `wishes` the players' new words and the standing notes (wishes.mjs renderInbox).
export async function planStory(llm, { language, mode, contextText, prev, since, coplayers, secrets, nextId, lastSeq, trigger, now, impulseLines, final = null, calendar = false, table = false, wishes = "", log = () => {} }) {
  const system = plannerSystem(language, { mode, final: Boolean(final), calendar, table });
  const briefing = [
    `## Previous story plan${prev ? ` (v${prev.version}, ${prev.trigger})` : ""}\n${prev ? renderStoryPlan(prev, 4000).split("\n").slice(1).join("\n") : "(none yet: this is the first plan)"}`,
    `## Since the last plan\n${since || "(nothing recorded)"}`,
    wishes,
    mode === "full" ? `## Co-players you may give an impulse\n${coplayers.map((c) => `- ${c.name}`).join("\n") || "(none)"}` : "",
  ].filter(Boolean).join("\n\n");
  const draftAsk = `STEP: draft\n${final ? "This is the FINAL REVIEW of the session that just ended. Write the story plan for the next session" : `Write the story plan now${trigger ? ` (why you were asked: ${trigger})` : ""}`}. Reply with only this JSON:\n${DRAFT_SCHEMA(mode, Boolean(final), calendar, table)}`;
  const critiqueAsk = final ? CRITIQUE.replace("Reply with only this JSON:", `${FINAL_CRITIQUE.trim()} Reply with only this JSON:`) : CRITIQUE;
  const context = [{ text: `${contextText}\n\n${briefing}\n\n`, cache: true }];
  const draftJson = await completeJson(llm, { system, user: [...context, { text: draftAsk }], purpose: "planner", phase: final ? "final_draft" : "draft" }, (x) => { if (!x || typeof x !== "object") throw new Error("expected an object"); return x; });
  const draftText = JSON.stringify(draftJson);
  const critique = await completeJson(llm, { system, messages: [{ role: "user", content: [...context, { text: draftAsk }] }, { role: "assistant", content: draftText }, { role: "user", content: [{ text: critiqueAsk, cache: true }] }], purpose: "planner", phase: final ? "final_critique" : "critique" }, validateCritique);
  const reviseAsk = `STEP: revise\nRevise the draft: fix every must_fix, keep thread ids and titles unless a fault names them, change the beat only if beat_done is true or the Keeper closed it, keep impulses in character and free of secrets. Fill "changed" with what you changed and why${critique.must_fix.length ? "" : " (nothing, if the critique found no fault)"}. Reply with only the same JSON shape as the draft.`;
  const finalJson = await completeJson(llm, { system, messages: [{ role: "user", content: [...context, { text: draftAsk }] }, { role: "assistant", content: draftText }, { role: "user", content: [{ text: critiqueAsk, cache: true }] }, { role: "assistant", content: JSON.stringify(critique) }, { role: "user", content: reviseAsk }], purpose: "planner", phase: final ? "final_revise" : "revise" }, (x) => { if (!x || typeof x !== "object") throw new Error("expected an object"); return x; });
  const summary = [...critique.must_fix, ...critique.boring, ...critique.contradictions, ...critique.stale].slice(0, 6).join("; ");
  const { arc, nextId: next, rawImpulses, rawBonds } = validateStoryPlan({ ...finalJson, critique: summary }, { mode, prev, nextId, seq: lastSeq, trigger, now });
  if (!calendar) arc.calendar = null;   // a solemn game keeps no date
  if (critique.beat_done === true && finalJson.beat?.title === prev?.beat?.title) arc.verdict = { ...arc.verdict, moveOn: true, why: arc.verdict.why || "the review judged this event done" };
  const impulses = mode === "full" ? validateImpulses(rawImpulses, { coplayers, secrets, version: arc.version, lastSeq, lifetime: impulseLines }) : [];
  const between = final ? validateBetween(finalJson.between ?? draftJson.between, { mode, maxDays: final.maxDays }) : null;
  log(`planner: v${arc.version} (${trigger}) — beat "${arc.beat.title}", ${arc.verdict.moveOn ? "move on" : "continue"}, ${arc.threads.length} thread(s), ${impulses.length} impulse(s)${between ? `, ${between.advanceDays} day(s) pass` : ""}`);
  const tableNotes = table && Array.isArray(finalJson.table_notes) ? finalJson.table_notes.slice(0, 20) : [];
  const reply = table ? String(finalJson.reply ?? "").trim() : "";
  return { arc, impulses, bonds: rawBonds, between, tableNotes, reply, nextId: next, record: { draft: draftJson, critique, final: finalJson } };
}
