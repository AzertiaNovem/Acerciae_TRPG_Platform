// scheduling: table is the explicit runtime context supplied by Table; no service singleton.
import { billableTokens } from "../store.mjs";
import { recall } from "../context/recall.mjs";
import { investigatorsFor } from "../context/profiles.mjs";
import { openWindows } from "../roles/roster.mjs";
import { MAIN } from "../timelines.mjs";
import { noteCalendarLine } from "../calendar.mjs";
import { TRIGGER_KINDS, HOUR } from "./shared.mjs";
import { pictureOnly } from "../pictureLines.mjs";
import { timetableAt } from "../daily.mjs";

export function cancelTimer(table, windowId) {
    const pending = table.timers.get(windowId);
    if (!pending) return;
    clearTimeout(pending.timer);
    table.timers.delete(windowId);
    table.pending--;
    for (const resolve of pending.resolvers) resolve();
  }

export function isTrigger(table, m) {
    if (!m || m.channel_id !== table.channelId) return false;
    if (!table.isHuman(m)) return false;
    return m.visibility === "window" && TRIGGER_KINDS.has(m.kind);
  }

export function playerSpeech(table, m) {
    return m?.channel_id === table.channelId && m.author_id && table.isHuman(m) && m.author_role === "player" &&
      ["ic", "ooc", "narration"].includes(m.kind) && Boolean(String(m.content ?? "").trim());
  }

export function pauseCommand(table, m) {
    return table.playerSpeech(m) && table.isPlannerWindow(m.chat_window_id) &&
      m.visibility === "window" && String(m.content).trim() === "/pause";
  }

export function updatePause(table, m, { historical = false } = {}) {
    const command = table.pauseCommand(m);
    if (command) table.pauseLines.add(m.id);
    if (!table.playerSpeech(m) || m.seq <= table.lastPlayerSeq) return;
    table.lastPlayerSeq = m.seq;
    if (!command && !table.generation.paused) return;
    const changed = command !== table.generation.paused;
    if (command) {
      table.generation.pause();
      table.speakers.clear();
      for (const pending of table.timers.values()) {
        clearTimeout(pending.timer);
        table.pending--;
        for (const resolve of pending.resolvers) resolve();
      }
      table.timers.clear();
    } else {
      table.speakers.clear();
      table.generation.resume();
    }
    table.planner.paused = command;
    table.planner.pauseSeq = m.seq;
    table.save();
    if (changed && command && !historical) {
      const content = table.language === "Simplified Chinese" ? "主持已暂停。频道内下一条玩家发言会恢复主持，已预约的手机消息仍会按时送达。"
        : table.language === "Traditional Chinese" ? "主持已暫停。頻道內下一則玩家發言會恢復主持，已預約的手機訊息仍會準時送達。"
        : "Hosting paused. The next player message in this channel resumes play. Scheduled phone messages will still arrive.";
      return table.post(m.chat_window_id, { kind: "ooc", content }, { count: false, allowPaused: true });
    }
  }

export function onMessage(table, m) {
    if (!m || m.channel_id !== table.channelId || !table.dailyOn() || !table.isHuman(m)) return dispatchMessage(table, m);
    if (m.seq && table.history.lines(m.chat_window_id, { after: m.seq - 1, upTo: m.seq }).some(line => line.id === m.id)) return;
    if (table.pauseCommand(m)) {
      const now = Math.max(table.daily.lastHumanAt, Date.parse(m.created_at) || table.now());
      table.daily.frozen = table.daily.anchor ? timetableAt(table.daily.anchor, now, table.cfg.daily.day_hours) : table.daily.frozen ?? table.dailyStatus().clock;
      table.daily.anchor = null;
      // Pause immediately, even while the serial queue is waiting for a model response.
      Promise.resolve(table.updatePause(m)).catch(e => table.log(`pause: ${e.message}`));
    }
    if (table.isTrigger(m) && !table.isTableWindow(m.chat_window_id)) table.dailyInterrupt = (table.dailyInterrupt ?? 0) + 1;
    const ready = table.queue.then(() => table.beforeDailyMessage(m));
    table.queue = ready.catch(e => table.log(`daily message: ${e.message}`));
    return ready.then(() => dispatchMessage(table, m));
  }

function dispatchMessage(table, m) {
    if (!m || m.channel_id !== table.channelId) return;
    // A picture request in the planner window: handled here, never the planner's, and never a resumption of play.
    if (table.noteArt(m)) {
      table.history.add(m);
      table.noteSeq(m.chat_window_id, m.seq ?? 0);
      const request = table.artCommand(m);
      return request === null ? undefined : table.onArtCommand(m, request);
    }
    // A picture a person posted without a caption: kept in the record, but it starts no turn and is no wish, since
    // there is nothing in it the table can read. With a caption it is a line like any other.
    if (table.isHuman(m) && pictureOnly(m)) {
      table.history.add(m);
      table.noteSeq(m.chat_window_id, m.seq ?? 0);
      return undefined;
    }
    if (table.pauseCommand(m)) {
      table.history.add(m);
      return table.updatePause(m);
    }
    // Ignore re-delivery of pre-pause events. A newer real utterance resumes first
    // and then goes through its usual chat, planner or phone handler.
    if (table.isHuman(m) && m.seq <= table.planner.pauseSeq) return;
    table.updatePause(m);
    table.noteLine(m);
    if (table.generation.paused) return;
    if (table.isHuman(m) && !table.isPlannerWindow(m.chat_window_id)) table.noteSession(m);
    // A player's line of play counts toward the calendar's pace (chatter out of character does not).
    if (table.playerSpeech(m) && m.kind !== "ooc" && !table.isPlannerWindow(m.chat_window_id)) noteCalendarLine(table.calendar);
    // A correction in chat or the planner window takes effect before the next GM/companion turn.
    let placement;
    if (table.isTrigger(m) && (table.isPlannerWindow(m.chat_window_id) || ((table.scene(m.chat_window_id) || m.chat_window_id === table.mainWindow()?.id) &&
        (m.kind === "ooc" || table.timelines.active().length > 1)))) {
      placement = table.queue = table.queue.then(table.generation.task(() => table.correctPlacement(m))).catch(e => table.log("placement correction: " + e.message));
    }
    if (m && table.isPlannerWindow(m.chat_window_id)) {
      table.onWishLine(m);
      return placement;
    }
    if (m && m.chat_window_id && m.chat_window_id === table.casual.log) return undefined;   // the GM's own phone log
    if (m && table.isPhone(m.chat_window_id)) return table.onPhoneLine(m);   // a phone never starts a scene turn
    if (!table.isTrigger(m)) return undefined;
    return table.schedule(m.chat_window_id);
  }

export function schedule(table, windowId, { kickoff = false, mode = "human", delay = table.cfg.debounceMs, ...extra } = {}) {
    const signal = table.generation.signal;
    if (signal.aborted) return;
    const existing = table.timers.get(windowId);
    const pending = existing ?? { resolvers: [], kickoff: false, mode, extra: {} };
    if (existing && mode === "arrival" && existing.mode === "human") {
      pending.extra.arrival = extra.arrival;
      return new Promise((resolve) => pending.resolvers.push(resolve));
    }
    clearTimeout(pending.timer);
    pending.kickoff ||= kickoff;
    if (mode === "human") { pending.mode = "human"; pending.extra = existing?.extra?.arrival ? { arrival: existing.extra.arrival } : {}; }
    else if (!existing || mode === "arrival" || mode === "relay" || mode === "phone") { pending.mode = mode; pending.extra = { ...(existing?.extra ?? {}), ...extra }; }
    if (!existing) table.pending++;
    pending.origin ??= table.turnScope.getStore() ?? null;   // a turn this one follows from (a recall can cancel it)
    table.timers.set(windowId, pending);
    return new Promise((resolve) => {
      pending.resolvers.push(resolve);
      pending.timer = setTimeout(() => {
        table.timers.delete(windowId);
        const done = () => { table.pending--; for (const r of pending.resolvers) r(); if (!signal.aborted) table.maybePlan(); };
        table.queue = table.queue.then(table.generation.task(() => table.turn(windowId, { kickoff: pending.kickoff, mode: pending.mode, ...pending.extra }))).catch((e) => table.log(`turn failed: ${e.message}`)).then(done);
      }, delay);
    });
  }

export function noteIgnored(table, windowId, ignored) {
    const text = ignored.map((i) => `${table.nameOf(i.id)}: ${i.why}`).join("; ");
    table.post(windowId, { content: `Whereabouts not applied: ${text}`, kind: "narration", visibility: "gm_only" }, { count: false }).catch(() => {});
  }

export function scheduleArrival(table, windowId, arrival, { autonomous = false, force = false } = {}) {
    if (table.deferArrivals) { table.owedArrivals.push({ windowId, arrival }); return null; }
    const now = table.now();
    table.arrivalTimes = table.arrivalTimes.filter((t) => now - t < HOUR);
    if (!force) {
      if (table.arrivalTimes.length >= table.cfg.timelineMaxArrivalsPerHour) { table.log(`arrival in "${table.windowName(windowId)}" skipped: hourly arrival cap`); return null; }
      if (autonomous) {
        table.autonomousTurns = table.autonomousTurns.filter((t) => now - t < HOUR);
        if (now - table.lastHumanAt > table.cfg.autonomyIdleMinutes * 60000 || table.autonomousTurns.length >= table.cfg.autonomyMaxTurnsPerHour || table.overBudget()) { table.log("arrival skipped: autonomy paused"); return null; }
      }
    }
    table.arrivalTimes.push(now);
    return table.schedule(windowId, { mode: "arrival", delay: 0, arrival, autonomous });
  }

export function overBudget(table) {
    if (!table.cfg.dailyTokenBudget) return false;
    const day = new Date(table.now()); day.setHours(0, 0, 0, 0);
    const spent = billableTokens(table.store.usageSince(day.getTime()));
    if (spent < table.cfg.dailyTokenBudget) return false;
    if (table.budgetNoted !== day.getTime()) { table.budgetNoted = day.getTime(); table.log(`daily token budget reached (${spent} of ${table.cfg.dailyTokenBudget}): no autonomous turns until tomorrow`); }
    return true;
  }

export function budgetPressure(table) {
    if (!table.cfg.dailyTokenBudget) return "none";
    if (table.overBudget()) return "spent";
    const day = new Date(table.now()); day.setHours(0, 0, 0, 0);
    return billableTokens(table.store.usageSince(day.getTime())) >= table.cfg.dailyTokenBudget * .6 ? "tight" : "none";
  }

export function checkInvariants(table) {
    const ids = investigatorsFor(table.characters, table.roster).map((c) => c.id);
    const counts = new Map(ids.map((id) => [id, 0]));
    for (const t of table.timelines.active()) for (const id of t.members) counts.set(id, (counts.get(id) ?? 0) + 1);
    if ([...counts.values()].some((n) => n !== 1)) { table.log("invariant: an investigator was in zero or several timelines; repaired"); table.timelines.reconcile(ids); }
    for (const t of table.timelines.active()) if (t.id !== MAIN && !t.windowId) { table.log(`invariant: thread "${t.name}" had no window; merged`); table.timelines.merge(t.id, MAIN, table.lastSeq + 1); }
    for (const cp of table.roster.coplayers) {
      const want = table.windowOf(table.timelines.of(cp.characterId));
      const open = openWindows(cp);
      if (want && !(open.length === 1 && open[0] === want)) {
        table.log(`invariant: ${cp.name}'s seat did not match its timeline; repaired`);
        table.roster.moveSeats([cp], [want], (w) => table.windowSeq.get(w) ?? table.lastSeq);
      }
    }
  }

export function startTicker(table) {
    // Pending phone replies arrive on their own clock, autonomy or not; the same clock notices a session's end.
    if (!table.phoneTimer) {
      table.phoneTimer = setInterval(() => {
        if (table.dailyOn() && !table.dailyTickPending) {
          table.dailyTickPending = true;
          table.queue = table.queue.then(() => table.clockTick()).catch(e => table.log(`daily: ${e.message}`)).finally(() => { table.dailyTickPending = false; });
        }
        table.deliverDue().catch((e) => table.log(`phones: ${e.message}`));
        try { table.checkSessionEnd(); } catch (e) { table.log(`final review: ${e.message}`); }
        // The platform says nothing when a player creates a character: look again now and then.
        if (table.pending === 0 && table.now() - (table.lastRefreshAt ?? 0) > 60000) table.refresh().catch((e) => table.log(`refresh: ${e.message}`));
      }, 10000);
      if (table.phoneTimer.unref) table.phoneTimer.unref();
    }
    if (!table.cfg.autonomy || table.ticker) return;
    table.ticker = setInterval(() => { table.tick().catch((e) => table.log(`autonomy: ${e.message}`)); }, table.cfg.autonomyTickMs);
    if (table.ticker.unref) table.ticker.unref();
  }

export function stopTicker(table) { clearInterval(table.ticker); table.ticker = null; clearInterval(table.phoneTimer); table.phoneTimer = null; }

export async function tick(table) {
    if (table.generation.paused || !table.cfg.autonomy || table.pending > 0) return null;
    if (table.overBudget()) return null;
    if (table.dailyOn() && table.dailyMode() !== "attended") return null;
    const now = table.now();
    const idle = table.cfg.autonomyIdleMinutes * 60000;
    // Away: nobody at the table. Only co-players-only threads move, every AWAY_SIDE_INTERVAL_MS (0: not at all).
    const away = now - table.lastHumanAt > idle;
    if (away && (table.dailyOn() || !table.cfg.awaySideIntervalMs)) return null;
    table.autonomousTurns = table.autonomousTurns.filter((t) => now - t < HOUR);
    if (table.autonomousTurns.length >= table.cfg.autonomyMaxTurnsPerHour) return null;
    const candidates = [];
    for (const w of table.windows) {
      if (w.archived_at || table.timelines.retired(w.id) || table.isTableWindow(w.id) || (table.forks && !table.scene(w.id))) continue;
      const st = table.state(w.id);
      const scene = table.scene(w.id);
      const isMain = w.id === table.primaryWindowId();
      const humans = table.presentPlayers(w.id).length > 0;
      const sinceLine = now - Math.max(st.lastLineAt, st.lastTurnAt);
      if (scene && !isMain && !humans && table.roster.coplayersIn(w.id).length) {
        if (sinceLine >= (away ? table.cfg.awaySideIntervalMs : table.cfg.autonomySideIntervalMs)) candidates.push({ w, mode: "side", waited: sinceLine, extra: { timeline: scene } });
      } else if (!away && humans && st.lastHumanAt && now - st.lastHumanAt <= idle && st.quietTurns < table.cfg.autonomyQuietTurns) {
        // Only a window where a human spoke recently moves on; a long-abandoned private window stays as it is. A human
        // writing there now holds it: the story does not move on while they compose their line (their sent line gets
        // its answer as always), and their stopping starts the silence over.
        const typing = table.humansTyping(w.id);
        if (typing.length) { const who = typing.join(", "); if (st.heldFor !== who) { st.heldFor = who; table.log(`autonomy: quiet turn in "${w.name}" waits while ${who} ${typing.length > 1 ? "are" : "is"} typing`); } continue; }
        st.heldFor = null;
        const quiet = now - Math.max(st.lastHumanAt, st.lastTurnAt, st.lastTypingAt ?? 0);
        if (quiet >= table.cfg.autonomyQuietMs) candidates.push({ w, mode: "quiet", waited: quiet, extra: { quietMinutes: Math.round((now - st.lastHumanAt) / 60000) } });
      }
    }
    if (!candidates.length) return null;
    const pick = candidates.sort((a, b) => b.waited - a.waited)[0];
    table.log(`autonomy: ${pick.mode} turn in "${pick.w.name}"`);
    return table.schedule(pick.w.id, { mode: pick.mode, delay: 0, ...pick.extra });
  }
