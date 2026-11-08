// art: table is the explicit runtime context supplied by Table; no service singleton.
import { randomUUID } from "node:crypto";
import { MAX_CHARACTERS, illustrationFailure, normalizeIllustration, pickEventMoment, pickScenarioMoment, scenarioLines } from "../illustrations.mjs";
import { artRequest, artText, bestPlace, drawable, isArtLine, locatePlot, pickRequestedMoment } from "../plotArt.mjs";
import { recall } from "../context/recall.mjs";
import { MAIN } from "../timelines.mjs";
import { norm, HOUR, EVENT_MIN_LINES, EVENT_MAX_LINES } from "./shared.mjs";

export function illustrationsOn(table) { return table.cfg.illustrations?.enabled !== false && !table.illustrationOff && table.illustrationsAllowed(); }

export function illustrationsAllowed(table) { return table.illustrationSwitches.server && table.illustrationSwitches.channel; }

export async function readIllustrationSwitches(table, { server = true } = {}) {
    const channel = await table.api.channel(table.channelId);
    table.illustrationSwitches.channel = channel.illustrations_enabled !== false;
    if (server) { const s = await table.api.serverSettings(channel.server_id ?? table.channel.server_id); table.illustrationSwitches.server = s?.features?.illustrations !== false; }
  }

export async function requestIllustration(table, windowId, { text, who, orientation }) {
    const ids = [...new Set(who.map((n) => table.characterByName(n)?.id).filter(Boolean))].slice(0, MAX_CHARACTERS);
    try {
      const job = await table.api.illustrate(table.channelId, windowId, { prompt: text, character_ids: ids, orientation, allow_cloud: table.cfg.illustrations?.allowCloud !== false, request_id: randomUUID() });
      table.log(`illustration requested in "${table.windowName(windowId)}"${ids.length ? ` with ${ids.map((id) => table.nameOf(id)).join(", ")}` : ""}: ${text.slice(0, 100)}`);
      return { job };
    } catch (e) {
      const failure = illustrationFailure(e);
      if (failure === "unavailable") { table.illustrationOff = e.message; table.log(`illustrations are off: the platform cannot draw here (${e.message})`); }
      else if (failure === "disabled") {
        // Turned off on the platform since the table last looked: learn which switch, so it is followed from now on.
        await table.readIllustrationSwitches().catch(() => { table.illustrationSwitches.channel = false; });
        table.log(`illustrations are turned off by the server's maintainers or the GM (${e.message})`);
      }
      else table.log(`illustration not requested (${failure}): ${e.message}`);
      return { failure };
    }
  }

export async function illustrateMoment(table, windowId, a) {
    if (!table.illustrationsOn()) return 0;
    const now = table.now();
    table.illustrationTimes = table.illustrationTimes.filter((t) => now - t < HOUR);
    if (table.illustrationTimes.length >= (table.cfg.illustrations?.maxPerHour ?? 0)) { table.log("illustration skipped: the hourly limit is reached"); return 0; }
    const n = normalizeIllustration(a);
    if (!n.text) return 0;
    if (table.illustrationRunning) { table.log("illustration skipped: a scenario picture is being drawn"); return 0; }
    const r = await table.requestIllustration(windowId, n);
    if (r.job) { table.illustrationTimes.push(now); table.recordPicture(n.text, windowId); const turn = table.turnScope.getStore(); if (turn?.running) turn.illustrations.push(r.job.id); }
    return 0;
  }

export function eventStart(table, windowId) {
    const scene = table.scene(windowId);
    const sceneStart = scene && scene.id !== MAIN ? (table.timelines.log.find((e) => e.timelineId === scene.id)?.fromSeq ?? 1) - 1 : 0;
    return Math.max(table.eventMarks.get(windowId) ?? 0, (table.scenario?.fromSeq ?? 1) - 1, sceneStart);
  }

export function eventDone(table, windowId, a) {
    const from = table.eventStart(windowId), upTo = table.lastSeq, event = String(a.text ?? "").trim().slice(0, 200);
    table.eventMarks.set(windowId, upTo);
    if (!table.illustrationsOn()) return 0;
    if (!table.presentPlayers(windowId).length) { table.log(`event "${event}": no picture, no player is here`); return 0; }
    if (table.history.lines(windowId, { after: from, upTo }).filter(drawable).length < EVENT_MIN_LINES) { table.log(`event "${event}": no picture, too short`); return 0; }
    const now = table.now();
    table.illustrationTimes = table.illustrationTimes.filter((t) => now - t < HOUR);
    if (table.illustrationTimes.length >= (table.cfg.illustrations?.maxPerHour ?? 0)) { table.log(`event "${event}": no picture, the hourly limit is reached`); return 0; }
    table.illustrationTimes.push(now);
    const job = { windowId, event, from, upTo, turn: table.turnScope.getStore() ?? null, scenario: table.scenario ? { ...table.scenario } : null };
    table.pictureChain = table.pictureChain
      .then(() => table.turnScope.exit(() => table.generation.tasks.exit(() => table.drawEvent(job))))
      .catch((e) => table.log(`event picture: ${e.message}`));
    table.illustrating = table.pictureChain.then(() => table.draining);
    return 0;
  }

export async function drawEvent(table, { windowId, event, from, upTo, turn, scenario }) {
    if (turn?.undone) return;
    const lines = table.history.lines(windowId, { after: from, upTo }).filter(drawable).slice(-EVENT_MAX_LINES);
    if (!lines.length) return;
    const scene = table.scene(windowId);
    const cast = table.characters.filter((c) => table.isPc(c.id) || table.roster.isCoplayer(c.id) || table.roster.isNpc(c.id)).map((c) => c.name);
    const title = scenario?.id ? ((await table.api.scenes(table.channelId).catch(() => [])) ?? []).find((x) => x.id === scenario.id)?.title ?? "" : "";
    const moment = await pickEventMoment(table.llm, { language: table.language, event, scenario: title, place: scene?.location, time: scene?.narrativeTime, era: table.channel.era ?? "",
      cast, lines: scenarioLines(lines, (id) => table.nameOf(id)), drawn: table.drawnIn(scenario) });
    if (turn?.undone) return;
    table.recordPicture(moment.text, windowId, scenario?.id);
    table.log(`event picture of "${event}" in "${table.windowName(windowId)}": ${moment.why || moment.text.slice(0, 80)}`);
    table.illustrationQueue.push({ windowId, moment, tries: 0, turn });
    table.drainIllustrations().catch((e) => table.log(`pictures: ${e.message}`));   // the next choice need not wait for the drawing
  }

export function recordPicture(table, text, windowId, scenarioId = table.scenario?.id ?? null) {
    table.pictureLog = [...table.pictureLog, { text: String(text), windowId, scenarioId, seq: table.lastSeq }].slice(-60);
  }

export function drawnIn(table, scenario) {
    if (!scenario) return [];
    const inScenario = (m) => (Number.isFinite(scenario.fromSeq) ? m.seq >= scenario.fromSeq : !m.created_at || Date.parse(m.created_at) >= (scenario.since ?? 0));
    const texts = [];
    for (const w of table.windows) for (const m of table.history.lines(w.id, { after: Math.max(0, (scenario.fromSeq ?? 1) - 1) })) {
      if (!table.isHuman(m) && m.media_asset_id && inScenario(m)) texts.push({ seq: m.seq, text: String(m.content ?? "").replace(/^🖼️?\s*/u, "") });
    }
    for (const p of table.pictureLog) if (p.scenarioId === scenario.id) texts.push({ seq: p.seq, text: p.text });
    const seen = new Set();
    return texts.sort((a, b) => a.seq - b.seq).filter((t) => t.text && !seen.has(norm(t.text)) && seen.add(norm(t.text))).slice(-12).map((t) => t.text);
  }

export async function endingScenario(table, scenes) {
    // Read now, before the change moves anyone or posts the next scene; only the title waits for the platform.
    const id = table.channel.current_scene_id;
    // Its lines: from the seq it began at (older state files know only when: a line without a time is kept).
    const own = table.scenario?.id === id, fromSeq = own ? table.scenario.fromSeq ?? null : 0, since = own ? table.scenario.since ?? 0 : 0, upTo = table.lastSeq;
    const inScenario = (m) => (fromSeq !== null ? m.seq >= fromSeq : !m.created_at || Date.parse(m.created_at) >= since);
    const threads = table.timelines.active().filter((t) => t.members.some((m) => table.isPc(m))).map((t) => {
      const windowId = table.windowOf(t);
      const lines = windowId ? table.history.lines(windowId, { upTo }).filter((m) => m.visibility === "window" && ["ic", "narration", "roll"].includes(m.kind) &&
        !m.media_asset_id && inScenario(m)) : [];
      return { name: t.name, place: t.location, time: t.narrativeTime, lines };
    });
    const list = scenes ?? (await table.api.scenes(table.channelId).catch(() => []));
    return { title: (list ?? []).find((sc) => sc.id === id)?.title ?? "", threads, scenario: { id, fromSeq: fromSeq ?? undefined, since } };
  }

export async function illustrateScenario(table, ending) {
    const main = table.mainWindow();
    if (!table.illustrationsOn() || !main || !ending) return;
    const cast = table.characters.filter((c) => table.isPc(c.id) || table.roster.isCoplayer(c.id) || table.roster.isNpc(c.id)).map((c) => c.name);
    for (const thread of ending.threads) {
      if (!thread.lines.length) continue;
      const moment = await pickScenarioMoment(table.llm, { language: table.language, title: ending.title, place: thread.place, time: thread.time, era: table.channel.era ?? "",
        cast, lines: scenarioLines(thread.lines, (id) => table.nameOf(id)), drawn: table.drawnIn(ending.scenario) });
      table.recordPicture(moment.text, main.id, ending.scenario?.id ?? null);
      table.log(`scenario picture of "${thread.name}": ${moment.why || moment.text.slice(0, 80)}`);
      table.illustrationQueue.push({ windowId: main.id, moment, tries: 0 });
    }
    table.drainIllustrations().catch((e) => table.log(`pictures: ${e.message}`));
  }

export function drainIllustrations(table) {
    if (table.illustrationRunning) return table.draining ?? Promise.resolve();
    table.illustrationRunning = true;
    table.draining = table.drainQueue();
    return table.draining;
  }

export async function drainQueue(table) {
    try {
      while (table.illustrationQueue.length && table.illustrationsOn()) {
        const item = table.illustrationQueue[0];
        const drop = () => { const i = table.illustrationQueue.indexOf(item); if (i >= 0) table.illustrationQueue.splice(i, 1); };
        if (item.turn?.undone) { drop(); continue; }   // the turn that ended its event was rolled back
        const r = await table.requestIllustration(item.windowId, item.moment);
        if (r.job) item.turn?.illustrations.push(r.job.id);
        if (r.job) { drop(); const job = await table.waitIllustration(r.job.id, item.done ? 3000 : 10000); item.done?.(job && job.status !== "completed" ? { failure: job.status === "cancelled" ? "cancelled" : "error" } : { job: r.job }); continue; }
        // A player waits for a busy account, but not for the hourly cap.
        const patience = item.done ? (r.failure === "busy" ? 40 : 0) : 20;
        if (["busy", "rate_limited"].includes(r.failure) && ++item.tries <= patience) { await table.sleep(r.failure === "busy" ? 15000 : 120000); continue; }
        table.log(`${item.done ? "requested" : item.turn !== undefined ? "event" : "scenario"} picture dropped (${r.failure})`);
        drop();
        item.done?.({ failure: r.failure });
      }
    } finally { table.illustrationRunning = false; }
    // Pictures can no longer be drawn: a player still waiting is told so.
    for (const item of table.illustrationQueue.filter((x) => x.done)) { table.illustrationQueue.splice(table.illustrationQueue.indexOf(item), 1); item.done({ failure: table.illustrationsAllowed() ? "unavailable" : "disabled" }); }
  }

export async function waitIllustration(table, id, every = 10000) {
    for (let i = 0; i < Math.ceil(600000 / every); i++) {
      const job = ((await table.api.illustrations(table.channelId).catch(() => [])) ?? []).find((j) => j.id === id);
      if (!job || !["pending", "running"].includes(job.status)) return job ?? null;
      await table.sleep(every);
    }
    return null;
  }

export function artCommand(table, m) {
    return table.playerSpeech(m) && table.isPlannerWindow(m.chat_window_id) && m.visibility === "window" ? artRequest(m.content) : null;
  }

export function noteArt(table, m) {
    if (!m || !table.isPlannerWindow(m.chat_window_id)) return false;
    const art = table.artCommand(m) !== null || (!table.isHuman(m) && isArtLine(m));
    if (art) table.artLines.add(m.id);
    return art;
  }

export function onArtCommand(table, m, request) {
    if (table.artHandled.has(m.id)) return undefined;
    table.artHandled.add(m.id);
    const user = m.author_id;
    const say = (key, vars) => table.post(m.chat_window_id, { kind: "ooc", content: artText(table.language, key, vars) }, { count: false, allowPaused: true });
    if (!request) return say("usage");
    const cap = table.cfg.illustrations?.requestsPerHour ?? 4;
    if (table.cfg.illustrations?.enabled === false || cap <= 0 || !table.illustrationsAllowed()) return say("off");
    if (!table.illustrationsOn()) return say("unavailable");
    if (table.artBusy.has(user)) return say("busy");
    const now = table.now(), times = (table.artTimes.get(user) ?? []).filter((t) => now - t < HOUR);
    if (times.length >= cap) return say("limit", { n: times.length });
    table.artTimes.set(user, [...times, now]);
    table.artBusy.add(user);
    table.log(`picture requested by ${m.author_name || "a player"} in the planner window: ${request.slice(0, 100)}`);
    // Outside any turn (a recall rollback never touches it) and outside the pause (it is not play).
    return table.turnScope.exit(() => table.generation.tasks.run(table.artSignal, async () => {
      await say("searching");
      const outcome = await table.drawPastPlot(m, request);
      if (outcome) await say(outcome);
    })).catch(async (e) => { table.log(`picture request: ${e.message}`); await say("failed"); }).finally(() => table.artBusy.delete(user));
  }

export async function drawPastPlot(table, m, request) {
    const user = m.author_id;
    // What this player can read: the Main Chat and the windows they are a member of; never a table window.
    const readable = table.windows.filter((w) => !table.isTableWindow(w.id) && (w.kind === "main" || (w.members ?? []).some((x) => x.user_id === user)));
    const ids = new Set(readable.map((w) => w.id));
    if (!ids.size) return "notFound";
    const mine = table.characters.filter((c) => c.user_id === user && table.isPc(c.id)).map((c) => c.name);
    const cast = table.characters.filter((c) => table.isPc(c.id) || table.roster.isCoplayer(c.id) || table.roster.isNpc(c.id)).map((c) => c.name);
    const scenes = ((await table.api.scenes(table.channelId).catch(() => [])) ?? []).filter((x) => x.title || x.summary)
      .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
    const scenarios = scenes.map((x, i) => ({ key: `S${i + 1}`, id: x.id, title: x.title, location: x.location, time: x.narrative_time, summary: x.summary }));
    const chapters = readable.flatMap((w) => table.memory.gmChapters(w.id).map((c) => ({ windowId: w.id, window: w.name, fromSeq: c.fromSeq, toSeq: c.toSeq, text: c.text })))
      .map((c, i) => ({ ...c, key: `C${i + 1}` }));
    const where = await locatePlot(table.llm, { request, requester: mine, cast, scenarios, chapters });
    table.log(`picture request: searching ${where.terms.map((t) => `"${t}"`).join(", ") || "(no terms)"}${where.scenario ? ` in ${where.scenario}` : ""}${where.chapter ? `, ${where.chapter}` : ""}`);
    const chapter = chapters.find((c) => c.key === where.chapter) ?? null;
    const scene = scenarios.find((x) => x.key === where.scenario) ?? null;
    // The densest place of the matches, inside the chapter or scenario named when any match falls there.
    const hits = await table.plotHits(where.terms, ids);
    const inChapter = chapter ? hits.filter((h) => h.windowId === chapter.windowId && h.seq >= chapter.fromSeq && h.seq <= chapter.toSeq) : [];
    const inScene = scene ? hits.filter((h) => h.sceneId === scene.id) : [];
    const place = bestPlace(inChapter.length ? inChapter : inScene.length ? inScene : hits);
    let windowId = null, lines = [];
    if (place) { windowId = place.windowId; lines = await table.linesAround(windowId, place.seq); }
    else if (chapter) { windowId = chapter.windowId; lines = table.history.lines(windowId, { after: chapter.fromSeq - 1, upTo: chapter.toSeq }).filter(drawable); }
    else if (scene) {
      const most = readable.map((w) => ({ id: w.id, lines: table.history.lines(w.id).filter((x) => x.scene_id === scene.id && drawable(x)) })).sort((a, b) => b.lines.length - a.lines.length)[0];
      if (most?.lines.length) ({ id: windowId, lines } = most);
    }
    if (!lines.length) return "notFound";
    const moment = await pickRequestedMoment(table.llm, { language: table.language, request, era: table.channel.era ?? "", cast, window: table.windowName(windowId),
      lines: scenarioLines(lines, (id) => table.nameOf(id)) });
    if (!moment.found) return "notFound";
    table.log(`picture request: drawing ${moment.why || moment.text.slice(0, 80)}`);
    table.recordPicture(moment.text, m.chat_window_id);
    // Ahead of any scenario picture still waiting; the platform still draws one picture at a time per account.
    const outcome = await new Promise((done) => {
      table.illustrationQueue.unshift({ windowId: m.chat_window_id, moment, tries: 0, done });
      table.drainIllustrations().catch((e) => table.log(`pictures: ${e.message}`));
    });
    if (outcome.job) return null;
    return { unavailable: "unavailable", disabled: "off", rate_limited: "rateLimited" }[outcome.failure] ?? "failed";
  }

export async function plotHits(table, terms, ids) {
    const hits = new Map();
    const add = (m, term) => {
      if (!m || !ids.has(m.chat_window_id) || !drawable(m)) return;
      const h = hits.get(m.id) ?? { windowId: m.chat_window_id, seq: Number(m.seq), sceneId: m.scene_id ?? null, terms: new Set() };
      h.terms.add(term);
      hits.set(m.id, h);
    };
    const wanted = terms.map((t) => [t, t.toLowerCase()]);
    for (const id of ids) for (const m of table.history.lines(id)) {
      const text = String(m.content ?? "").toLowerCase();
      for (const [t, low] of wanted) if (text.includes(low)) add(m, t);
    }
    for (const [t] of wanted) for (const m of (await table.api.searchMessages(table.channelId, t).catch(() => null)) ?? []) add(m, t);
    return [...hits.values()];
  }

export async function linesAround(table, windowId, seq, before = 60, after = 60) {
    let all;
    const first = table.store.firstSeq(windowId);
    if (first !== null && first <= seq) all = table.history.lines(windowId);
    else {
      const get = async (beforeSeq) => ((await table.api.messages(table.channelId, windowId, 200, beforeSeq).catch(() => null)) ?? []);
      const prior = await get(seq + 1);
      let later = [];
      for (let span = 400, i = 0; i < 6 && span >= 1; i++) {
        const page = await get(seq + 1 + span);
        if (page.length >= 200 && (page[0]?.seq ?? Infinity) > seq + 1) { span = Math.floor(span / 4); continue; }   // lines were skipped
        later = page.filter((x) => x.seq > seq);
        if (later.length >= after || page.length < 200) break;
        span *= 2;
      }
      const seen = new Set();
      all = [...prior, ...later].filter((x) => !x.recalled_at && !seen.has(x.id) && seen.add(x.id)).sort((a, b) => a.seq - b.seq);
    }
    const lines = all.filter(drawable);
    let at = lines.findIndex((x) => x.seq >= seq);
    if (at < 0) at = lines.length;
    return lines.slice(Math.max(0, at - before), at + after);
  }
