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
  };
}

// full: an improvised campaign (plots are the planner's to invent); pace: a module-led one (pace only); off.
export const plannerModeOf = (planner, improv) => (!planner?.on ? "off" : improv?.on ? "full" : "pace");

// Why a plan should be made now, or null. `s` is a snapshot: {on, busy, overBudget, now, lastHumanAt, idleMs, runs,
// lastRunAt, lastRunSeq, lastSeq, arc, asked, scenarioId, plannerScenarioId, stallTurns}.
export function plannerDue(s, cfg) {
  if (!s.on || s.busy || s.overBudget) return null;
  if (s.now - s.lastHumanAt > s.idleMs) return null;                                  // nobody at the table
  if (s.runs.filter((t) => s.now - t < 3600000).length >= cfg.maxRunsPerHour) return null;
  const lines = s.lastSeq - s.lastRunSeq;
  if (!s.arc) return lines >= 10 ? "first" : null;
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
  };
  return { arc, nextId: id, rawImpulses: Array.isArray(x.impulses) ? x.impulses : [] };
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

export function plannerSystem(language, { mode = "full" } = {}) {
  const common = `You are the story planner of a long tabletop roleplaying campaign played in chat. You are not the Keeper (GM) and you never speak in the chat: the Keeper reads your plan and decides; you advise. You read the whole campaign slowly, while the Keeper plays step by step. Your job is the global view: where the story is going, what should happen next, and above all when the current event has run its course, so that nobody stretches a trivial scene over many turns. Prefer closing events over stretching them. Write in ${language}.`;
  const full = `
The campaign is improvised: there is no module. Be bold. Invent original plots, weave several into one situation, raise the stakes, pay off what was planted. Every invention must fit the World setting and every Hidden truth and The world now; record each as a secret twist the Keeper reveals through play, never a fact stated to the players. Keep thread ids across versions; resolve or drop what has gone stale rather than letting it linger.
An impulse is one co-player's own urge, written to that character in the second person, in character ("you want to see the warehouse tonight; the watchman's lie bothers you"). It never reveals a hidden truth or a twist, never mentions a plan, the Keeper, the game or other players as players, and never tells the character what will happen.`;
  const pace = `
The campaign follows a module: the module has the plots. Do not invent plots, people or twists. Judge pace only: name the current event and its exit (what must happen for it to be done, from the script knowledge and the Keeper board), say whether the Keeper should let it go, and what the next beat is according to the module.`;
  return common + (mode === "pace" ? pace : full);
}

const DRAFT_SCHEMA = (mode) => (mode === "pace"
  ? `{"beat": {"title": "...", "purpose": "...", "exit": "what must happen for this event to be done"}, "verdict": {"move_on": false, "why": "..."}, "played": "how the previous plan played out", "changed": "what you changed and why"}`
  : `{"throughline": "what the story is really about and where it heads (≤300 chars)",
 "threads": [{"id": "P1 (keep ids from the previous plan) | new", "title": "...", "status": "seed|live|ripe|resolved|dropped", "stakes": "...", "hooks": ["how the investigators can get into it"], "twist": "the secret turn (for the Keeper)", "ripe_when": "...", "weave_with": "P3 | null"}],
 "beat": {"title": "the current event", "purpose": "...", "exit": "what must happen for this event to be done"},
 "next": [{"what": "the next twist", "when": "..."}],
 "verdict": {"move_on": false, "why": "..."},
 "impulses": [{"who": "<co-player name>", "text": "their own urge, in character, second person"}],
 "played": "how the previous plan played out", "changed": "what you changed and why"}`);

const CRITIQUE = `STEP: critique
You are now a second Keeper, a harsh script editor who did not write the draft above. Read it against everything you were given and find at least three concrete faults, or say explicitly that there are none and why. Look for: what is boring or repetitive; what is implausible, or contradicts the World setting, the Hidden truths or The world now; which threads are stale (untouched for long) and should be resolved, dropped or merged; where two plots can be joined into one situation; whether the current beat has run its course (its exit met, or the players plainly done with it) and the verdict is honest; whether an impulse reveals a secret or talks about the game. Reply with only this JSON:
{"boring": ["..."], "implausible": ["..."], "contradictions": ["..."], "stale": ["..."], "merge": ["..."], "beat_done": true | false | null, "must_fix": ["the changes the revision must make"]}`;

// The planning job: draft, critique, revise, as one growing conversation (the big context is cached once and read
// twice). `contextText` is the Keeper's context plus planner-only blocks; `prev` the previous compact plan.
export async function planStory(llm, { language, mode, contextText, prev, since, coplayers, secrets, nextId, lastSeq, trigger, now, impulseLines, log = () => {} }) {
  const system = plannerSystem(language, { mode });
  const briefing = [
    `## Previous story plan${prev ? ` (v${prev.version}, ${prev.trigger})` : ""}\n${prev ? renderStoryPlan(prev, 4000).split("\n").slice(1).join("\n") : "(none yet: this is the first plan)"}`,
    `## Since the last plan\n${since || "(nothing recorded)"}`,
    mode === "full" ? `## Co-players you may give an impulse\n${coplayers.map((c) => `- ${c.name}`).join("\n") || "(none)"}` : "",
  ].filter(Boolean).join("\n\n");
  const draftAsk = `STEP: draft\nWrite the story plan now${trigger ? ` (why you were asked: ${trigger})` : ""}. Reply with only this JSON:\n${DRAFT_SCHEMA(mode)}`;
  const context = [{ text: `${contextText}\n\n${briefing}\n\n`, cache: true }];
  const draftJson = await completeJson(llm, { system, user: [...context, { text: draftAsk }], purpose: "planner" }, (x) => { if (!x || typeof x !== "object") throw new Error("expected an object"); return x; });
  const draftText = JSON.stringify(draftJson);
  const critique = await completeJson(llm, { system, messages: [{ role: "user", content: [...context, { text: draftAsk }] }, { role: "assistant", content: draftText }, { role: "user", content: [{ text: CRITIQUE, cache: true }] }], purpose: "planner" }, validateCritique);
  const reviseAsk = `STEP: revise\nRevise the draft: fix every must_fix, keep thread ids and titles unless a fault names them, change the beat only if beat_done is true or the Keeper closed it, keep impulses in character and free of secrets. Fill "changed" with what you changed and why${critique.must_fix.length ? "" : " (nothing, if the critique found no fault)"}. Reply with only the same JSON shape as the draft.`;
  const finalJson = await completeJson(llm, { system, messages: [{ role: "user", content: [...context, { text: draftAsk }] }, { role: "assistant", content: draftText }, { role: "user", content: [{ text: CRITIQUE, cache: true }] }, { role: "assistant", content: JSON.stringify(critique) }, { role: "user", content: reviseAsk }], purpose: "planner" }, (x) => { if (!x || typeof x !== "object") throw new Error("expected an object"); return x; });
  const summary = [...critique.must_fix, ...critique.boring, ...critique.contradictions, ...critique.stale].slice(0, 6).join("; ");
  const { arc, nextId: next, rawImpulses } = validateStoryPlan({ ...finalJson, critique: summary }, { mode, prev, nextId, seq: lastSeq, trigger, now });
  if (critique.beat_done === true && finalJson.beat?.title === prev?.beat?.title) arc.verdict = { ...arc.verdict, moveOn: true, why: arc.verdict.why || "the review judged this event done" };
  const impulses = mode === "full" ? validateImpulses(rawImpulses, { coplayers, secrets, version: arc.version, lastSeq, lifetime: impulseLines }) : [];
  log(`planner: v${arc.version} (${trigger}) — beat "${arc.beat.title}", ${arc.verdict.moveOn ? "move on" : "continue"}, ${arc.threads.length} thread(s), ${impulses.length} impulse(s)`);
  return { arc, impulses, nextId: next, record: { draft: draftJson, critique, final: finalJson } };
}
