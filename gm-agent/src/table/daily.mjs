import { dailyLabels } from "../daily-locale.mjs";
import { planDailyLife } from '../daily-planner.mjs';
// Daily-life effects share Table's serial queue and state writer.
import { completeJson } from '../llm/index.mjs';
import { setRoutine, parseIso } from '../calendar.mjs';
import { planWhereabouts } from '../whereabouts.mjs';
import { randomUUID } from 'node:crypto';
import { standinTurn, readAwayRule } from '../standin.mjs';
import { witnessedBy } from '../context/standinContext.mjs';
import { estimateTokens } from '../memory.mjs';
import { recall } from '../context/recall.mjs';
import { renderBondsFor } from '../bonds.mjs';
import { describeCalendar, describeRoutine } from '../calendar.mjs';
import { renderThread } from '../casual.mjs';
import { awayCommand } from '../daily.mjs';
import { dailyConfig, dailyState, modeOf, timetableAt, isNight, nightEnd, addStoryDays, instantNumber, parseClock, formatClock, DAY, sparkDue, nextSparkAt, pickSpark } from '../daily.mjs';

export function dailyOn(table) {
  if (!table.cfg.daily?.enabled) return false;
  const active = table.casualOn() && table.improv.on && !table.channel?.module_id;
  if (!active && !table.dailyInactiveNoted) { table.dailyInactiveNoted = true; table.log('daily life inactive: requires casual mode, improvisation and no module'); }
  return active;
}
export function dailyMode(table, now = table.now()) { return table.generation.paused ? 'paused' : modeOf(table.daily, now, table.cfg); }
export function currentInstant(table) {
  return { date: table.calendar.date, minute: table.calendar.clock ?? parseClock(table.calendar.time) ?? parseClock(dailyConfig(table.cfg).night_end) };
}
export function noteDailyLine(table, m) {
  if (!table.dailyOn() || !table.isHuman(m)) return;
  const at = Date.parse(m.created_at) || table.now();
  table.daily.lastHumanAt = Math.max(table.daily.lastHumanAt, at);
  if (table.isTrigger(m) && !table.isTableWindow(m.chat_window_id)) {
    table.daily.lastSceneLineAt = Math.max(table.daily.lastSceneLineAt, at);
    if (m.character_id) {
      table.daily.lastSceneLineBy[m.character_id] = Math.max(table.daily.lastSceneLineBy[m.character_id] ?? 0, at);
      if (table.daily.passive[m.character_id]) table.daily.passive[m.character_id].declared = false;
    }
  }
  table.save();
}
export async function initDaily(table) {
  if (!table.dailyOn()) return;
  await table.ensureTableWindows();
  table.daily.lastHumanAt ||= table.now();
  table.daily.lastSceneLineAt ||= table.daily.lastHumanAt;
  if (table.calendar.since == null) table.calendar.since = { at: table.now(), lines: 0 };
  await clockTick(table, { sparks: false });
  await reconcilePassive(table, { force: true });
}
export async function setThreadClock(table, thread, minute, { handoff = false, previous } = {}) {
  const old = previous ?? thread.clock ?? table.calendar.clock ?? minute;
  table.timelines.relocate(thread.id, { clock: minute, narrativeTime: formatClock(minute) });
  if (thread.id === table.timelines.main().id) { table.calendar.clock = minute; table.calendar.time = formatClock(minute); }
  if (handoff && minute - old >= 60) {
    const w = table.windowOf(thread);
    const turn = table.turnScope.getStore();
    if (w && !(turn?.mode === 'spark' && turn.dailyPosted >= turn.lineLimit)) {
      if (table.budgetPressure() === 'none') await table.postHandoff(w, `${table.calendar.date} · ${formatClock(minute)}`);
      else await table.post(w, { kind: 'narration', content: `${table.calendar.date} · ${formatClock(minute)}` }, { count: false });
    }
  }
}
export async function applyInstant(table, instant, { timetable = false, all = false } = {}) {
  if (!instant.date || instantNumber(instant) < instantNumber(currentInstant(table))) return;
  while (table.calendar.date < instant.date) {
    const ended = table.calendar.date;
    table.moveCalendar({ date: addStoryDays(ended, 1), time: '00:00', by: 'timetable' });
    for (const t of table.timelines.active()) await setThreadClock(table, t, 0);
    if (table.planner.between) table.planner.between = null;
    if (table.dayTurn) await table.dayTurn(ended, { timetable });
  }
  // The timetable's current instant is distinct from a scene still talking at an earlier hour.
  // Closed topics and a player's arrival catch scenes up; open topics retain their clocks.
  for (const t of table.timelines.active()) if (all || !table.daily.topics[t.id]?.open) await setThreadClock(table, t, Math.max(t.clock ?? 0, instant.minute));
}
export async function advanceDaily(table, now = table.now()) {
  if (!table.dailyOn() || !table.calendar.date || table.generation.paused) return;
  const c = dailyConfig(table.cfg), s = table.daily, mode = modeOf(s, now, c);
  if (mode === 'attended') return;
  if (s.frozen && !s.anchor) return;
  if (!s.anchor) {
    const minute = Math.max(currentInstant(table).minute, ...table.timelines.active().map(t => t.clock ?? parseClock(t.narrativeTime) ?? currentInstant(table).minute));
    s.anchor = { realAt: s.lastSceneLineAt + c.silence_minutes * 60000, date: table.calendar.date, minute };
    for (const t of table.timelines.active()) await setThreadClock(table, t, minute, { handoff: true });
    s.nextSparkAt = s.anchor.realAt;
  }
  const until = Math.min(now, s.lastHumanAt + c.pause_days * DAY);
  const instant = timetableAt(s.anchor, until, c.day_hours);
  if (isNight(instant.minute, c)) s.topics = {};
  await applyInstant(table, instant, { timetable: true });
  if (mode === 'paused') { s.frozen = { date: instant.date, minute: instant.minute }; s.anchor = null; }
  table.save();
}
export async function beforeDailyMessage(table, m) {
  if (!table.dailyOn() || !table.isHuman(m)) return;
  const now = Math.max(table.daily.lastHumanAt, Date.parse(m.created_at) || table.now());
  const s = table.daily, mode = table.dailyMode(now);
  await advanceDaily(table, now);
  const scene = table.isTrigger(m) && !table.isTableWindow(m.chat_window_id);
  if (scene && m.character_id && table.isPassive(m.character_id, now)) {
    const id = m.character_id;
    const prior = s.passive[id] ?? { since: s.lastSceneLineBy[id] ?? s.lastSceneLineAt, date: table.calendar.date, seq: s.dayStartSeq };
    (table.dailyReturns ??= new Map()).set(id, await returnRecap(table, id, prior));
  }
  if (scene && mode !== 'attended') {
    const instant = s.anchor ? timetableAt(s.anchor, now, dailyConfig(table.cfg).day_hours) : s.frozen ?? currentInstant(table);
    await applyInstant(table, nightEnd(instant, table.cfg), { all: true });
    s.anchor = null; s.frozen = null; s.topics = {};
  } else if (mode === 'paused' && !table.pauseCommand(m)) {
    s.anchor = { realAt: now, ...(s.frozen ?? currentInstant(table)) };
    s.frozen = null;
  }
  if (table.pauseCommand(m)) {
    s.frozen = s.anchor ? timetableAt(s.anchor, now, dailyConfig(table.cfg).day_hours) : s.frozen ?? currentInstant(table);
    s.anchor = null;
  }
  table.noteDailyLine(m);
  await reconcilePassive(table);
}
export async function clockTick(table, { sparks = true } = {}) {
  if (!table.dailyOn() || table.generation.paused) return;
  await flushDayTurns(table);
  await advanceDaily(table);
  if (table.reconcilePassive) await table.reconcilePassive();
  await planDaily(table);
  if (sparks && table.sparkTick) await table.sparkTick();
}

export async function planDaily(table) {
  const date = table.calendar.date, s = table.daily, epoch = table.dailyInterrupt ?? 0;
  const eligible = () => table.dailyOn() && table.dailyMode() === 'unattended' && table.plannerMode() !== 'off' && table.calendar.date === date && (table.dailyInterrupt ?? 0) === epoch;
  if (!date || !eligible() || s.planAttempt?.date === date || table.memory.jobs.has('planner') || table.overBudget()) return;
  // Shares the planner mutex. Reserve before the request so a restart never replays a paid attempt.
  await table.memory.run('planner', async () => {
    if (!eligible() || table.overBudget()) return;
    s.planAttempt = { date, at: table.now(), status: 'running' }; table.save();
    const llm = {
      signalOf: () => table.generation.signal,
      complete: request => {
        // The normal transport retry path must also respect a budget spent while waiting.
        if (!eligible() || table.overBudget()) throw Error('daily planning stopped: activity changed or budget spent');
        return table.plannerLlm.complete(request);
      },
    };
    try {
      const result = await planDailyLife(llm, {
        language: table.language, date, weekday: parseIso(date).getUTCDay(), world: table.improv.world,
        routine: table.calendar.routine?.text, weekly: s.week[parseIso(date).getUTCDay()], upcoming: table.calendar.routine?.upcoming,
        previous: s.dayPlan, secrets: [table.improv.secrets, ...table.improv.truths.map(t => t.text), ...(table.planner.arc?.threads ?? []).map(t => t.twist)],
        tight: table.budgetPressure() === 'tight',
      });
      if (!eligible()) { s.planAttempt.status = 'discarded'; return; }
      s.dayPlan = { date, at: table.now(), ...result };
      setRoutine(table.calendar, { text: result.routine, upcoming: table.calendar.routine?.upcoming });
      s.planAttempt.status = 'ready';
      table.log(`daily planning: ${date}, ${result.topics.length} small-talk topic(s)`);
    } catch (e) {
      s.planAttempt.status = eligible() ? 'failed' : 'discarded';
      table.log(`daily planning: ${e.message}; existing routine kept`);
    } finally { table.save(); }
  });
}
export async function readClock(table, windowId, text, { newDay = false, apply = true } = {}) {
  if (!table.dailyOn()) return true;
  const t = table.scene(windowId), minute = parseClock(text);
  const old = t?.clock ?? table.calendar.clock;
  const why = minute == null ? 'Time needs an HH:MM prefix; the existing clock is kept.' : !newDay && old != null && minute < old ? 'Time cannot move backwards within the story day.' : '';
  if (why) { await table.post(windowId, { kind: 'narration', visibility: 'gm_only', content: why }, { count: false }); return false; }
  if (apply && t) await setThreadClock(table, t, minute);
  table.save(); return true;
}
export function dailyStatus(table) {
  if (!table.dailyOn()) return { on: false };
  return { on: true, mode: table.dailyMode(), clock: currentInstant(table), anchor: table.daily.anchor, frozen: table.daily.frozen, plan: table.daily.dayPlan, planning: table.daily.planAttempt, pauseAt: table.daily.lastHumanAt + dailyConfig(table.cfg).pause_days * DAY };
}
export { dailyState };

export function sparkCancelled(table) {
  const turn = table.turnScope.getStore();
  return turn?.mode === 'spark' && (turn.dailyEpoch !== (table.dailyInterrupt ?? 0) || table.dailyMode() !== 'unattended' || table.generation.paused);
}
export function sparkTick(table) {
  if (!table.dailyOn() || table.pending || table.generation.paused) return;
  const pressure = table.budgetPressure(), now = table.now(), s = table.daily;
  if (!sparkDue(s, now, table.cfg, pressure)) return;
  const candidates = [];
  for (const t of table.timelines.active()) {
    const windowId = table.windowOf(t);
    if (!windowId || table.windows.find(w => w.id === windowId)?.archived_at) continue;
    for (const cp of table.roster.coplayersIn(windowId)) candidates.push({ id: cp.characterId, windowId, coplayer: cp });
    if (!table.standinOff && table.cfg.daily.pc_sparks && table.isPassive) for (const id of t.members) if (table.isPc(id) && table.isPassive(id) && s.rules[id]?.maySpark) candidates.push({ id, windowId });
  }
  const pick = pickSpark(candidates, s.lastSparker, table.random);
  if (!pick) return;
  s.sparks = [...s.sparks.filter(at => now - at < DAY), now];
  s.nextSparkAt = nextSparkAt(now, table.cfg, pressure, table.random); s.lastSparker = pick.id;
  table.save();
  table.schedule(pick.windowId, { mode: 'spark', delay: 0, sparker: pick, dailyEpoch: table.dailyInterrupt ?? 0 });
}
export function sparkNote(table, windowId) {
  const thread = table.scene(windowId), c = dailyConfig(table.cfg), s = table.daily;
  const instant = s.anchor ? timetableAt(s.anchor, table.now(), c.day_hours) : currentInstant(table);
  const lag = thread ? instantNumber(instant) - instantNumber({ date: table.calendar.date, minute: thread.clock ?? 0 }) : 0;
  const topic = s.topics[thread?.id];
  const suggestions = s.dayPlan?.date === table.calendar.date ? s.dayPlan.topics : [];
  const suggestion = !topic?.open && suggestions?.length ? suggestions[(topic?.sparks ?? 0) % suggestions.length] : '';
  return { urge: lag > c.max_lag_minutes, text: [topic?.open ? `Open daily-life topic: ${topic.title}. Continue it or let it end.` : '', suggestion ? `Optional daily-life conversation topic: ${suggestion}. Use only if it fits this scene and your own knowledge. It is not an event that happened; all plot threads still wait.` : '', lag > c.max_lag_minutes ? 'The timetable is ahead: finish this topic now or carry the conversation into the next part of the daily routine; the clock will catch up after this exchange.' : '', table.budgetPressure() === 'tight' ? 'Budget is tight: be very concise, one short sentence per line.' : ''].filter(Boolean).join('\n') };
}
export async function finishSpark(table, windowId, topic, urge) {
  if (table.sparkCancelled()) return;
  const t = table.scene(windowId), s = table.daily;
  if (!t || !s.anchor) return;
  const ended = topic?.state !== 'open';
  s.topics[t.id] = { open: !ended, title: String(topic?.title ?? '').slice(0, 100), sparks: (s.topics[t.id]?.sparks ?? 0) + 1 };
  if (ended || urge) {
    const instant = timetableAt(s.anchor, table.now(), dailyConfig(table.cfg).day_hours);
    const previous = t.clock;
    await applyInstant(table, instant, { timetable: true });
    await setThreadClock(table, t, Math.max(t.clock ?? 0, instant.minute), { handoff: true, previous });
  }
  table.save();
}

export function isPassive(table, id, now = table.now()) {
  if (!table.dailyOn() || !table.isPc(id)) return false;
  return !!table.daily.passive[id]?.declared || now - (table.daily.lastSceneLineBy[id] ?? table.daily.lastSceneLineAt) >= dailyConfig(table.cfg).passive_minutes * 60000;
}
export async function setPassiveMark(table, id, passive) {
  if (table.dailyPresenceOff) return;
  try {
    if (!table.api.setCharacterPresence) throw Object.assign(Error('presence endpoint unavailable'), { status: 404 });
    const c = await table.api.setCharacterPresence(table.channelId, id, passive);
    const local = table.characters.find(c => c.id === id); if (local) local.passive_since = c.passive_since;
  } catch (e) {
    if ([404, 405].includes(e.status)) { table.dailyPresenceOff = true; table.standinOff = true; table.log('daily life: platform has no presence endpoint; passive marks and stand-in lines disabled'); }
    else table.log(`passive status: ${e.message}`);
  }
}
export async function reconcilePassive(table, { force = false, clear = false } = {}) {
  if (!table.dailyOn()) return;
  const s = table.daily;
  for (const c of table.characters.filter(c => table.isPc(c.id))) {
    s.lastSceneLineBy[c.id] ??= s.lastSceneLineAt;
    const passive = !clear && table.isPassive(c.id), was = !!s.passive[c.id];
    if (passive) {
      s.passive[c.id] ??= { since: (s.lastSceneLineBy[c.id] ?? s.lastSceneLineAt) + dailyConfig(table.cfg).passive_minutes * 60000, declared: false, date: table.calendar.date, seq: table.lastSeq };
      if (!s.passiveToday.includes(c.id)) s.passiveToday.push(c.id);
    } else if (!clear) delete s.passive[c.id];
    if (force || was !== passive || (!!c.passive_since !== passive)) await table.setPassiveMark(c.id, passive);
  }
  table.save();
}
export function passiveNote(table, windowId) {
  if (!table.dailyOn()) return '';
  const ids = (table.scene(windowId)?.members ?? table.characters.map(c => c.id)).filter(id => table.isPassive(id));
  return ids.length ? `PASSIVE CHARACTERS: ${ids.map(id => table.nameOf(id)).join(', ')} remain quietly present, not the conversation's default audience. Their silence is comfortable: no repeated greetings, name checks, questions or invitations to participate. Co-players and NPCs have their own interests and relationships; let them talk to each other and let conversations end. Remember existing closeness without turning it into repeated attention. Never press for decisions, aim secrets, accusations, confessions, quarrels or plot twists at passive characters, let them be harmed or make a scene wait on them. No important relationship begins or ends. Only their separate stand-in may speak for them.` : '';
}

export async function onAwayCommand(table, m, command) {
  const id = table.phoneOwner(m.chat_window_id);
  if (!id || table.userOf(id) !== m.author_id) return;
  const s = table.daily, now = table.now(), labels = dailyLabels(table.language);
  let failed = false;
  if (command.action === 'away') {
    // Declare before awaiting the reader: a newer /back or scene line must win.
    s.passive[id] = { since: s.passive[id]?.since ?? now, declared: true, date: table.calendar.date, seq: table.lastSeq };
    await reconcilePassive(table);
    if (command.text) {
      const rule = s.rules[id] = { text: command.text, allow: [], forbid: [], maySpark: false, at: now };
      table.save();
      try {
        const parsed = await readAwayRule(table.llm, command.text, table.language);
        if (s.rules[id] === rule) Object.assign(rule, parsed);
      }
      catch (e) { failed = true; table.log(`away rule: ${e.message}`); }
    }
  } else if (command.action === 'clear') delete s.rules[id];
  else if (s.passive[id]) s.passive[id].declared = false;
  await reconcilePassive(table);
  const rule = s.rules[id];
  const content = [labels.rule, command.action === 'clear' ? labels.cleared : command.action === 'back' || !table.isPassive(id) ? labels.back : labels.passive,
    rule?.text ?? labels.noRule,
    rule ? `${labels.allow}: ${rule.allow.join('; ') || '—'}\n${labels.forbid}: ${rule.forbid.join('; ') || '—'}\n${labels.spark}: ${rule.maySpark ? labels.yes : labels.no}` : '',
    failed ? labels.failed : ''].filter(Boolean).join('\n');
  table.save();
  await table.post(m.chat_window_id, { kind: 'narration', content }, { count: false });
}
export async function standinAct(table, windowId, id, { spark = false, autonomous = false, request = null } = {}) {
  if (!table.dailyOn() || table.standinOff || !table.isPassive(id) || table.sparkCancelled() || ((spark || autonomous) && table.overBudget())) return 0;
  if (spark && (!table.cfg.daily.pc_sparks || !table.daily.rules[id]?.maySpark)) return 0;
  const typing = table.typing.get(id);
  if (typing?.windowId === windowId && table.now() - typing.since < 10 * 60000) return 0;
  const witnessed = witnessedBy(table, id);
  const sceneLines = witnessed.filter(m => m.chat_window_id === windowId);
  if (sceneLines.at(-1)?.stand_in && sceneLines.at(-1)?.character_id === id) return 0;
  if (witnessed.filter(m => m.stand_in && m.character_id === id && table.now() - Date.parse(m.created_at) < 3600000).length >= 12) return 0;
  const budget = table.cfg.standinContextTokens ?? 12000;
  const raw = [...witnessed];
  while (raw.length > 1 && estimateTokens(raw.map(m => table.renderForCoplayer(m)).join('\n')) > budget * .7) raw.shift();
  const included = new Set(raw.map(m => m.id));
  const recalled = recall(raw.slice(-6).map(m => m.content).join('\n'), witnessed.filter(m => !included.has(m.id)).map(m => ({ match: m.content, text: table.renderForCoplayer(m), source: `#${m.seq} ` })), Math.floor(budget * .1), { heading: 'EARLIER LINES YOU WITNESSED' });
  const c = table.characters.find(c => c.id === id), card = await table.card(id);
  const known = table.knownTo(id, witnessed);
  const questions = table.daily.questions.filter(q => q.pc === id);
  let reply;
  try {
    reply = await standinTurn(table.llm, { language: table.language, self: `YOU ARE ${c.name}\nPERSONA: ${c.bio ?? ''}\nSPEAKING STYLE: ${c.speaking_style ?? ''}\nYOUR CARD: ${JSON.stringify(card ?? c.role_card ?? {})}`, log: raw.map(m => table.renderForCoplayer(m)).join('\n'), recalled,
      phone: renderThread(table.store.phoneOf(id, 20), x => table.nameOf(x)), bonds: renderBondsFor(table.bonds, id, known.all, x => table.nameOf(x)), today: describeCalendar(table.calendar, { time: table.timelines.of(id).narrativeTime }), routine: describeRoutine(table.calendar), rule: table.daily.rules[id], questions, spark, request, dailyNote: spark ? table.sparkNote(windowId).text : '' });
  } catch (e) { table.log(`stand-in ${c.name}: ${e.message}`); return 0; }
  if (reply.action !== 'speak' || !table.isPassive(id) || table.sparkCancelled() || table.typing.get(id)?.windowId === windowId) return 0;
  (table.turnScope.getStore()?.standinActed ?? new Set()).add(id);
  // Check the line this call posted, not the table's latest post: a phone text may be delivered in between.
  const posted = await table.sendLine(windowId, { character_id: id, content: reply.text, kind: 'ic', stand_in: true });
  if (!posted) return 0;
  if (posted.stand_in !== true) {
    table.standinOff = true; table.log('daily life: platform did not mark a stand-in; recalled and disabled stand-ins');
    try { const r = await table.api.recallMessage(table.channelId, posted.id); if (r?.message) table.history.add(r.message); } catch (e) { table.log(`unmarked stand-in recall: ${e.message}`); }
    return 0;
  }
  if (reply.defer) {
    const q = { id: randomUUID(), pc: id, askedBy: reply.defer.askedBy, text: reply.defer.question, windowId, seq: posted.seq, date: table.calendar.date, at: table.now() };
    const own = [...table.daily.questions.filter(q => q.pc === id), q].slice(-5);
    table.daily.questions = [...table.daily.questions.filter(q => q.pc !== id), ...own]; table.save();
    const phone = table.casual.phones[id];
    if (phone) {
      const note = await table.sendLine(phone, { kind: 'narration', content: `${dailyLabels(table.language).waiting}: ${q.text}` });
      if (note) table.store.addDailyDerivedLine(note.id, posted.seq);
    }
  }
  await table.sleep(table.cfg.postDelayMs);   // the usual pause after a counted line
  return 1;
}
export async function standinReplies(table, windowId, spotlight, after, budget, { spark = false, autonomous = false, except = null } = {}) {
  if (!table.dailyOn()) return 0;
  let count = 0;
  for (const id of table.scene(windowId)?.members ?? []) {
    if (count >= budget || id === except || table.turnScope.getStore()?.standinActed?.has(id) || !table.isPassive(id) || table.sparkCancelled()) continue;
    const name = table.nameOf(id), first = name.split(/\s+/)[0];
    const requests = table.turnScope.getStore()?.standinRequests;
    const request = requests?.get(id);
    // AI prose mentioning a name is not a request for the absent player to reply.
    // Co-players explicitly identify a direct question; the GM uses spotlight.
    const addressed = request || spotlight.some(n => n === name || n === first) || table.history.lines(windowId, { after }).some(m => table.isHuman(m) && m.character_id !== id && m.visibility === 'window' && [name, first].some(n => String(m.content).includes(n)));
    if (addressed) {
      requests?.delete(id);
      count += await table.standinAct(windowId, id, { autonomous: autonomous || spark, request });
    }
  }
  return count;
}
export { awayCommand };

// A summary is written only from lines the character witnessed: with none, there is nothing to summarise and no model
// call. A day's summary does not repeat the open questions (each was posted once, when it was asked); a return recap
// lists the ones given in `questions`, written by code.
export async function writeDaySummary(table, id, date, fromSeq, toSeq, { returning = false, questions = [] } = {}) {
  if (!table.cfg.daily.summaries || (!returning && table.overBudget())) return null;
  const phone = table.casual.phones[id];
  if (!phone) return null;
  // The table's own notices in the phone (its welcome line, rule replies, waiting questions, earlier summaries) carry no
  // character and are not something the character lived through; phone texts carry their sender.
  const lines = witnessedBy(table, id, { after: fromSeq, upTo: toSeq }).filter(m => m.chat_window_id !== phone || m.character_id);
  if (!lines.length) return null;
  const log = lines.map(m => table.renderForCoplayer(m)).join('\n');
  const revision = table.store.get('context-revision', 0);
  let summary;
  try {
    summary = await completeJson(table.llm, { purpose: 'day_summary', maxRepairs: 0,
      system: `Write a personal day summary for ${table.nameOf(id)} from only their witnessed log, including their own phone messages. Address them in the second person in ${table.language}, 2 to 5 sentences. Distinguish stand-in lines from the player's decisions. Do not invent unseen events. Return {"text":"..."}. Do not list open questions; code adds them.`, user: `Story date: ${date}\n${log}` }, x => typeof x?.text === 'string' ? x.text.trim().slice(0, 2500) : '');
  } catch (e) { table.log(`day summary: ${e.message}`); return null; }
  if (!summary || table.store.get('context-revision', 0) !== revision) return null;
  const content = [`${date}${returning ? ` · ${dailyLabels(table.language).recap}` : ''}`, summary, ...questionList(table, questions)].join('\n');
  const message = await table.sendLine(phone, { kind: 'narration', content });
  if (!message) return null;
  const record = { characterId: id, date, text: summary, fromSeq, toSeq, at: table.now() };
  table.store.addDaySummary(record);
  table.store.addDailyDerivedLine(message.id, toSeq);
  return record;
}
export async function dayTurn(table, endedDate, { timetable = false, date = table.calendar.date } = {}) {
  if (!table.dailyOn()) return;
  const s = table.daily, toSeq = table.lastSeq;
  for (const id of [...s.passiveToday]) {
    const existing = table.store.daySummaries(id).find(x => x.date === endedDate && x.toSeq >= s.dayStartSeq);
    if (!existing) await writeDaySummary(table, id, endedDate, s.dayStartSeq, toSeq);
  }
  const routine = s.week[parseIso(date)?.getUTCDay()];
  if (routine) setRoutine(table.calendar, { text: routine });
  if (timetable) {
    for (const t of table.timelines.active().filter(t => t.id !== table.timelines.main().id && t.span === 'short')) {
      const windowId = table.windowOf(t), main = table.timelines.main();
      const result = planWhereabouts({ timelines: table.timelines, scene: { timeline: t, windowId }, reports: [{ who: t.members.map(id => table.nameOf(id)), thread: 'T0', place: '', ownScene: false, time: '', span: 'short' }], scopeIds: new Set(t.members), mode: 'manual', resolve: n => table.investigatorByName(n), isPc: id => table.isPc(id), userOf: id => table.userOf(id), windowUsers: w => table.windowUsers(w), guard: table.guard, turn: table.guard.beginTurn(), now: table.now(), cfg: table.cfg });
      await table.applyPlan(result, { windowId, mode: 'daily', turn: table.guard.turn, quiet: true });
    }
  }
  s.questions = s.questions.filter(q => (parseIso(date) - parseIso(q.date)) / DAY <= 14);
  s.passiveToday = table.characters.filter(c => table.isPassive(c.id)).map(c => c.id);
  s.topics = {}; s.dayStartSeq = table.lastSeq;
  table.save();
}
export async function flushDayTurns(table) {
  const pending = table.daily.pendingDays;
  while (pending.length) {
    const event = pending[0];
    await dayTurn(table, event.endedDate, event);
    pending.shift(); table.save();
  }
}
// "Waiting for your answer:" and the numbered questions; nothing when there are none.
function questionList(table, questions) {
  return questions.length ? [`${dailyLabels(table.language).waiting}:`, ...questions.map((q, i) => `${i + 1}. ${q.text}`)] : [];
}
// On return, the player's phone gets the recap: a summary of what their character witnessed, when enough happened
// and no day summary covers it, and every open question together.
export async function returnRecap(table, id, prior) {
  const lines = witnessedBy(table, id, { after: prior.seq ?? 0 });
  const standins = lines.filter(m => m.stand_in && m.character_id === id).length;
  const questions = table.daily.questions.filter(q => q.pc === id);
  let summaries = table.store.daySummaries(id, prior.since);
  let listed = false;
  if (!summaries.some(s => s.toSeq >= (prior.seq ?? 0)) && (standins || lines.length >= 20)) {
    const r = await writeDaySummary(table, id, table.calendar.date, prior.seq ?? 0, table.lastSeq, { returning: true, questions });
    if (r) { summaries.push(r); listed = true; }
  }
  const phone = table.casual.phones[id];
  if (questions.length && !listed && phone) {
    const message = await table.sendLine(phone, { kind: 'narration', content: [`${table.calendar.date} · ${dailyLabels(table.language).recap}`, ...questionList(table, questions)].join('\n') });
    // Derived from the stand-in lines that deferred them: taking one of those back drops this list from contexts.
    if (message) table.store.addDailyDerivedLine(message.id, Math.max(...questions.map(q => q.seq ?? 0)));
  }
  return { name: table.nameOf(id), away: `${Math.max(0, Math.round((table.now() - prior.since) / 60000))} min`, storyDays: Math.max(0, Math.round((parseIso(table.calendar.date) - parseIso(prior.date || table.calendar.date)) / DAY)), summaries: summaries.slice(-3).map(s => ({ date: s.date, text: s.text })), questions: table.daily.questions.filter(q => q.pc === id), standins };
}
