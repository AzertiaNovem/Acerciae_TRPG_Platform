// recovery: table is the explicit runtime context supplied by Table; no service singleton.
import { CHECKPOINT_MS, CHECKPOINTS_KEPT, RECALL_ROLLBACK_LINES, addedPending, checkpointsToUndo, movedBetween, rollbackNote, stable } from "../rollback.mjs";
import { recall } from "../context/recall.mjs";
import { Timelines } from "../timelines.mjs";
import { Guard } from "../whereabouts.mjs";
import { SPEAKER_KINDS } from "./shared.mjs";

export function noteLine(table, m) {
    table.history.add(m);
    const at = Date.parse(m.created_at) || table.now();
    const st = table.state(m.chat_window_id);
    st.lastLineAt = Math.max(st.lastLineAt, at);
    table.noteSeq(m.chat_window_id, m.seq ?? 0);
    if (table.isHuman(m)) {
      st.lastHumanAt = Math.max(st.lastHumanAt, at);
      st.quietTurns = 0;
      st.coplayersActed = new Set();       // every human line gives each co-player one more go
      if (m.character_id) {
        // A player back after being away (AUTONOMY_IDLE_MINUTES) is welcomed back by the next turn.
        const prev = table.lastLineBy.get(m.character_id);
        if (prev !== undefined && at - prev > table.cfg.autonomyIdleMinutes * 60000) table.returning.set(m.character_id, at - prev);
        table.lastLineBy.set(m.character_id, Math.max(prev ?? 0, at));
      }
      table.lastHumanAt = Math.max(table.lastHumanAt, at);
      if (Object.keys(table.casual.chain).length) table.casual.chain = {};   // AI characters may text on again
      if (m.character_id && m.visibility === "window" && SPEAKER_KINDS.has(m.kind) && table.isPc(m.character_id)) {
        if (!table.speakers.has(m.chat_window_id)) table.speakers.set(m.chat_window_id, []);
        table.speakers.get(m.chat_window_id).push({ id: m.character_id, seq: m.seq, content: m.content });
      }
    }
  }

export function reload(table, state) {
    table.queue = table.queue.then(async () => {
      table.roster.coplayers = new table.roster.constructor(state).coplayers;
      table.roster.npcs = state.npcs ?? table.roster.npcs;
      table.timelines = new Timelines(state.timelines ?? [], { now: table.now });
      const guard = new Guard(state.guard ?? {});
      guard.turn = Math.max(guard.turn, table.guard.turn);
      table.guard = guard;
      for (const a of state.owedArrivals ?? []) table.scheduleArrival(a.windowId, a.arrival, { force: true });
      table.owedArrivals = [];
      await table.refresh();
    }).catch((e) => table.log(`reload: ${e.message}`));
    return table.queue;
  }

export function save(table) { try { table.persist(table); } catch (e) { table.log(`state not saved: ${e.message}`); } }

export function onEvent(table, ev) {
    if (ev.channel_id && ev.channel_id !== table.channelId) return undefined;
    if (ev.stream === "context") { table.gm.onContextEvent(ev); return undefined; }
    if (ev.type === "character.updated" && ev.character) table.cards.delete(ev.character.id);
    if (ev.type === "window.changed") { table.memberCache = null; table.refresh().catch((e) => table.log(`refresh: ${e.message}`)); }
    if (ev.type === "server.settings" && ev.settings?.features) table.illustrationSwitches.server = ev.settings.features.illustrations !== false;
    if (ev.type === "channel.updated") table.readIllustrationSwitches({ server: false }).catch(() => undefined);
    if (ev.type === "initiative.changed") table.initiative.delete(ev.chat_window_id ?? "*");
    if (ev.type === "scene.changed" && ev.scene?.status === "active" && ev.scene.id !== table.scenario?.id) {
      // A plan made before the platform opened its first scenario is not stale because of it: no replan for that.
      if (table.planner.arc && table.planner.scenarioId === null && !table.scenario) table.planner.scenarioId = ev.scene.id;
      table.scenario = { id: ev.scene.id, since: table.now(), fromSeq: table.lastSeq + 1 };
      table.beatClosed();
      table.save();
    }
    if (ev.type === "message.posted") return table.onMessage(ev.message);
    if (ev.type === "message.recalled") return table.onRecalled(ev.message);
    return undefined;
  }

export function onRecalled(table, m) {
    if (!m || m.channel_id !== table.channelId || !m.recalled_at) return undefined;
    table.history.add(m);
    if (!table.isHuman(m)) return undefined;              // this client's own recalls (a rollback), or its account's
    const windowId = m.chat_window_id;
    if (table.isPlannerWindow(windowId)) {                // a wish or correction withdrawn before the planner read it
      const before = table.planner.inbox.length;
      table.planner.inbox = table.planner.inbox.filter((e) => e.seq !== m.seq);
      if (table.planner.inbox.length !== before) table.save();
      return undefined;
    }
    // Not answered yet: it leaves the batch waiting for this window's turn.
    const waiting = table.speakers.get(windowId);
    if (waiting?.some((l) => l.seq === m.seq)) {
      const rest = waiting.filter((l) => l.seq !== m.seq);
      if (rest.length) table.speakers.set(windowId, rest); else { table.speakers.delete(windowId); table.recallEmptied.add(windowId); }
    }
    const after = table.history.lines(windowId, { after: m.seq }).length;
    const undo = checkpointsToUndo(table.checkpoints, m);
    const copies = table.phoneCopies.get(m.id) ?? [];
    const phoneWaiting = table.timers.get(windowId)?.mode === "phone";
    if (after >= RECALL_ROLLBACK_LINES) {
      table.log(`recall in "${table.windowName(windowId)}": ${after} lines since; the line leaves the context, nothing is rolled back`);
    } else if (undo.length || copies.length || table.isPhone(windowId) || table.history.lines(windowId, { after: m.seq }).some((l) => !table.isHuman(l))) {
      // (Without checkpoints, after a restart, the client's later lines are still recalled; its state stays.)
      for (const cp of undo) { cp.undone = true; if (cp.running) cp.abort.abort(new DOMException("A line it answers was recalled", "AbortError")); }
      if (phoneWaiting) table.cancelTimer(windowId);
      table.queue = table.queue.then(() => table.rollback(m, undo, copies)).catch((e) => table.log(`rollback failed: ${e.message}`));
      return table.queue;
    }
    // A turn still waiting in that window waits again, so a corrected line sent right after is answered once.
    return table.timers.has(windowId) ? table.schedule(windowId) : undefined;
  }

export function slices(table) {
    return {
      placement: stable({ timelines: table.timelines.toJSON(), seats: Object.fromEntries(table.roster.coplayers.map((c) => [c.characterId, c.seats])) }),
      calendar: stable({ date: table.calendar.date, time: table.calendar.time, log: table.calendar.log, routine: table.calendar.routine }),
      bonds: stable(table.bonds),
      truths: stable(table.improv.truths ?? []),
      pending: stable(table.casual.pending ?? []),
    };
  }

export function openCheckpoint(table, windowId, mode) {
    const now = table.now();
    table.checkpoints = table.checkpoints.filter((c) => c.running || now - c.at < CHECKPOINT_MS).slice(-CHECKPOINTS_KEPT);
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const cp = { windowId, mode, at: now, startSeq: table.lastSeq, batch: [], before: table.slices(), state: { calendar: structuredClone(table.calendar), guard: structuredClone(table.guard.by) },
      after: null, posted: [], audience: [], kept: [], illustrations: [], abort: new AbortController(), running: true, done, resolve };
    table.checkpoints.push(cp);
    return cp;
  }

export function closeCheckpoint(table, cp) { cp.after = table.slices(); cp.running = false; cp.resolve(); }

export async function rollback(table, m, undo, copies = []) {
    await Promise.all(undo.map((cp) => cp.done));
    const windowId = m.chat_window_id;
    // Turns the rolled-back ones scheduled and that have not started yet are not wanted either.
    for (const [w, pending] of [...table.timers]) if (pending.origin && undo.includes(pending.origin)) table.cancelTimer(w);
    // This client's lines to take back, newest first: what the turns posted anywhere, and anything later in the window.
    const ids = new Map();
    for (const cp of undo) for (const p of cp.posted) ids.set(p.id, p);
    for (const id of copies) ids.set(id, { id });
    for (const line of table.history.lines(windowId, { after: m.seq })) if (!table.isHuman(line)) ids.set(line.id, { id: line.id, seq: line.seq, kind: line.kind });
    const kept = undo.flatMap((cp) => cp.kept);
    const restored = new Set();
    let recalled = 0;
    for (const p of [...ids.values()].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))) {
      if (p.kind === "roll") { kept.push("a roll's result"); continue; }
      try {
        const res = await table.api.recallMessage(table.channelId, p.id);
        if (res?.message) table.history.add(res.message);
        recalled++;
      } catch (e) {
        kept.push(e.code === "recall_expired" ? "a line older than the recall window" : e.code === "not_recallable" ? "a line on the record (a roll or a move)" : `a line the platform would not recall (${e.status ?? e.message})`);
      }
    }
    table.phoneCopies.delete(m.id);
    if (table.isPhone(windowId)) table.store.removePhone(m.seq);
    // Pictures those turns asked for: cancelled while drawing, recalled once posted.
    const jobs = undo.flatMap((cp) => cp.illustrations);
    if (jobs.length) {
      const done = await table.api.illustrations(table.channelId).catch(() => []);
      for (const id of jobs) {
        const job = (done ?? []).find((j) => j.id === id);
        if (job?.message_id) { try { const res = await table.api.recallMessage(table.channelId, job.message_id); if (res?.message) table.history.add(res.message); recalled++; } catch { kept.push("a picture already posted"); } }
        else { try { await table.api.cancelIllustration(table.channelId, id); restored.add("a picture being drawn"); } catch { /* drawn meanwhile; it will be posted */ } }
      }
    }
    // State, newest turn first; a part something else changed since is left as it is.
    for (const cp of [...undo].reverse()) {
      if (!cp.after) continue;
      const now = table.slices();
      let placed = true;
      if (cp.after.placement !== cp.before.placement) {
        placed = now.placement === cp.after.placement;
        if (placed) {
          const before = JSON.parse(cp.before.placement), after = JSON.parse(cp.after.placement);
          table.timelines = new Timelines(before.timelines, { now: table.now });
          for (const c of table.roster.coplayers) if (before.seats[c.characterId]) c.seats = before.seats[c.characterId];
          for (const id of movedBetween(before.timelines, after.timelines)) { if (cp.state.guard[id]) table.guard.by[id] = cp.state.guard[id]; else delete table.guard.by[id]; }
          restored.add("where everyone is");
        } else kept.push("a move that later turns built on");
      }
      if (cp.after.calendar !== cp.before.calendar) {
        if (now.calendar === cp.after.calendar) { table.calendar = cp.state.calendar; restored.add("the date"); } else kept.push("a date change that later turns built on");
      }
      if (cp.after.bonds !== cp.before.bonds) {
        if (now.bonds === cp.after.bonds) { table.bonds = JSON.parse(cp.before.bonds); restored.add("relationships"); } else kept.push("a relationship that later turns changed again");
      }
      if (cp.after.truths !== cp.before.truths) {
        if (now.truths === cp.after.truths) { table.improv.truths = JSON.parse(cp.before.truths); restored.add("hidden truths"); } else kept.push("a hidden truth that later turns built on");
      }
      const added = addedPending(JSON.parse(cp.before.pending), JSON.parse(cp.after.pending)).map((p) => stable(p));
      if (added.length) { table.casual.pending = table.casual.pending.filter((p) => !added.includes(stable(p))); restored.add("texts on their way"); }
      if (cp.audience.length && placed) {
        try { await table.applyAudience([...cp.audience].reverse().map((a) => ({ ...a, paused: !a.paused }))); restored.add("who sees which window"); }
        catch (e) { kept.push(`window access (${e.message})`); }
      }
    }
    table.checkpoints = table.checkpoints.filter((c) => !undo.includes(c));
    // A move a stopped turn left half done must not be finished later: it belonged to what was just undone.
    if (table.journal && undo.some((cp) => cp.windowId === table.journal.windowId)) { table.journal = null; restored.add("a move in progress"); }
    table.checkInvariants();
    table.save();
    const who = m.character_name || m.author_name || "A player";
    table.log(`recall in "${table.windowName(windowId)}" by ${who}: ${recalled} line(s) taken back, ${undo.length} turn(s) rolled back${restored.size ? `; undid ${[...restored].join(", ")}` : ""}${kept.length ? `; kept ${kept.join("; ")}` : ""}`);
    if (kept.length || recalled) {
      await table.post(windowId, { content: rollbackNote({ who, recalled, restored: [...restored], kept: [...new Set(kept)] }), kind: "narration", visibility: "gm_only" }, { count: false, allowPaused: true });
    }
    // The players' other lines those turns answered, and any after the recalled one, are answered again.
    const again = new Map();
    for (const cp of undo) for (const l of cp.batch) if (l.seq !== m.seq) again.set(l.seq, { ...l, windowId: cp.windowId });
    for (const line of table.history.lines(windowId, { after: m.seq })) {
      if (table.isHuman(line) && line.character_id && line.visibility === "window" && table.isPc(line.character_id)) again.set(line.seq, { id: line.character_id, seq: line.seq, content: line.content, windowId });
    }
    const live = new Set(table.history.lines(windowId).map((l) => l.seq));
    const byWindow = new Map();
    for (const l of again.values()) {
      if (l.windowId === windowId && !live.has(l.seq)) continue;      // recalled too
      if (!byWindow.has(l.windowId)) byWindow.set(l.windowId, []);
      byWindow.get(l.windowId).push({ id: l.id, seq: l.seq, content: l.content });
    }
    for (const [w, lines] of byWindow) {
      const waiting = table.speakers.get(w) ?? [];
      table.speakers.set(w, [...lines, ...waiting.filter((x) => !lines.some((l) => l.seq === x.seq))].sort((a, b) => a.seq - b.seq));
      table.recallEmptied.delete(w);
      table.schedule(w);
    }
    return recalled;
  }
