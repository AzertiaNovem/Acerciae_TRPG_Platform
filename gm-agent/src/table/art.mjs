// art: table is the explicit runtime context supplied by Table; no service singleton.
import { randomUUID } from "node:crypto";
import { MAX_CHARACTERS, USUAL, illustrationFailure, lineRows, normalizeIllustration, pickEventMoment, pickScenarioMoment, scenarioLines } from "../illustrations.mjs";
import { PART_LINES, PICK_BUDGET, artRequest, artText, chooseEntries, drawable, isArtLine, parts, pickRequestedMoment, playLength } from "../plotArt.mjs";
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

// ---- outfits: each pictured character in the outfit that suits the moment, else in what they wear now
// The platform's `outfits` field for a picture of `ids`: {characterId: outfitId, or "" for the usual look} for each
// character the art director dressed in another outfit than the one worn now. An outfit name that matches none of
// theirs, or the outfit worn now, is left out: they are drawn in what they wear now.
export function outfitRequest(table, ids, chosen = {}) {
    const out = {};
    for (const [name, choice] of Object.entries(chosen ?? {})) {
      const c = table.characters.find((x) => x.id === table.characterByName(name)?.id);
      if (!c || !ids.includes(c.id) || !c.outfits?.length) continue;
      const pick = norm(choice);
      const id = pick === USUAL || /^(usual|base|default|none)\b/.test(pick) ? "" : c.outfits.find((o) => norm(o.name) === pick)?.id ?? null;
      if (id === null || id === (c.outfit_id ?? "")) continue;
      out[c.id] = id;
    }
    return out;
  }

// What the art director needs to dress the cast: [{name, wearing, worn, outfits: [{name, attire}]}] for the characters
// among `names` that have outfits. `worn` is the outfit of their newest line among `lines` ("" for the usual look),
// undefined when none of these lines records it.
export async function wardrobe(table, names, lines = []) {
    const out = [];
    for (const c of table.characters.filter((x) => names.includes(x.name) && x.outfits?.length)) {
      const outfits = await outfitsOf(table, c);
      if (!outfits.length) continue;
      const last = lines.findLast((m) => m.character_id === c.id && m.outfit_id !== undefined);
      const worn = last ? (last.outfit_id ? outfits.find((o) => o.id === last.outfit_id)?.name ?? null : "") : undefined;
      out.push({ name: c.name, wearing: c.outfit_name ?? (c.outfit_id ? outfits.find((o) => o.id === c.outfit_id)?.name ?? null : null), worn, outfits });
    }
    return out;
  }

// A character's outfits with their attire (the character list names them only): read from the character's page once,
// again when the list of outfits changes or the character is updated.
async function outfitsOf(table, c) {
    const sig = c.outfits.map((o) => o.id).join(",");
    const cached = table.outfitCache.get(c.id);
    if (cached?.sig === sig) return cached.list;
    const space = await table.api.characterSpace(table.channelId, c.id).catch(() => null);
    const list = (space?.outfits ?? c.outfits).map((o) => ({ id: o.id, name: o.name, attire: o.attire ?? "" }));
    table.outfitCache.set(c.id, { sig, list });
    return list;
  }

export async function requestIllustration(table, windowId, { text, who, orientation, outfits = {} }) {
    const ids = [...new Set(who.map((n) => table.characterByName(n)?.id).filter(Boolean))].slice(0, MAX_CHARACTERS);
    const dress = outfitRequest(table, ids, outfits);
    try {
      const job = await table.api.illustrate(table.channelId, windowId, { prompt: text, character_ids: ids, orientation, allow_cloud: table.cfg.illustrations?.allowCloud !== false, request_id: randomUUID(), ...(Object.keys(dress).length ? { outfits: dress } : {}) });
      const dressed = (id) => (id in dress ? ` in ${dress[id] ? `"${table.characters.find((c) => c.id === id)?.outfits?.find((o) => o.id === dress[id])?.name}"` : USUAL}` : "");
      table.log(`illustration requested in "${table.windowName(windowId)}"${ids.length ? ` with ${ids.map((id) => `${table.nameOf(id)}${dressed(id)}`).join(", ")}` : ""}: ${text.slice(0, 100)}`);
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
      cast, lines: scenarioLines(lines, (id) => table.nameOf(id)), drawn: table.drawnIn(scenario), wardrobe: await wardrobe(table, cast, lines) });
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
        cast, lines: scenarioLines(thread.lines, (id) => table.nameOf(id)), drawn: table.drawnIn(ending.scenario), wardrobe: await wardrobe(table, cast, thread.lines) });
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

const MARGIN = 10;          // lines kept on each side of a run of recent play or of a zoomed part
const SCENE_PAGES = 10;     // pages of 200 lines read back from the platform for a scenario older than the local copy

export async function drawPastPlot(table, m, request) {
    const user = m.author_id;
    // Every window of play, other players' and co-players' scenes too (a picture of someone else's scene is fine at a
    // casual table); never a table window (the planner window, phones, the phone log).
    const windows = table.windows.filter((w) => !table.isTableWindow(w.id));
    if (!windows.length) return "notFound";
    const nameOf = (id) => table.nameOf(id);
    const mine = table.characters.filter((c) => c.user_id === user && table.isPc(c.id)).map((c) => c.name);
    const cast = table.characters.filter((c) => table.isPc(c.id) || table.roster.isCoplayer(c.id) || table.roster.isNpc(c.id)).map((c) => c.name);
    const entries = await storyIndex(table, windows, nameOf);
    if (!entries.length) return "notFound";
    // By meaning: the model reads the index and names the entries that hold the moment, best first.
    const choice = await chooseEntries(table.llm, { request, requester: mine, cast, entries });
    table.log(`picture request: looking in ${choice.keys.join(", ") || "nothing"}${choice.why ? ` (${choice.why})` : ""}`);
    // The best two are read in full, one after the other, until the moment is found.
    for (const key of choice.keys.slice(0, 2)) {
      const entry = entries.find((e) => e.key === key);
      const found = await entryLines(table, entry, windows);
      if (!found.lines.length) continue;
      const lines = await zoomIn(table, { request, requester: mine, cast, lines: found.lines, nameOf });
      const moment = await pickRequestedMoment(table.llm, { language: table.language, request, era: table.channel.era ?? "", cast, window: table.windowName(found.windowId),
        lines: scenarioLines(lines, nameOf, PICK_BUDGET), wardrobe: await wardrobe(table, cast, lines) });
      if (!moment.found) { table.log(`picture request: not in ${key}`); continue; }
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
    return "notFound";
  }

// The index of the whole story: the scenarios (S…), and for each window of play the GM's summaries of its earlier
// play (C…) and its play since the last summary in runs of PART_LINES lines (R…).
async function storyIndex(table, windows, nameOf) {
    const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
    const scenes = ((await table.api.scenes(table.channelId).catch(() => [])) ?? []).filter((x) => x.title || x.summary)
      .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
    const entries = scenes.map((x, i) => ({ key: `S${i + 1}`, kind: "scenario", scene: x,
      label: `scenario "${x.title || "(untitled)"}"${x.location ? ` @ ${x.location}` : ""}${x.narrative_time ? `, ${x.narrative_time}` : ""}`, text: clip(x.summary, 500) || "(no summary)" }));
    let c = 0, r = 0;
    for (const w of windows) {
      const chapters = table.memory.gmChapters(w.id);
      for (const ch of chapters) entries.push({ key: `C${++c}`, kind: "chapter", windowId: w.id, fromSeq: ch.fromSeq, toSeq: ch.toSeq, label: `summary of earlier play in "${w.name}"`, text: clip(ch.text, 900) });
      const after = chapters.length ? Math.max(...chapters.map((x) => x.toSeq)) : 0;
      for (const run of parts(table.history.lines(w.id, { after }).filter(drawable))) {
        entries.push({ key: `R${++r}`, kind: "part", windowId: w.id, lines: run, rows: lineRows(run, nameOf), label: `play in "${w.name}", #${run[0].seq}–#${run.at(-1).seq}` });
      }
    }
    return entries;
  }

// The drawable lines an index entry stands for, with the window they are in: a run of recent play with a few lines on
// each side; a summary's lines; a scenario's lines in the window that played most of it.
async function entryLines(table, entry, windows) {
    if (!entry) return { windowId: null, lines: [] };
    if (entry.kind === "scenario") return sceneLines(table, entry.scene, windows);
    const all = table.history.lines(entry.windowId).filter(drawable);
    if (entry.kind === "chapter") return { windowId: entry.windowId, lines: all.filter((x) => x.seq >= entry.fromSeq && x.seq <= entry.toSeq) };
    const from = all.findIndex((x) => x.seq === entry.lines[0].seq), to = all.findIndex((x) => x.seq === entry.lines.at(-1).seq);
    return { windowId: entry.windowId, lines: from < 0 || to < 0 ? entry.lines : all.slice(Math.max(0, from - MARGIN), to + MARGIN + 1) };
  }

// A scenario's lines in the window that played most of it. Where the local copy of a window begins inside the
// scenario, or after it, the older lines are read from the platform (at most SCENE_PAGES pages a window).
async function sceneLines(table, scene, windows) {
    let best = { windowId: null, lines: [] };
    for (const w of windows) {
      const stored = table.history.lines(w.id);
      let lines = stored.filter((x) => x.scene_id === scene.id);
      const first = stored[0];
      if (first && (first.scene_id === scene.id || (!lines.length && Date.parse(first.created_at) > Date.parse(scene.created_at)))) {
        let beforeSeq = first.seq;
        for (let page = 0; page < SCENE_PAGES; page++) {
          const got = ((await table.api.messages(table.channelId, w.id, 200, beforeSeq).catch(() => null)) ?? []).filter((x) => !x.recalled_at);
          if (!got.length) break;
          lines = [...got.filter((x) => x.scene_id === scene.id), ...lines];
          beforeSeq = got[0].seq;
          if (got.length < 200 || (lines.length && got[0].scene_id !== scene.id)) break;   // the window's start, or before the scenario
        }
      }
      lines = lines.filter(drawable);
      if (lines.length > best.lines.length) best = { windowId: w.id, lines };
    }
    return best;
  }

// Narrows a stretch of play too long for the picker: split into parts (at most 24), the model names the part that
// holds the moment, and that part with a few lines on each side is kept; at most three rounds.
async function zoomIn(table, { request, requester, cast, lines, nameOf }) {
    let current = lines;
    for (let round = 0; round < 3 && playLength(lineRows(current, nameOf)) > PICK_BUDGET; round++) {
      const runs = parts(current, PART_LINES, 24);
      const entries = runs.map((run, i) => ({ key: `P${i + 1}`, rows: lineRows(run, nameOf), label: `#${run[0].seq}–#${run.at(-1).seq}` }));
      const choice = await chooseEntries(table.llm, { request, requester, cast, entries, zoom: true });
      const i = entries.findIndex((e) => e.key === choice.keys[0]);
      if (i < 0) break;
      table.log(`picture request: zoomed into ${entries[i].label}`);
      current = [...(runs[i - 1]?.slice(-MARGIN) ?? []), ...runs[i], ...(runs[i + 1]?.slice(0, MARGIN) ?? [])];
    }
    return current;
  }
