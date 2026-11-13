import { parseClock, formatClock } from "../calendar.mjs";
// windows: table is the explicit runtime context supplied by Table; no service singleton.
import { sceneForks } from "../sceneForks.mjs";
import { randomUUID } from "node:crypto";
import { investigatorsFor } from "../context/profiles.mjs";
import { Timelines, MAIN, placeKey } from "../timelines.mjs";
import { correctionNotice, publicLines, readDestinations, sceneHandoff } from "../continuity.mjs";
import { readPresence } from "../presence.mjs";
import { planWhereabouts } from "../whereabouts.mjs";
import { hashText } from "../improv.mjs";
import { norm, names } from "./shared.mjs";

export function partitionPlan(table, ops) { return table.forks ? sceneForks(table.timelines, ops, { windowOf: t => table.windowOf(t) }) : ops; }

export async function archiveRetired(table) {
    if (!table.forks) return;      // retired windows are kept for the same people at the same place
    for (const w of table.windows) if (w.kind !== "main" && !w.archived_at && table.timelines.retired(w.id)) {
      await table.api.updateWindow(table.channelId, w.id, { archived: true });
      w.archived_at = new Date(table.now()).toISOString();
    }
  }

export function windowUsers(table, windowId) { return (table.windows.find((w) => w.id === windowId)?.members ?? []).filter(m => !m.visibility_paused).map((m) => m.user_id).filter((u) => u && u !== table.me?.id); }

export async function applyAudience(table, actions) {
    const turn = table.turnScope.getStore();
    if (actions.length && turn?.running) turn.audience.push(...actions.map((a) => ({ ...a })));
    for (const action of actions) {
      const win = table.windows.find(w => w.id === action.windowId);
      const member = win?.members?.find(m => m.user_id === action.userId);
      if (!member && action.paused) continue;
      if (!member) await table.api.addWindowMember(table.channelId, action.windowId, { user_id: action.userId, character_id: action.characterId });
      else if (!!member.visibility_paused !== action.paused) await table.api.setWindowVisibility(table.channelId, action.windowId, action.userId, action.paused);
    }
    if (actions.length) await table.refresh();
  }

export function presenceThreads(table) {
    const hidden = table.hiddenLines();
    return table.timelines.active().filter(t => t.members.length).map(t => {
      // Reused side windows must not supply records from the previous scene that occupied them.
      const start = t.id === MAIN ? 0 : table.timelines.log.find(e => e.timelineId === t.id)?.fromSeq ?? 0;
      const lines = table.sceneHistory(table.windowOf(t)).filter(m => m.seq >= start)
        .filter(m => m.visibility === "window" && !hidden.has(m.id) && ["ic", "narration", "ooc"].includes(m.kind) &&
          (!m.character_id || table.timelines.timelineAt(m.character_id, m.seq).id === t.id))
        .slice(-40).map(m => ({ seq: m.seq, actor: m.character_id || null, kind: m.kind,
          keeper: m.author_role === "gm" && !m.character_id && m.kind === "narration",
          speaker: m.character_name || m.author_name || "GM", text: m.content }));
      return { key: "T" + t.handle, location: t.location, time: t.narrativeTime,
        members: t.members.map(id => ({ id, name: table.nameOf(id) })), lines };
    });
  }

export async function reconcilePresence(table, windowId, turn) {
    const scene = table.scene(windowId);
    const threads = table.presenceThreads();
    if (!scene || threads.length < 2) return;
    const current = "T" + scene.handle;
    const digest = hashText(JSON.stringify(threads));
    if (table.presenceChecked?.get(current) === digest) return;
    let placements;
    try { placements = await readPresence(table.llm, { current, threads }); }
    catch (e) { table.generation.signal.throwIfAborted(); table.log("scene presence: " + e.message); return; }
    table.generation.signal.throwIfAborted();
    // A newer correction/departure received while the model was thinking invalidates its snapshot.
    if (hashText(JSON.stringify(table.presenceThreads())) !== digest) return;
    (table.presenceChecked ??= new Map()).set(current, digest);
    if (!placements.length) return;
    const result = planWhereabouts({ timelines: table.timelines, scene: { timeline: scene, windowId },
      reports: placements.map(p => ({ who: [table.nameOf(p.id)], thread: p.thread })),
      scopeIds: new Set(placements.map(p => p.id)), mode: "presence", resolve: n => table.investigatorByName(n),
      isPc: id => table.isPc(id), userOf: id => table.userOf(id), windowUsers: w => table.windowUsers(w),
      guard: table.guard, turn, now: table.now(), cfg: table.cfg });
    // If an entire thread is folded into the Main Chat, keep the confirmed room instead of its stale label.
    for (const p of placements) {
      const destination = table.timelines.byHandle(p.thread);
      const regroup = result.ops.find(o => o.op === "split" && o.replaces === destination.id && o.ids.includes(p.id));
      if (regroup) { regroup.place = p.place; continue; }
      const merged = result.ops.find(o => o.op === "merge" && o.from === destination.id);
      const final = merged?.into || destination.id;
      const relocation = result.ops.find(o => o.op === "relocate" && o.timeline === final);
      if (relocation) relocation.location = p.place;
      else if (result.ops.some(o => o.op === "move" && o.to === final && o.ids.includes(p.id)))
        result.ops.push({ op: "relocate", timeline: final, location: p.place });
    }
    table.log("scene presence: " + placements.map(p => `${table.nameOf(p.id)} joins ${table.nameOf(p.with)} at ${p.place} (#${p.actorSeq}, #${p.targetSeq})`).join("; "));
    await table.applyPlan(result, { windowId, mode: "presence", turn });
  }

export async function checkDestinations(table, windowId, reports, scope, batch, mode) {
    const messages = table.history.lines(windowId).filter(m => m.visibility === "window");
    const lines = publicLines(messages);
    const actors = [];
    for (const id of scope) {
      const pc = table.isPc(id);
      if (pc && !["relay", "human"].includes(mode)) continue;
      const sources = pc ? batch.filter(l => l.id === id).map(l => l.seq) : messages.filter(m =>
        m.character_id === id && m.kind === "ic" && m.seq > table.guard.rec(id).changedSeq &&
        table.timelines.timelineAt(id, m.seq).id === table.timelines.of(id).id).map(m => m.seq);
      for (const l of batch.filter(l => l.id === id)) {
        if (!lines.some(m => m.seq === l.seq)) lines.push({ seq: l.seq, speaker: table.nameOf(id), text: l.content, kind: "ic" });
      }
      // A quiet character's last decision can precede a busy window's recent tail.
      for (const seq of sources.slice(-6)) {
        if (lines.some(l => l.seq === seq)) continue;
        const at = messages.findIndex(m => m.seq === seq);
        if (at >= 0) for (const l of publicLines(messages.slice(Math.max(0, at - 2), at + 1))) {
          if (!lines.some(existing => existing.seq === l.seq)) lines.push(l);
        }
      }
      const present = sources.filter(seq => lines.some(l => l.seq === seq));
      if (present.length) actors.push({ id, name: table.nameOf(id), sources: present });
    }
    lines.sort((a, b) => a.seq - b.seq);
    const options = new Map();
    for (const report of reports) {
      const key = report.thread === "NEW" ? "new:" + placeKey(report.place) : report.thread;
      if (!options.has(key)) options.set(key, report);
    }
    const destinations = [...options].map(([key, r]) => {
      const t = table.timelines.byHandle(key);
      return { key, place: t?.location || r.place || t?.name, companions: t?.members.map(id => table.nameOf(id)),
        recent: t ? publicLines(table.history.lines(table.windowOf(t)).filter(m => !table.hiddenLines().has(m.id))).slice(-16) : [] };
    });
    let decisions = [];
    try { decisions = await readDestinations(table.llm, { lines, actors, destinations }); }
    catch (e) { table.log("movement evidence: " + e.message); }
    const checked = [], ignored = [];
    let disputed = false;
    for (const [key, r] of options) {
      const who = decisions.filter(m => m.destination === key).map(m => table.nameOf(m.id));
      if (table.dailyOn()) {
        for (const name of r.who ?? []) {
          const id = table.investigatorByName(name);
          if (id && table.isPassive(id) && who.some(n => { const companion = table.investigatorByName(n); return companion !== id && !table.isPassive(companion) && table.timelines.of(companion).id === table.timelines.of(id).id; })) who.push(table.nameOf(id));
        }
      }
      const proposed = reports.filter(other => other.thread === r.thread && (r.thread !== "NEW" || placeKey(other.place) === placeKey(r.place))).flatMap(other => other.who);
      const target = r.thread === "NEW" ? table.timelines.atPlace(r.place) : table.timelines.byHandle(r.thread);
      const missing = proposed.map(n => table.investigatorByName(n)).filter(id => id &&
        table.timelines.of(id) !== target && !who.includes(table.nameOf(id)));
      const changed = missing.length > 0 || who.some(name => !proposed.some(n => table.investigatorByName(n) === table.investigatorByName(name)));
      disputed ||= changed;
      for (const id of missing) ignored.push({ id, why: "their own latest decision does not support this destination" });
      if (who.length) checked.push({ ...r, who, opening: changed ? "" : r.opening });
    }
    return { reports: checked, ignored, disputed };
  }

export async function correctPlacement(table, message) {
    const threads = table.timelines.active();
    const allowed = threads.filter(t => table.windowUsers(table.windowOf(t)).includes(message.author_id) ||
      t.members.some(id => table.isPc(id) && table.userOf(id) === message.author_id));
    if (!allowed.length) return;
    const actors = threads.flatMap(t => t.members).filter(id => table.roster.isCoplayer(id) || table.userOf(id) === message.author_id)
      .map(id => ({ id, name: table.nameOf(id), sources: [message.seq], current: "T" + table.timelines.of(id).handle }));
    const destinations = threads.map(t => ({ key: "T" + t.handle, place: t.location || t.name, companions: t.members.map(id => table.nameOf(id)) }));
    const lines = publicLines(table.history.lines(message.chat_window_id).filter(m => m.seq <= message.seq && !table.artLines.has(m.id))).slice(-24);
    const decisions = await readDestinations(table.llm, { lines, actors, destinations, correction: message.seq });
    const reports = [];
    for (const m of decisions) {
      const target = table.timelines.byHandle(m.destination), from = table.timelines.of(m.id);
      if (m.destination === "NEW") {
        if (!allowed.includes(from) || table.timelines.atPlace(m.place)) continue;
      } else {
        const restoringPrevious = allowed.includes(from) && table.guard.rec(m.id).prev === target.id;
        if (target === from || (!allowed.includes(target) && !restoringPrevious)) continue;
      }
      if ((table.guard.rec(m.id).correctionSeq ?? 0) >= message.seq) continue;
      reports.push({ who: [table.nameOf(m.id)], thread: m.destination, place: m.place, ownScene: true, span: "short" });
    }
    if (!reports.length) return;
    const scene = table.scene(message.chat_window_id) || allowed[0];
    const turn = table.guard.beginTurn();
    const result = planWhereabouts({ timelines: table.timelines, scene: { timeline: scene }, reports,
      scopeIds: new Set(decisions.map(m => m.id)), mode: "correction", resolve: n => table.investigatorByName(n),
      isPc: id => table.isPc(id), userOf: id => table.userOf(id), windowUsers: w => table.windowUsers(w),
      guard: table.guard, turn, now: table.now(), cfg: table.cfg });
    await table.applyPlan(result, { windowId: message.chat_window_id, mode: "correction", turn, correctionSeq: message.seq });
  }

export async function postHandoff(table, windowId, time, upTo) {
    const hidden = table.hiddenLines();
    const t = table.scene(windowId);
    // Side windows can be reused for a different scene. Old occupants' lines belong to their earlier stay.
    const start = t && t.id !== MAIN ? table.timelines.log.find(e => e.timelineId === t.id)?.fromSeq ?? 0 : 0;
    const messages = table.history.lines(windowId, { after: Math.max(0, start - 1), upTo }).filter(m => !hidden.has(m.id));
    const body = await sceneHandoff(table.llm, { messages, time, language: table.language, log: table.log });
    return table.post(windowId, body);
  }

export function presentPlayers(table, windowId) {
    const scene = table.scene(windowId);
    if (scene) return scene.members.filter((id) => table.isPc(id));
    return (table.windows.find((w) => w.id === windowId)?.members ?? []).filter((m) => m.user_id !== table.me?.id).map((m) => m.character_id);
  }

export async function channelUsers(table) { return (await table.channelMemberRows()).users; }

export async function channelMemberRows(table) {
    if (!table.memberCache || table.now() - table.memberCache.at > 60000) {
      const rows = (await table.api.channelMembers(table.channelId).catch(() => null)) ?? null;
      table.memberCache = { at: table.now(), rows, users: rows ? new Set(rows.map((r) => r.id ?? r.user_id)) : null };
    }
    return table.memberCache;
  }

export async function forkScenes(table, ops, { opId, mode, correctionSeq, result, windowId }) {
    for (const [i, o] of ops.entries()) if (["split", "fork_main"].includes(o.op)) {
      o.parentWindowId ??= table.windowOf(table.timelines.get(o.replaces || o.fromTimeline) ?? table.timelines.main());
      o.requestId ??= `scene:${opId}:${i}`;
    }
    table.journal = { opId, mode, correctionSeq, ops, changed: result.changed, windowId, created: [], phase: "A" };
    table.save();
    const users = await table.channelUsers();
    const windowFor = new Map();
    for (const o of ops.filter(o => ["split", "fork_main"].includes(o.op))) {
      if (o.legacyWindowId) { windowFor.set(o, o.legacyWindowId); continue; }
      const pcs = o.ids.filter(id => table.isPc(id));
      const members = [];
      for (const id of pcs) {
        const user_id = table.userOf(id);
        if (!user_id || (users && !users.has(user_id))) throw Error("Cannot fork a scene for someone outside this channel");
        if (!members.some(m => m.user_id === user_id)) members.push({ user_id, character_id: id });
      }
      const w = await table.api.forkWindow(table.channelId, o.parentWindowId, {
        name: `${pcs.length ? "Scene" : "Side"}: ${String(o.place).slice(0, 60)}`, kind: "group", members, request_id: o.requestId,
      });
      windowFor.set(o, w.id);
      table.journal.created.push({ windowId: w.id });
      table.save();
    }
    return windowFor;
  }

export async function openSceneWindows(table, ops, { mode, correctionSeq, result, windowId, turn, lastSeq, dropped, factOf }) {
    table.journal = { opId: `${turn}-${lastSeq}`, mode, correctionSeq, ops, changed: result.changed, windowId, created: [], phase: "A" };
    table.save();
    const users = await table.channelUsers();
    const windowFor = new Map();
    const reusedSpares = [];
    for (const s of ops.filter((o) => o.op === "split" && !o.skip)) {
      const pcs = s.ids.filter((id) => table.isPc(id));
      const seatable = pcs.filter((id) => table.userOf(id) && (!users || users.has(table.userOf(id))));
      for (const id of pcs.filter((p) => !seatable.includes(p))) { s.ids = s.ids.filter((x) => x !== id); dropped.push({ id, why: "not a channel member, so no window can seat them" }); }
      if (!s.ids.length) { s.skip = true; continue; }
      const wantUsers = [...new Set(seatable.map((id) => table.userOf(id)))].sort();
      const key = placeKey(s.place);
      const spare = table.guard.spare.find((x) => x.placeKey === key && JSON.stringify([...x.users].sort()) === JSON.stringify(wantUsers));
      const retired = table.windows.find((w) => !w.archived_at && table.timelines.retired(w.id) && placeKey(table.timelines.ofWindow(w.id)?.location) === key && JSON.stringify(table.windowUsers(w.id).sort()) === JSON.stringify(wantUsers));
      if (spare) { windowFor.set(s, spare.windowId); table.guard.spare = table.guard.spare.filter((x) => x !== spare); reusedSpares.push(spare); continue; }
      if (retired) { windowFor.set(s, retired.id); continue; }
      try {
        const members = [];
        for (const id of seatable) if (!members.some((m) => m.user_id === table.userOf(id))) members.push({ user_id: table.userOf(id), character_id: id });
        const w = await table.api.createWindow(table.channelId, { name: `${pcs.length ? "Scene" : "Side"}: ${String(s.place).slice(0, 60)}`, kind: "group", members });
        windowFor.set(s, w.id);
        table.journal.created.push({ windowId: w.id, placeKey: key, users: wantUsers });
        table.save();
      } catch (e) {
        if (e.status >= 400 && e.status < 500) { s.skip = true; for (const id of s.ids) dropped.push({ id, why: `the platform refused a window (${e.status})` }); continue; }
        // A server or network failure: nothing local changes; created windows are kept for reuse; retried later.
        for (const c of [...table.journal.created, ...reusedSpares]) table.guard.spare.push(c);
        table.guard.retries[factOf(s)] = (table.guard.retries[factOf(s)] ?? 0) + 1;
        table.guard.apply(result.guard);
        table.journal = null;
        table.save();
        table.log(`split postponed (${e.message}); ${table.guard.retries[factOf(s)] >= 3 ? "given up after 3 tries" : "will retry"}`);
        return null;
      }
    }
    for (const o of ops) if (o.op === "split" && !o.skip) delete table.guard.retries[factOf(o)];
    return windowFor;
  }

export async function applyPlan(table, result, { windowId, mode, turn, autonomous = false, quiet = false, correctionSeq = 0, opId = randomUUID() }) {
    const reconciling = mode === "correction" || mode === "presence";
    const ops = table.partitionPlan(result.ops.map(o => ({ ...o })));
    // Without scene forks, a split the platform failed three times is given up (the people stay), so it is not retried
    // every turn.
    const factOf = (o) => JSON.stringify([placeKey(o.place), [...o.ids].sort()]);
    const dropped = [];
    if (!table.forks) for (const o of ops) if (o.op === "split" && (table.guard.retries[factOf(o)] ?? 0) >= 3) { o.skip = true; dropped.push(...o.ids.map((id) => ({ id, why: "the platform failed to open this scene three times" }))); }
    if (!ops.some(o => !o.skip)) { table.guard.apply(result.guard); const ig = [...(result.ignored ?? []), ...dropped]; if (ig.length) table.noteIgnored(windowId, ig); return null; }
    if (table.dailyOn()) for (const o of ops) {
      const source = o.timeline ? table.timelines.get(o.timeline) : table.timelines.of(o.ids?.[0]);
      const old = source?.clock ?? table.calendar.clock ?? parseClock(table.cfg.daily.night_end);
      const field = o.op === "relocate" ? "narrativeTime" : "time";
      if (!["relocate", "split", "fork_main"].includes(o.op)) continue;
      const minute = parseClock(o[field]);
      if (minute === null || minute < old) {
        if (o[field]) await table.post(windowId, { kind: "narration", visibility: "gm_only", content: "Time kept: whereabouts need a forward HH:MM time." }, { count: false });
        o[field] = formatClock(old);
      }
    }
    const lastSeq = table.lastSeq;
    const windowFor = table.forks
      ? await table.forkScenes(ops, { opId, mode, correctionSeq, result, windowId })
      : await table.openSceneWindows(ops, { mode, correctionSeq, result, windowId, turn, lastSeq, dropped, factOf });
    if (!windowFor) return null;

    // B. Commit all local placements together, after every new scene's window exists.
    const fromSeq = lastSeq + 1;
    const before = new Map(investigatorsFor(table.characters, table.roster).map((c) => [c.id, table.timelines.of(c.id).id]));
    const beforeWindows = new Map([...before].map(([id, t]) => [id, table.windowOf(table.timelines.get(t))]));
    for (const o of ops) if (o.op === "move") table.timelines.move(o.ids, o.to, fromSeq);
    const created = [];
    for (const o of ops) {
      if (o.op !== "split" || o.skip) continue;
      let t;
      if (o.primary) {
        t = table.timelines.move(o.ids, MAIN, fromSeq);
        table.timelines.bind(MAIN, windowFor.get(o));
        table.timelines.relocate(MAIN, { location: o.place, narrativeTime: o.time });
        t.opened = reconciling;
      } else t = table.timelines.split({ name: o.place, members: o.ids, windowId: windowFor.get(o), returnTo: [windowId], location: o.place, narrativeTime: o.time ?? "", span: o.span, opened: reconciling, fromSeq });
      if (o.replaces) table.timelines.merge(o.replaces, t.id, fromSeq);
      created.push({ op: o, timeline: t });
    }
    for (const o of ops) if (o.op === "merge") table.timelines.merge(o.from, o.into, fromSeq);
    for (const o of ops) if (o.op === "relocate") table.timelines.relocate(o.timeline, { location: o.location, narrativeTime: o.narrativeTime });
    if (table.dailyOn()) {
      for (const t of table.timelines.active()) if (parseClock(t.narrativeTime) !== null) t.clock = parseClock(t.narrativeTime);
      table.calendar.clock = table.timelines.main().clock ?? table.calendar.clock;
    }
    for (const o of ops) if (o.op === "bind_main") table.timelines.bind(MAIN, o.windowId);
    for (const o of ops.filter(o => o.op === "fork_main")) {
      table.timelines.bind(MAIN, windowFor.get(o));
      table.timelines.main().opened = reconciling;
      created.push({ op: o, timeline: table.timelines.main() });
    }
    const after = new Map([...before.keys()].map((id) => [id, table.timelines.of(id).id]));
    const moved = [...before.keys()].filter((id) => before.get(id) !== after.get(id) || beforeWindows.get(id) !== table.windowOf(table.timelines.of(id)));
    // Co-players' seats follow their timeline's window, cut per window.
    const cut = (w) => table.windowSeq.get(w) ?? lastSeq;
    for (const id of moved) {
      const cp = table.roster.coplayers.find((c) => c.characterId === id);
      const target = table.windowOf(table.timelines.of(id));
      if (cp && target) table.roster.moveSeats([cp], [target], cut, () => fromSeq);
    }
    table.guard.apply(result.guard);
    const travelled = moved.filter(id => before.get(id) !== after.get(id));
    table.guard.commit(travelled, { turn, now: table.now(), seq: lastSeq, prevOf: (id) => before.get(id), windowed: created.flatMap((c) => c.op.ids.filter((id) => table.isPc(id))) });
    if (correctionSeq) for (const id of travelled) table.guard.by[id].correctionSeq = correctionSeq;
    // Scene forks: departed players stop seeing new lines where they were; arrivals see the new scene's from now on.
    const audience = [];
    if (table.forks) for (const id of moved.filter(id => table.isPc(id))) {
      const userId = table.userOf(id), source = beforeWindows.get(id), dest = table.windowOf(table.timelines.of(id));
      if (source === dest) continue;
      if (source && source !== table.mainWindow()?.id && !table.scene(source)?.members.some(other => table.isPc(other) && table.userOf(other) === userId))
        audience.push({ windowId: source, userId, paused: true });
      if (dest) audience.push({ windowId: dest, userId, characterId: id, paused: false });
    }
    table.journal = { ...table.journal, phase: "B", audience };
    table.checkInvariants();
    table.save();

    // C. Refresh (the new windows), then D. posts and E. arrivals. A failed refresh never stops the posts.
    try { await table.refresh(); } catch (e) { table.log(`refresh after a split failed: ${e.message}`); }
    await table.applyAudience(audience);
    const ignored = [...(result.ignored ?? []), ...dropped];
    const summary = [];
    for (const { op, timeline: t } of created) {
      const w = t.windowId;
      if (op.opening) await table.post(w, { content: op.opening, kind: "narration" }, { count: false });
      const leaving = op.ids.filter((id) => table.isPc(id) && beforeWindows.get(id) !== w);
      const sources = [...new Set(leaving.map((id) => beforeWindows.get(id)))].filter(Boolean);
      for (const src of sources) {
        const to = leaving.filter((id) => beforeWindows.get(id) === src);
        if (to.length) await table.post(src, { content: `→ "${table.windowName(w)}"`, kind: "narration", visibility: "whisper", whisper_to: to }, { count: false });
      }
      summary.push(`${op.ids.map((id) => table.nameOf(id)).join(", ")} → ${t.name} ("${table.windowName(w)}", ${t.span} split)`);
      if (!reconciling) {
        const continuing = op.op === "fork_main" && !ops.some(o => o.op === "relocate" && o.timeline === MAIN);
        if (continuing && !table.deferArrivals) { t.opened = true; table.schedule(w, { mode: "followup", delay: 0 }); }
        else if (mode !== "daily") table.scheduleArrival(w, { names: op.ids.map((id) => table.nameOf(id)), place: t.location, opening: op.opening, reunion: false }, { autonomous, mode });
      }
    }
    // Reunions: everyone who ended in an existing thread, grouped by where they ended, one arrival per window.
    let here = null;
    const inNew = new Set(created.flatMap((c) => c.timeline.members));
    const byWindow = new Map();
    for (const id of moved) {
      if (inNew.has(id)) continue;
      const dest = table.timelines.get(after.get(id));
      const w = dest && table.windowOf(dest);
      if (!w) continue;
      if (!byWindow.has(w)) byWindow.set(w, { dest, ids: [] });
      byWindow.get(w).ids.push(id);
    }
    // A thread merged away points its old window at where its members went (only if some of them went there).
    for (const o of ops.filter((x) => x.op === "merge")) {
      const old = table.timelines.get(o.from);
      if (!old?.windowId) continue;
      const went = moved.filter((id) => before.get(id) === o.from).map((id) => table.windowOf(table.timelines.get(after.get(id)) ?? table.timelines.main()));
      const target = went.sort((a, b) => went.filter((x) => x === b).length - went.filter((x) => x === a).length)[0];
      if (target && target !== old.windowId) await table.post(old.windowId, { content: `→ "${table.windowName(target)}"`, kind: "narration" }, { count: false });
      // Its scene is over: what happened there becomes a chapter of the GM's memory.
      if (mode !== "daily") table.memory.maintainGm(old.windowId, table.history.lines(old.windowId).filter((m) => !table.hiddenLines().has(m.id)), (m) => table.renderForGm(m), { windowName: table.windowName(old.windowId), whole: true });
    }
    for (const [w, { dest, ids }] of byWindow) {
      summary.push(`${ids.map((id) => table.nameOf(id)).join(", ")} → ${dest.name}`);
      const arrival = { names: ids.map((id) => table.nameOf(id)), place: dest.location, reunion: true };
      if (reconciling || mode === "daily") continue;
      if (w === windowId) here = arrival;
      else table.scheduleArrival(w, arrival, { autonomous, mode });
    }
    if (reconciling) {
      // Correct both casts without announcing a fictional journey or revealing the other room.
      const affected = new Set(moved.flatMap(id => [before.get(id), after.get(id)]));
      for (const id of affected) {
        const t = table.timelines.get(id), w = table.windowOf(t);
        if (t.status === "active" && w) await table.post(w, {
          content: correctionNotice(table.language, t.location || t.name, t.members.map(id => table.nameOf(id))), kind: "narration",
        }, { count: false });
      }
    }
    if (!quiet && summary.length) await table.post(windowId, { content: `Timelines: ${summary.join("; ")}`, kind: "narration", visibility: "gm_only" }, { count: false });
    if (ignored.length) table.noteIgnored(windowId, ignored);
    table.journal = null;
    table.save();
    await table.archiveRetired();
    return { here, moved };
  }

export function coplayersNamed(table, list) { return names(list).map((n) => table.roster.coplayerByName(n)).filter(Boolean); }

export async function legacySplit(table, fromWindowId, a) {
    const proposed = table.coplayersNamed(a.coplayers);
    const checked = await table.checkDestinations(fromWindowId, [{ who: proposed.map(c => c.name), thread: "NEW", place: a.location || a.name, ownScene: true, time: a.narrative_time || "", span: "short", opening: a.opening || "" }], new Set(proposed.map(c => c.characterId)), [], "side");
    const members = table.coplayersNamed(checked.reports[0]?.who || []);
    if (!members.length) { table.log(`split "${a.name}": no co-player named; skipped`); return 0; }
    const result = planWhereabouts({ timelines: table.timelines, scene: { timeline: table.scene(fromWindowId) },
      reports: checked.reports, scopeIds: new Set(members.map(c => c.characterId)), mode: "manual",
      resolve: n => table.investigatorByName(n), isPc: id => table.isPc(id), userOf: id => table.userOf(id), windowUsers: w => table.windowUsers(w),
      guard: table.guard, turn: table.guard.turn, now: table.now(), cfg: table.cfg });
    await table.applyPlan(result, { windowId: fromWindowId, mode: "manual", turn: table.guard.turn });
    return 0;
  }

export async function legacyRejoin(table, a) {
    const t = table.timelines.byName(a.timeline);
    if (!t || t.id === MAIN || t.status !== "active") return 0;
    const targetWindow = a.into ? table.windows.find(w => norm(w.name) === norm(a.into) || w.id === a.into) : null;
    const target = table.scene(targetWindow?.id) ?? table.timelines.main();
    if (target === t) return 0;
    const companions = table.roster.coplayers.filter(c => t.members.includes(c.characterId));
    const checked = await table.checkDestinations(t.windowId, [{ who: companions.map(c => c.name), thread: "T" + target.handle }], new Set(companions.map(c => c.characterId)), [], "side");
    const result = planWhereabouts({ timelines: table.timelines, scene: { timeline: t }, reports: checked.reports,
      scopeIds: new Set(companions.map(c => c.characterId)), mode: "manual", resolve: n => table.investigatorByName(n),
      isPc: id => table.isPc(id), userOf: id => table.userOf(id), windowUsers: w => table.windowUsers(w),
      guard: table.guard, turn: table.guard.turn, now: table.now(), cfg: table.cfg });
    await table.applyPlan(result, { windowId: t.windowId, mode: "manual", turn: table.guard.turn });
    return 0;
  }

export function updateTimeline(table, a) {
    const t = table.timelines.byName(a.timeline) ?? table.timelines.main();
    const r = table.timelines.update(t.id, { narrativeTime: a.narrative_time, location: a.location, notes: a.notes, span: a.span });
    if (r) table.save();
    return 0;
  }
