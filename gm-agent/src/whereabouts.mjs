// Whereabouts: the GM reports where investigators are; the table decides what that means for timelines and windows.
//
// Each GM round may return `whereabouts`: groups of investigators with the thread they are now with (a handle such
// as "T0", or "new" for a place no thread is at), the place, and whether they are out of reach of the others and can
// explore on their own (`own_scene`). Anyone not listed stays where they are. `planWhereabouts` turns those facts into
// operations (move, merge, split, relocate) with fixed, testable rules:
//
//   * authority  – a player character moves only because its own player said so in this turn's lines in this window;
//                  co-players move only after their own lines (followup and side rounds). The GM decides for no one;
//   * guard      – an unsupported reversal needs two agreeing turns; a fresh verified choice is never deferred;
//   * places     – "new" at the place you already are is no move; "new" at another thread's place joins that thread;
//   * the scene  – a thread is never emptied by a split: if everyone in it leaves for one place it simply relocates;
//                  the main timeline keeps the players (co-players left behind get a side window of their own);
//   * reunions   – scene forks (cfg.sceneForks): a later arrival joins the earlier party's window; the primary
//                  timeline can rebind to that window. Without them: reunions always land in the main timeline (the
//                  Main Chat), where every player already is;
//   * new scene  – scene forks: simultaneous convergence forks the source with the most distinct human players;
//   * privacy    – scene forks: the harness pauses departing humans and resumes/adds arriving humans before
//                  narrating; pauses leave permanent gaps, while co-players keep their seat-based context boundaries.
//                  Without them nobody is ever added to an existing window (its whole history would open to them):
//                  joining a thread whose window lacks a joining player regroups the thread into a fresh window, and a
//                  player who leaves a thread others stay in stops seeing it (those who stay move to a fresh window);
//   * caps       – at most TIMELINE_MAX_ACTIVE active threads; a player gets a new window at most once per cooldown
//                  (both counted on real new windows only, after the rules above).
//
// The planner is pure: it reads timelines, guard and the scene, and returns the operations plus guard updates.
import { MAIN, placeKey } from "./timelines.mjs";

const truthy = (v) => v === true || /^(true|yes|1)$/i.test(String(v ?? ""));
const clip = (s, n) => String(s ?? "").trim().slice(0, n);

export function validateWhereabouts(x) {
  if (!Array.isArray(x)) return [];
  const out = [];
  for (const e of x.slice(0, 8)) {
    if (!e || typeof e !== "object") continue;
    const who = (Array.isArray(e.who) ? e.who : [e.who]).map((n) => clip(n, 80)).filter(Boolean);
    const thread = String(e.thread ?? "").trim().toUpperCase();
    if (!who.length || !(thread === "NEW" || /^T\d+$/.test(thread))) continue;
    const place = clip(e.place, 120);
    if (thread === "NEW" && !place) continue;
    out.push({ who, thread, place, ownScene: truthy(e.own_scene), span: String(e.span ?? "").toLowerCase() === "long" ? "long" : "short", time: clip(e.time, 120), opening: clip(e.opening, 1200) });
  }
  return out;
}

// Per-investigator bookkeeping against flip-flopping, persisted with the state file.
export class Guard {
  constructor(data = {}) {
    this.turn = Number(data.turn) || 0;
    this.by = { ...(data.by ?? {}) };
    this.spare = Array.isArray(data.spare) ? [...data.spare] : [];
    this.retries = { ...(data.retries ?? {}) };
  }
  toJSON() { return { turn: this.turn, by: this.by, spare: this.spare, retries: this.retries }; }
  beginTurn() { return ++this.turn; }
  rec(id) { return this.by[id] ?? { obs: 0, lastObsTurn: null, changedTurn: null, changedAt: 0, changedSeq: 0, prev: null, pending: null, windowAt: 0 }; }
  apply(updates) { for (const [id, r] of Object.entries(updates)) this.by[id] = r; }
  commit(changed, { turn, now, seq, prevOf, windowed = [] }) {
    for (const id of changed) this.by[id] = { ...this.rec(id), obs: 0, lastObsTurn: turn, changedTurn: turn, changedAt: now, changedSeq: seq, prev: prevOf(id), pending: null };
    for (const id of windowed) this.by[id] = { ...this.rec(id), windowAt: now };
  }
}

// The facts the GM is shown before it reports: threads with their handles, places and spans, and who may move.
export function whereaboutsBrief({ timelines, scene, nameOf, windowName, isPc, mayMove = [], capReached = false, forks = false }) {
  const lines = ["## Whereabouts"];
  for (const t of timelines.active()) {
    const here = scene?.timeline?.id === t.id ? " ← this scene" : "";
    const where = t.windowId ? `in window "${windowName(t.windowId)}"` : t.id === MAIN ? (forks ? "in the Main Chat (before the first split)" : "in the Main Chat") : "";
    const who = t.members.map((id) => `${nameOf(id)} (${isPc(id) ? "player" : "co-player"})`).join(", ") || "(no one)";
    lines.push(`- T${t.handle} "${t.name}"${here} ${where}${t.location ? `, at ${t.location}` : ""}${t.id === MAIN ? "" : `, ${t.span} split`}: ${who}`);
  }
  lines.push(`May move this turn: ${mayMove.map(nameOf).join(", ") || "(no one)"}.`);
  lines.push("Open a separate scene promptly when a character clearly chooses an independent destination. Their own departure is enough; do not wait for repeated confirmation or narrate arrival first. Check each traveller and agreed companion individually. Different classrooms, homes and independent activities can be separate scenes even nearby; a shared corridor on the same journey is not. Unclear company never cancels another character's clear solo departure.");
  if (capReached) lines.push("No new independent scene can open now (too many threads at once). Still report reunions and the whole party moving together: these do not need another thread.");
  return lines.join("\n");
}

// reports: validated whereabouts. scene: {timeline, windowId} (timeline null outside any thread's window).
// scopeIds: who may be reported this round. speakers: player characters whose player posted in this turn's lines here.
export function planWhereabouts({ timelines, scene, reports, scopeIds, speakers = new Set(), verifiedCompanions = false, decisionSeqs = new Map(), passiveFollowers = new Set(), mode, resolve, isPc, userOf = () => null, windowUsers = () => [], guard, turn, now, cfg }) {
  const forks = Boolean(cfg?.sceneForks);
  const ignored = [];
  const updates = {};
  const rec = (id) => updates[id] ?? guard.rec(id);
  const before = new Map();
  for (const t of timelines.active()) for (const id of t.members) before.set(id, t.id);
  const curOf = (id) => before.get(id) ?? MAIN;
  if (!scene?.timeline || !reports?.length) return observeOnly();

  // Reconciliation records co-presence that has already happened, rather than authorising new travel.
  const override = mode === "manual" || mode === "correction" || mode === "presence";

  // 1. Resolve names and targets.
  const claimed = new Set();
  const decisions = new Map();          // id → {kind:'tl', id} | {kind:'new', key}
  const groups = new Map();             // key → {place, time, span, opening, ids:[]}
  for (const e of reports) {
    const ids = e.who.map(resolve).filter((id) => id && scopeIds.has(id) && !claimed.has(id));
    ids.forEach((id) => claimed.add(id));
    for (const id of ids) {
      let target = null;
      if (e.thread === "NEW") {
        if (!e.ownScene) continue;                                        // a step aside
        const cur = timelines.get(curOf(id));
        if (placeKey(cur?.location) && placeKey(cur.location) === placeKey(e.place)) continue;   // already there
        const there = timelines.atPlace(e.place);
        if (there) target = { kind: "tl", id: there.id };
        else {
          const key = `new:${placeKey(e.place)}`;
          if (!groups.has(key)) groups.set(key, { key, place: e.place, time: e.time, span: e.span, opening: e.opening, ids: [] });
          target = { kind: "new", key };
        }
      } else {
        const t = timelines.byHandle(e.thread);
        if (!t || t.status !== "active") { ignored.push({ id, why: `unknown thread ${e.thread}` }); continue; }
        target = { kind: "tl", id: t.id };
      }
      if (target.kind === "tl" && target.id === curOf(id)) continue;
      // 2. Authority.
      if (!override && isPc(id)) {
        if (!(verifiedCompanions && passiveFollowers.has(id)) && (!["human", "relay"].includes(mode) || !speakers.has(id))) { ignored.push({ id, why: "a player character moves only when its player says so" }); continue; }
      } else if (!override && !verifiedCompanions && !["followup", "side"].includes(mode)) { ignored.push({ id, why: "a co-player moves only after its own line" }); continue; }
      // 3. Guard (players' own moves are exempt).
      if (!isPc(id) && !override) {
        const r = rec(id);
        const key = target.kind === "tl" ? `tl:${target.id}` : target.key;
        const recent = r.changedTurn !== null && (r.obs < cfg.timelineGuardTurns || now - r.changedAt < cfg.timelineGuardMs);
        const explicit = Number.isFinite(decisionSeqs.get(id)) && decisionSeqs.get(id) > r.changedSeq;
        if (recent && !explicit) {
          const agreed = r.pending && r.pending.key === key && r.pending.turn > r.changedTurn && r.pending.turn < turn;
          if (!agreed) {
            updates[id] = { ...r, pending: r.pending?.key === key && r.pending.turn > r.changedTurn ? r.pending : { key, turn } };
            ignored.push({ id, why: "deferred: it moved a moment ago" });
            continue;
          }
        }
      }
      decisions.set(id, target);
      if (target.kind === "new") groups.get(target.key).ids.push(id);
    }
  }
  for (const [key, g] of groups) if (!g.ids.length) groups.delete(key);

  // 5. Normalise.
  const ops = { moves: new Map(), merges: [], splits: [], relocations: [], bindings: [] };
  const relocate = (timeline, g) => ops.relocations.push({ timeline, location: g.place ?? g.location, narrativeTime: g.time ?? g.narrativeTime ?? "" });
  const keep = (F, key) => {                                   // timeline F takes group `key` instead of a new window
    const g = groups.get(key);
    for (const id of g.ids) { if (curOf(id) === F.id) decisions.delete(id); else decisions.set(id, { kind: "tl", id: F.id }); }
    relocate(F.id, g);
    groups.delete(key);
  };
  const pcsIn = (ids) => ids.filter(isPc).length;
  const sources = [timelines.main(), ...timelines.active().filter((t) => t.id !== MAIN)];
  // A passive PC may follow a companion from its own scene, never move alone.
  for (const id of passiveFollowers) {
    const target = decisions.get(id);
    if (!target) continue;
    const companion = [...decisions].some(([other, dest]) => other !== id && !passiveFollowers.has(other) && curOf(other) === curOf(id) && JSON.stringify(dest) === JSON.stringify(target));
    if (!companion) { decisions.delete(id); for (const group of groups.values()) group.ids = group.ids.filter(x => x !== id); ignored.push({ id, why: "a passive character cannot move alone" }); }
  }
  for (const F of sources) {
    const leavers = F.members.filter((id) => decisions.has(id));
    if (!leavers.length) continue;
    const remaining = F.members.filter((id) => !decisions.has(id));
    const leaverKeys = [...new Set(leavers.map((id) => decisions.get(id)).filter((d) => d.kind === "new").map((d) => d.key))];
    if (!remaining.length && leaverKeys.length) {
      // (a) The scene is never emptied by a split: the group with the most players (then the largest) keeps it.
      const best = leaverKeys.map((k) => groups.get(k)).sort((a, b) => pcsIn(b.ids) - pcsIn(a.ids) || b.ids.length - a.ids.length || leaverKeys.indexOf(a.key) - leaverKeys.indexOf(b.key))[0];
      if (!forks || best.ids.every(id => curOf(id) === F.id)) keep(F, best.key);
      continue;
    }
    if (F.id === MAIN && remaining.length && !pcsIn(remaining) && pcsIn(F.members) && leaverKeys.length === 1 && F.members.filter(isPc).every((id) => decisions.get(id)?.key === leaverKeys[0])) {
      // (b) The Main Chat goes with its players; the co-players who stayed get a side window where the party was.
      const stayKey = `new:${placeKey(F.location) || "where the party was"}#stay`;
      groups.set(stayKey, { key: stayKey, place: F.location || "where the party was", time: F.narrativeTime, span: "short", opening: "", ids: [...remaining] });
      for (const id of remaining) decisions.set(id, { kind: "new", key: stayKey });
      keep(F, leaverKeys[0]);
      continue;
    }
    if (!forks && F.id !== MAIN && remaining.length && leavers.some(isPc) && F.windowId) {
      // (d) Without scene forks, a player leaves a thread others stay in: those who stay continue in a fresh window, so
      // the leaver does not keep reading a scene their character has left.
      const key = `regroup:${F.id}`;
      if (!groups.has(key)) groups.set(key, { key, place: F.location, time: F.narrativeTime, span: F.span, opening: "", ids: [...remaining], replaces: F.id, stay: true });
      for (const id of remaining) decisions.set(id, { kind: "new", key });
      continue;
    }
    if (F.id === MAIN && !remaining.length) {
      // (c) Everyone in the main timeline went to existing threads: the reunion lands in the main timeline.
      const counts = new Map();
      for (const id of leavers) { const d = decisions.get(id); if (d.kind === "tl") counts.set(d.id, (counts.get(d.id) ?? 0) + 1); }
      const X = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (X) {
        for (const id of leavers) if (decisions.get(id)?.id === X) decisions.delete(id);
        const xt = timelines.get(X);
        if (forks && xt.windowId) ops.bindings.push({ op: "bind_main", windowId: xt.windowId });
        ops.merges.push({ from: X, into: MAIN });
        relocate(MAIN, { place: xt.location, time: xt.narrativeTime });
      }
    }
  }

  // 6. With scene forks, ongoing scenes keep their window: the harness pauses departed humans and resumes/adds
  // arrivals; the server's visibility periods preserve each reader's actual history. Without them, joining a thread
  // whose window lacks a joining player's user regroups that thread into a fresh window.
  const merged = new Set(ops.merges.map(m => m.from));
  if (!forks) {
    for (const [id, d] of [...decisions]) {
      if (d.kind !== "tl" || d.id === MAIN || merged.has(d.id) || !isPc(id)) continue;
      const X = timelines.get(d.id);
      const users = new Set(windowUsers(X.windowId));
      if (users.has(userOf(id))) continue;
      const key = `regroup:${X.id}`;
      if (!groups.has(key)) groups.set(key, { key, place: X.location, time: X.narrativeTime, span: X.span, opening: "", ids: X.members.filter((m) => !decisions.has(m)), replaces: X.id });
      groups.get(key).ids.push(id);
      decisions.set(id, { kind: "new", key });
    }
    for (const [id, d] of [...decisions]) {
      if (d.kind === "tl" && groups.has(`regroup:${d.id}`)) { decisions.set(id, { kind: "new", key: `regroup:${d.id}` }); groups.get(`regroup:${d.id}`).ids.push(id); }
    }
  }

  // 7. Limits on real new windows only (a relocation opens none): a player gets a new window at most once per cooldown,
  // and at most TIMELINE_MAX_ACTIVE threads exist. A refused group's departure is cancelled as a whole, so nobody is
  // split off alone from companions who were meant to go with them. Groups that only keep a scene going (regroups of
  // those who stay) are never refused.
  const refuse = (g, why) => {
    for (const id of g.ids) { if (decisions.get(id)?.key === g.key) decisions.delete(id); ignored.push({ id, why }); }
    groups.delete(g.key);
  };
  if (!override) {
    for (const g of [...groups.values()]) {
      if (g.stay) continue;
      const cooling = g.ids.find((id) => isPc(id) && rec(id).windowAt && now - rec(id).windowAt < cfg.timelinePcCooldownMs);
      if (cooling) refuse(g, "a new scene for this player opened moments ago");
    }
  }
  const replacedCount = [...groups.values()].filter((g) => g.replaces).length;
  let room = Math.max(0, cfg.timelineMaxActive - timelines.active().length + replacedCount);
  for (const g of [...groups.values()]) {
    if (g.replaces) { room--; continue; }
    if (room > 0) { room--; continue; }
    refuse(g, "too many threads at once");
  }

  // Moves into existing threads.
  for (const [id, d] of decisions) if (d.kind === "tl") { if (!ops.moves.has(d.id)) ops.moves.set(d.id, []); ops.moves.get(d.id).push(id); }
  // New threads.
  for (const g of groups.values()) {
    const sources = [...new Set(g.ids.map(curOf))];
    const players = id => new Set((timelines.get(id)?.members ?? []).filter(isPc).map(userOf).filter(Boolean)).size;
    const from = forks
      ? sources.sort((a,b) => players(b)-players(a) || (timelines.get(a)?.handle ?? 0)-(timelines.get(b)?.handle ?? 0))[0] ?? MAIN
      : g.ids.map(curOf).sort((a, b) => g.ids.filter((x) => curOf(x) === b).length - g.ids.filter((x) => curOf(x) === a).length)[0] ?? MAIN;
    const primary = forks && sources.length > 1 && timelines.main().members.length > 0 && timelines.main().members.every(id => g.ids.includes(id));
    ops.splits.push({ ids: [...new Set(g.ids)], place: g.place, time: g.time, span: g.span, opening: g.opening, fromTimeline: from, replaces: g.replaces ?? null, ...(primary ? { primary: true } : {}) });
  }

  // Threads left empty are merged into where most of their members went (or the main timeline); if only one thread
  // still has anyone and it is not the main one, it comes back to the Main Chat (collapse).
  const after = new Map(before);
  for (const [to, ids] of ops.moves) for (const id of ids) after.set(id, to);
  for (const m of ops.merges) for (const [id, t] of after) if (t === m.from) after.set(id, m.into);
  for (const s of ops.splits) for (const id of s.ids) after.set(id, s.primary ? MAIN : `split:${s.place}`);
  for (const t of timelines.active()) {
    if (t.id === MAIN || merged.has(t.id) || ops.splits.some((s) => s.replaces === t.id)) continue;
    if ([...after.values()].includes(t.id)) continue;
    const dests = t.members.map((id) => after.get(id)).filter((x) => x && !String(x).startsWith("split:"));
    const into = dests.sort((a, b) => dests.filter((x) => x === b).length - dests.filter((x) => x === a).length)[0] ?? MAIN;
    ops.merges.push({ from: t.id, into: timelines.get(into)?.status === "active" ? into : MAIN });
    merged.add(t.id);
  }
  const live = new Set([...after.values()].filter((x) => !merged.has(x)));
  if (!live.has(MAIN) && live.size === 1 && !ops.splits.length) {
    const only = [...live][0];
    const t = timelines.get(only);
    if (t && t.id !== MAIN) { ops.merges.push({ from: t.id, into: MAIN }); relocate(MAIN, { place: t.location, time: t.narrativeTime }); if (forks && t.windowId) ops.bindings.push({ op: "bind_main", windowId: t.windowId }); merged.add(t.id); }
  }
  // Deduplicate merges by source.
  const seenFrom = new Set();
  ops.merges = ops.merges.filter((m) => (seenFrom.has(m.from) ? false : seenFrom.add(m.from)));

  const changed = new Set([...decisions.keys()]);
  for (const m of ops.merges) for (const id of timelines.get(m.from)?.members ?? []) changed.add(id);
  for (const s of ops.splits) for (const id of s.ids) changed.add(id);
  observe(changed);
  // Splits are applied before merges, so a thread emptied by a departure is merged empty (no false reunion).
  const list = [
    ...[...ops.moves].map(([to, ids]) => ({ op: "move", ids, to })),
    ...ops.splits.map((s) => ({ op: "split", ...s })),
    ...ops.merges.map((m) => ({ op: "merge", ...m })),
    ...ops.relocations.map((r) => ({ op: "relocate", ...r })),
    ...ops.bindings,
  ];
  return { ops: list, changed: [...changed], ignored, guard: updates, prevOf: curOf };

  function observe(changedIds) {
    for (const id of scopeIds) {
      if (changedIds.has(id)) continue;
      const r = rec(id);
      if (r.lastObsTurn === turn || (r.changedTurn !== null && turn <= r.changedTurn)) continue;
      updates[id] = { ...r, obs: r.obs + 1, lastObsTurn: turn };
    }
  }
  function observeOnly() { observe(new Set()); return { ops: [], changed: [], ignored, guard: updates, prevOf: curOf }; }
}
