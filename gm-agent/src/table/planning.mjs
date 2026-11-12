import { threadPermission, addStoryDays, DAY } from "../daily.mjs";
// planning: table is the explicit runtime context supplied by Table; no service singleton.
import { MAIN, placeKey } from "../timelines.mjs";
import { mergeTableNotes, plannerReply, renderInbox } from "../wishes.mjs";
import { leaksSecret, noteSessionLine, planStory, plannerDue, plannerModeOf, renderFinalNote, renderPlanNote, renderStoryPlan, sessionEnded, stallSignature } from "../planner.mjs";
import { MAX_ADVANCE_DAYS, parseClock, formatClock, advanceCalendar, changedBy, describeCalendar, fitEra, setRoutine } from "../calendar.mjs";
import { applyBond, resolveBonds } from "../bonds.mjs";

export function plannerMode(table) { return table.cfg.planner && table.cfg.planner.enabled === false ? "off" : plannerModeOf(table.planner, table.improv); }

export function storyPlanSection(table) { return table.plannerMode() === "off" ? "" : renderStoryPlan(table.planner.arc, table.cfg.planner?.planTokens ?? 1500, table.dailyOn() ? { ownerStatus: thread => {
    const owners = (thread.owners ?? []).map(name => { const id = table.investigatorByName(name); return { name, passive: !id || table.isPassive(id), expired: !!id && table.isPassive(id) && table.now() - (table.daily.lastSceneLineBy[id] ?? table.daily.lastSceneLineAt) >= table.cfg.daily.pause_days * DAY }; });
    const status = threadPermission(thread, owners, { spark: table.turnScope.getStore()?.mode === "spark" });
    return status.mayAdvance ? "may advance" : `WAITS for ${status.waiting.join(", ") || "human participation"}`;
  } } : {}); }

export function plannerVerdict(table) {
    const arc = table.planner.arc;
    if (table.plannerMode() === "off") return null;
    return { on: true, moveOn: Boolean(arc?.verdict?.moveOn && !arc.beat?.closed), beat: arc?.beat?.title ?? "", why: arc?.verdict?.why ?? "", next: arc?.next?.[0]?.what ?? "" };
  }

export function impulseFor(table, coplayerId) {
    if (table.plannerMode() !== "full") return null;
    const i = table.planner.impulses.find((x) => x.coplayerId === coplayerId);
    return i && table.lastSeq <= i.expiresSeq ? i : null;
  }

export function noteStall(table, windowId, ctx) {
    const scene = table.scene(windowId);
    const sig = stallSignature({ scenarioId: table.scenario?.id, place: placeKey(scene?.location), worldVersion: ctx?.world?.version, worldChange: ctx?.world?.recent_changes?.[0]?.created_at ?? ctx?.world?.recent_changes?.[0]?.version, truths: table.improv.truths.length, threads: table.timelines.active().length });
    const st = table.planner.stall;
    if (st.sig === sig) st.turns++; else { st.turns = 0; st.sig = sig; }
  }

export async function plannerNote(table, a) {
    const text = String(a.text ?? "").trim();
    if (!text) return 0;
    table.planner.notes = [...table.planner.notes, { text: text.slice(0, 400), beatDone: a.beat_done === true || a.beat_done === "true", seq: table.lastSeq }].slice(-5);
    table.planner.asked = { why: text.slice(0, 200), at: table.now() };
    if (a.beat_done === true || a.beat_done === "true") table.beatClosed();
    table.save();
    return table.post(table.mainWindow().id, { content: `Planner note: ${text}`, kind: "narration", visibility: "gm_only" }, { count: false });
  }

export function beatClosed(table) {
    const arc = table.planner.arc;
    if (!arc) return;
    arc.beat.closed = true;
    arc.verdict = { ...arc.verdict, moveOn: false };
  }

export async function planCommand(table, action) {
    if (action === "on" || action === "off") { table.planner.on = action === "on"; table.save(); table.log(`story planner ${action}`); return; }
    if (action !== "now") throw new Error(`unknown plan action ${action}`);
    if (table.generation.paused) throw new Error("hosting is paused until a player speaks");
    if (table.overBudget()) throw new Error("the daily token budget is spent; the planner waits for tomorrow");
    await table.runPlanner("manual");
    await table.adoptPlan();
  }

export function maybePlan(table) {
    const cfg = table.cfg.planner;
    if (table.dailyOn() && table.dailyMode() !== 'attended') return null;
    if (table.generation.signal.aborted || !cfg || table.plannerMode() === "off" || (cfg.intervalMs === 0 && !table.planner.asked && table.planner.arc)) return null;
    const p = table.planner;
    const reason = plannerDue({
      on: p.on, busy: table.memory.jobs.has("planner"), overBudget: table.overBudget(), now: table.now(), lastHumanAt: table.lastHumanAt, idleMs: table.cfg.autonomyIdleMinutes * 60000,
      runs: p.runs, lastRunAt: p.lastRunAt, lastRunSeq: p.lastRunSeq, lastSeq: table.lastSeq, arc: p.arc, asked: p.asked, scenarioId: table.scenario?.id ?? null, plannerScenarioId: p.scenarioId, stallTurns: p.stall.turns, noDate: table.calendarOn() && !table.calendar.date,
    }, cfg);
    if (!reason) return null;
    return table.runPlanner(reason);
  }

export function runPlanner(table, reason, { session = null } = {}) {
    if (table.generation.signal.aborted) return null;
    if (table.memory.jobs.has("planner")) return table.memory.jobs.get("planner");
    const p = table.planner;
    p.runs = [...p.runs.filter((t) => table.now() - t < 3600000), table.now()];
    p.lastRunAt = table.now();
    const notes = [...p.notes], asked = p.asked;
    const inbox = [...p.inbox];   // Keep these durable until the plan succeeds, including across pause/restart.
    table.save();
    const since = session ? Math.min(p.lastRunSeq, session.fromSeq - 1) : p.lastRunSeq;
    return table.memory.run("planner", table.generation.task(async () => {
      const windowId = table.primaryWindowId();
      if (!windowId) return;
      const ctx = await table.buildGm(windowId, { peek: true });
      const hidden = table.hiddenLines();
      const windows = session ? table.windows : table.windows.filter((w) => w.id === windowId);
      const fresh = windows.flatMap((w) => table.history.lines(w.id).filter((m) => m.seq > since && !hidden.has(m.id)).map((m) => ({ m, w })))
        .sort((x, y) => x.m.seq - y.m.seq).slice(session ? -300 : -200)
        .map(({ m, w }) => (session && w.id !== windowId ? `[${w.name}] ${ctx.render(m)}` : ctx.render(m))).join("\n");
      const minutes = session ? Math.max(1, Math.round((session.lastAt - session.startedAt) / 60000)) : 0;
      const sinceText = [
        session ? `The session that just ended: ${session.lines} player lines over ${minutes} min, from line #${session.fromSeq}. Its lines in every window follow (window named when not the Main Chat).` : `${table.lastSeq - since} lines since (the newest ${Math.min(200, table.lastSeq - since)} of this window below)`,
        notes.length ? `The GM's notes to you: ${notes.map((n) => `"${n.text}"${n.beatDone ? " (beat done)" : ""}`).join("; ")}` : "",
        p.scenarioId && p.scenarioId !== table.scenario?.id ? "The scenario changed since the last plan." : "",
        table.dailyOn() ? `Player availability: ${table.characters.filter(c => table.isPc(c.id)).map(c => `${c.name}: ${table.isPassive(c.id) ? `passive for ${Math.round((table.now() - (table.daily.lastSceneLineBy[c.id] ?? table.daily.lastSceneLineAt)) / 60000)} real minutes` : "present"}`).join("; ")}` : "",
        fresh ? `Recent lines:\n${fresh}` : "",
      ].filter(Boolean).join("\n");
      const mode = table.plannerMode();
      const out = await planStory(table.plannerLlm, {
        language: table.language, profile: table.profile, mode, contextText: ctx.text, prev: p.arc, since: sinceText, coplayers: table.roster.coplayers, secrets: [table.improv.secrets, ...table.improv.truths.map((t) => t.text)],
        nextId: p.nextThreadId, lastSeq: table.lastSeq, trigger: reason, now: table.now(), impulseLines: table.cfg.planner?.impulseLines ?? 60, log: table.log,
        final: session ? { maxDays: table.cfg.planner?.finalReviewMaxDays ?? 30 } : null, calendar: table.calendarOn(), daily: table.dailyOn(),
        table: Boolean(p.window), wishes: p.window ? renderInbox(inbox, p.table) : "",
      });
      table.generation.signal.throwIfAborted();
      p.notes = p.notes.filter(n => !notes.includes(n));
      p.inbox = p.inbox.filter(l => !inbox.includes(l));
      if (p.asked === asked) p.asked = null;
      p.pending = { ...out, at: table.now(), trigger: reason, answered: inbox.length, ...(session ? { session } : {}) };
      table.save();
      if (table.pending === 0) await table.adoptPlan();
    }));
  }

export async function adoptPlan(table) {
    const p = table.planner;
    const pend = p.pending;
    if (!pend || table.generation.signal.aborted) return;
    p.pending = null;
    p.arc = pend.arc; p.impulses = pend.impulses ?? []; p.nextThreadId = pend.nextId ?? p.nextThreadId;
    p.lastRunSeq = table.lastSeq; p.scenarioId = table.scenario?.id ?? null; p.stall = { turns: 0, sig: null };
    table.store.addPlan({ version: pend.arc.version, at: pend.at ?? table.now(), trigger: pend.trigger ?? pend.arc.trigger, record: pend.record ?? {} });
    if (table.calendarOn() && pend.arc.calendar?.start && !table.calendar.date) {
      // The first date: a real YYYY-MM-DD, its year within the channel's era.
      const fit = fitEra(pend.arc.calendar.start, table.channel?.era);
      if (!fit) table.log(`planner: first date "${pend.arc.calendar.start}" is not YYYY-MM-DD; the next plan chooses again`);
      else {
        if (fit.moved) table.log(`planner: first date ${pend.arc.calendar.start} is outside the era "${table.channel.era}"; moved to ${fit.date}`);
        table.moveCalendar({ date: fit.date, time: pend.arc.calendar.time || undefined, why: "the story's first date", by: "planner" });
      }
    }
    let bonds = 0;
    for (const b of resolveBonds(pend.bonds, (n) => table.characterByName(n)?.id)) if (!(table.dailyOn() && [b.a, b.b].some(id => table.isPassive(id))) && applyBond(table.bonds, b, { by: "planner", now: table.now() })) bonds++;
    table.save();
    const main = table.mainWindow();
    if (p.notedVersion < pend.arc.version) {
      p.notedVersion = pend.arc.version; table.save();
      if (main) await table.post(main.id, { content: `${renderPlanNote(pend.arc, p.impulses)}${bonds && !pend.between ? ` Relationships: ${bonds} change(s).` : ""}`, kind: "narration", visibility: "gm_only" }, { count: false });
    }
    if (pend.between) await table.applyBetween(pend, bonds);
    if (table.calendarOn()) table.applyRoutine(pend.arc.calendar);
    await table.applyTableNotes(pend);
  }

export async function applyTableNotes(table, pend) {
    const p = table.planner;
    const merged = mergeTableNotes(p.table, pend.tableNotes, { nextId: p.nextNoteId, now: table.now() });
    p.table = merged.notes; p.nextNoteId = merged.nextId;
    if (merged.changed) { table.log(`planner: ${merged.changed} change(s) to the players' wishes and corrections`); table.save(); }
    if (!pend.answered || !p.window) return;
    const reply = plannerReply(pend.reply || "Noted.", [table.improv.secrets, ...table.improv.truths.map((t) => t.text), ...(pend.arc.threads ?? []).map((t) => t.twist)]);
    await table.post(p.window, { content: `🧭 ${reply}`, kind: "ooc" }, { count: false });
  }

export function applyRoutine(table, cal) {
    if (table.dailyOn() && cal?.week) {
      const secrets = [table.improv.secrets, ...table.improv.truths.map(t => t.text)];
      table.daily.week = Object.fromEntries(Object.entries(cal.week).filter(([k, v]) => /^[0-6]$/.test(k) && typeof v === "string" && !leaksSecret(v, secrets)));
      table.save();
    }
    if (!cal?.routine) return;
    const secrets = [table.improv.secrets, ...table.improv.truths.map((t) => t.text)];
    if ([cal.routine, ...(cal.upcoming ?? []).map((u) => u.what)].some((t) => leaksSecret(t, secrets))) { table.log("planner: routine dropped (it quoted a secret)"); return; }
    setRoutine(table.calendar, { text: cal.routine, upcoming: cal.upcoming });
    table.save();
  }

export async function applyBetween(table, pend, bonds = 0) {
    const b = pend.between;
    const calendar = table.calendarOn() && !table.dailyOn() ? table.moveCalendar({ days: b.advanceDays, date: b.date || undefined, time: b.time, why: b.why || "between sessions", by: "final review" }) : null;
    let declared = 0, secret = 0;
    for (const o of b.offscreen ?? []) if (await table.declare(o.text, o.secret)) { declared++; if (o.secret) secret++; }
    let transition = calendar?.changed ? calendar.to : "";
    if (!table.dailyOn() && !calendar && b.time && !leaksSecret(b.time, [table.improv.secrets, ...table.improv.truths.map(t => t.text)])) transition = b.time;
    if (transition && b.time) table.timelines.relocate(MAIN, { narrativeTime: b.time });
    table.planner.between = { transition, days: calendar?.changed ? calendar.days : 0, today: calendar ? describeCalendar(table.calendar) : "", offscreen: b.offscreen ?? [], opening: b.opening, recap: b.recap, version: pend.arc.version, at: table.now() };
    table.planner.lastFinalAt = table.now();
    table.save();
    const main = table.mainWindow();
    if (main && pend.session) await table.post(main.id, { content: renderFinalNote({ session: pend.session, between: b, calendar, declared, secret, bonds }), kind: "narration", visibility: "gm_only" }, { count: false });
  }

export function betweenNote(table) { return table.planner.between ? { ...table.planner.between } : null; }

export function noteSession(table, m) {
    const fresh = !table.planner.session;
    const stale = noteSessionLine(table.planner, { at: Date.parse(m.created_at) || table.now(), seq: m.seq ?? table.lastSeq, idleMs: table.cfg.autonomyIdleMinutes * 60000 });
    if (stale && stale.lines >= (table.cfg.planner?.finalReviewMinLines ?? 10)) table.log("final review of the last session skipped: the players came back before it ran");
    if (fresh || stale) table.save();
  }

export function checkSessionEnd(table) {
    if (table.generation.paused) return null;
    const s = table.planner.session;
    const end = sessionEnded(s, { now: table.now(), idleMs: table.cfg.autonomyIdleMinutes * 60000, minLines: table.cfg.planner?.finalReviewMinLines ?? 10 });
    if (!end || table.pending > 0 || table.memory.jobs.has("planner")) return null;
    table.planner.session = null;
    table.save();
    if (end === "short") { table.log(`session over (${s.lines} player line(s)): too short for a final review`); return null; }
    return table.finalReview(s);
  }

export function finalReview(table, session) {
    if (!table.cfg.planner || table.cfg.planner.finalReview === false || table.plannerMode() === "off") return null;
    if (table.overBudget()) { table.log("final review skipped: the daily token budget is spent"); return null; }
    table.log(`final review of the session (${session.lines} player lines)`);
    return table.runPlanner("final", { session });
  }

export async function finishSession(table) {
    await table.memoryIdle();
    if (table.generation.paused) return false;
    const s = table.planner.session;
    if (!s || s.lines < (table.cfg.planner?.finalReviewMinLines ?? 10)) return false;
    table.planner.session = null;
    table.save();
    const job = table.finalReview(s);
    if (!job) return false;
    await job;
    await table.adoptPlan();
    return true;
  }

export function moveCalendar(table, { days, date, time, why = "", by = "keeper" }) {
    const previousDate = table.calendar.date;
    const daily = table.dailyOn();
    const minute = parseClock(time);
    if (daily && by === "final review") return { changed: false };
    if (daily && minute !== null && !(Number(days) > 0 || (date && date > previousDate)) && table.calendar.clock !== null && minute < table.calendar.clock) return { changed: false, refused: "the clock never runs backwards" };
    if (daily && time && minute === null) time = undefined;
    const pace = table.calendarPaceCfg();
    const limits = by === "final review" ? { maxDays: table.cfg.planner?.finalReviewMaxDays ?? 30 }
      : by === "keeper" ? { maxDays: pace.maxDays || MAX_ADVANCE_DAYS, pace: { minMinutes: pace.minMinutes, minLines: pace.minLines } } : {};
    const r = advanceCalendar(table.calendar, { days, date, time, ...(daily ? { clock: minute ?? ((Number(days) > 0 || date > previousDate) ? 0 : table.calendar.clock) } : {}), why, by, seq: table.lastSeq, now: table.now(), ...limits });
    if (daily && !r.refused) {
      if (previousDate && table.calendar.date !== previousDate) {
        for (const t of table.timelines.active()) { t.clock = 0; t.narrativeTime = "00:00"; }
        table.calendar.clock = 0;
        if (by !== "timetable") for (let day = previousDate; day < table.calendar.date; day = addStoryDays(day, 1)) {
          table.daily.pendingDays.push({ endedDate: day, date: addStoryDays(day, 1), timetable: false });
        }
      }
      if (minute !== null) {
        table.calendar.clock = minute; table.calendar.time = formatClock(minute);
        table.timelines.relocate(MAIN, { clock: minute, narrativeTime: formatClock(minute) });
      }
    }
    if (r.changed) { if (r.to) table.log(`calendar: ${r.from || "(no date)"} → ${r.to} (${changedBy(by)})${r.clipped ? `, ${r.days} of the ${r.clipped} day(s) asked` : ""}`); table.save(); }
    else if (r.refused) table.log(`calendar unchanged: ${r.refused}`);
    return r;
  }

export function calendarHeld(table, windowId, r) {
    const text = r.refused && table.dailyOn() ? `Calendar unchanged: ${r.refused}.` : r.pace ? `Calendar unchanged: ${r.refused}. Keep play within the current day (only the time of day moves).`
      : r.clipped ? `Calendar moved on ${r.days} day(s), not ${r.clipped}: at most ${r.days} at once. Tell the time that passed to match.` : "";
    return text ? table.post(windowId, { content: text, kind: "narration", visibility: "gm_only" }, { count: false }) : 0;
  }

export function recordBond(table, a, by = "keeper") {
    const [x] = resolveBonds([a], (n) => table.characterByName(n)?.id);
    if (!x) { table.log(`bond skipped: no characters named "${a.a}" and "${a.b}"`); return null; }
    if (table.dailyOn() && [x.a, x.b].some(id => table.isPassive(id))) {
      table.log("bond refused: a player character is passive");
      if (by === "keeper") table.post(table.primaryWindowId(), { kind: "narration", visibility: "gm_only", content: "Relationship change refused: a player character is passively present; relationships stay frozen in both directions." }, { count: false }).catch(() => {});
      return null;
    }
    const r = applyBond(table.bonds, x, { by, now: table.now() });
    if (r) { table.log(`bond ${r}: ${table.nameOf(x.a)} — ${table.nameOf(x.b)}${x.kind ? `: ${x.kind}` : ""} (${changedBy(by)})`); table.save(); }
    return r;
  }
