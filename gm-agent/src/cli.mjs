#!/usr/bin/env node
// acerciae-gm: an AI Game Master for an Acerciae channel.
//   setup   sign in, create or attach to a channel the account is GM of, and create the co-players (role cards by the LLM)
//   run     play: the GM and real NPCs answer the table, then the co-players act; side timelines and quiet windows
//           move on their own clock
//   split   send investigators off to a place of their own (a window with the GM); rejoin brings a thread back
//   advance open the next scenario now
//   status  show the channel, the cast, the timelines and how each role is fed (read-only)
//   date    casual games: move the story's calendar on (or to a later date); bond records or ends a relationship
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Api } from "./api.mjs";
import { buildConfig, configPath, loadConfigFile, loadEnvFile, parseArgs } from "./config.mjs";
import { createLlm } from "./llm/index.mjs";
import { withProgress } from "./llm/progress.mjs";
import { Realtime } from "./realtime.mjs";
import { Roster, openSeat, openWindows } from "./roles/roster.mjs";
import { generateCoplayer, saveCharacter } from "./roles/cardgen.mjs";
import { completeExistingCharacter } from "./roles/complete.mjs";
import { SECRETS_MAX, WORLD_MAX, readSetting } from "./improv.mjs";
import { channelListAdvice, chooseChannel, keptChannels, noChannelAdvice } from "./channels.mjs";
import { Store, billableTokens } from "./store.mjs";
import { StateConflict, acquireLock, appendInbox, drainInbox, inboxPath, loadState, lockHolder, saveState } from "./state.mjs";
import { Table, languageName } from "./loop.mjs";
import { Timelines } from "./timelines.mjs";
import { RULE_SYSTEMS, rulesProfile, ruleSystemOf } from "./rules/index.mjs";
import { describeCalendar, renderCalendar } from "./calendar.mjs";
import { Guard } from "./whereabouts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function signIn(cfg) {
  if (!cfg.username || !cfg.password) throw new Error("set GM_USERNAME and GM_PASSWORD (or --username / --password)");
  const api = new Api(cfg.apiBase);
  try {
    await api.login(cfg.username, cfg.password);
  } catch (e) {
    if (!(cfg.register && (e.status === 401 || e.status === 400 || e.status === 404))) throw e;
    await api.register(cfg.username, cfg.password, cfg.displayName);
    log(`registered ${cfg.username}`);
  }
  return api;
}

// The channel to keep: --channel (the account must already be GM there). Without it, `setup` lists the channels the
// account keeps and asks which one (on a terminal), or says how to create one in the web app. Nothing is created on
// the platform unless `setup --create` asks for a new server and channel.
async function resolveChannel(api, cfg, { create }) {
  if (cfg.channelId) {
    const ch = await api.channel(cfg.channelId);
    if (ch.my_role !== "gm") throw new Error(`${cfg.username} is not the GM of channel ${cfg.channelId}; add it as GM first`);
    if (ch.rule_system && !RULE_SYSTEMS.includes(ch.rule_system)) throw new Error(`channel ${cfg.channelId} plays ${ch.rule_system}; the GM agent supports ${RULE_SYSTEMS.join(" and ")}`);
    return { channel: ch, created: false };
  }
  if (!create) throw new Error("set CHANNEL_ID (or --channel); `setup` lists the channels this account keeps");
  if (!cfg.create) {
    const kept = await keptChannels(api);
    if (!kept.length) throw new Error(noChannelAdvice(cfg.username));
    if (!process.stdin.isTTY) throw new Error(channelListAdvice(kept));
    const picked = await chooseChannel(kept);
    if (!picked) throw new Error("no channel chosen");
    return resolveChannel(api, { ...cfg, channelId: picked.id }, { create });
  }
  let serverId = cfg.serverId;
  if (!serverId) { serverId = (await api.createServer(cfg.serverName)).id; log(`created server "${cfg.serverName}"`); }
  // Casual mode's phones are private only when each player is in a group of their own.
  const ch = await api.createChannel(serverId, { name: cfg.channelName, knowledge_mode: cfg.casual ? "isolated" : "public", rule_system: cfg.ruleSystem });
  if (cfg.era) await api.updateChannel(ch.id, { era: cfg.era });
  log(`created channel "${cfg.channelName}"`);
  // A channel this client made has no players yet: an invite code gets them onto the server.
  let invite = null;
  try { invite = await api.createInvite(serverId); } catch { /* not a maintainer, or the server is closed */ }
  return { channel: await api.channel(ch.id), created: true, invite };
}

function seatWindows(cfg, windows) {
  const main = windows.find((w) => w.kind === "main") ?? windows[0];
  if (!cfg.coplayerWindows.length) return main ? [main.id] : [];
  return windows.filter((w) => cfg.coplayerWindows.some((x) => x === w.id || x.toLowerCase() === w.name.toLowerCase())).map((w) => w.id);
}

async function setup(cfg) {
  const api = await signIn(cfg);
  const { channel, created, invite } = await resolveChannel(api, cfg, { create: true });
  const llm = withProgress(createLlm(cfg.llm), log);
  const settings = await api.serverSettings(channel.server_id);
  const language = languageName(cfg.language || settings?.language || "en");
  // Point buy is the channel's own option (its GM's); servers before that had a server feature.
  const pointsMode = Boolean(channel?.point_buy ?? settings?.features?.coc7_points);
  // The channel's rule system decides the cards, the dice and the words (rules/*.mjs).
  const profile = rulesProfile(ruleSystemOf(channel));
  const rules = await profile.fetchRules(api);
  log(`rules: ${profile.id === "dnd2024" ? "D&D 2024 (SRD 5.2)" : "Call of Cthulhu 7e"}${pointsMode ? ", point buy on" : ""}${profile.id === "dnd2024" ? `; new co-players at level ${cfg.level}` : ""}`);
  const windows = await api.windows(channel.id);
  const seats = seatWindows(cfg, windows);
  const state = loadState(cfg.stateDir, channel.id) ?? { channelId: channel.id, serverId: channel.server_id };
  delete state.version;
  // Co-players are GM-cast PCs (owned by this account): any the Keeper already made are adopted, and only the
  // missing ones are generated.
  const me = api.user ?? (await api.me());
  const known = new Set((state.coplayers ?? []).map((c) => c.characterId));
  const roster = new Roster(state).reconcile(await api.characters(channel.id), seats, { castBy: me.id });
  // Improvisation mode: the world setting the co-players are written into (and, later, the table plays in).
  const improv = improvChange(cfg, state.improv);
  const world = ((improv?.on ?? state.improv?.on) && (improv?.world ?? state.improv?.world)) || "";
  for (const c of roster.coplayers) if (!known.has(c.characterId)) log(`using ${c.name}, a PC this account already owns, as a co-player`);
  // While `run` keeps the channel it is the only writer; it picks new co-players up by their owner.
  const running = Boolean(lockHolder(cfg.stateDir, channel.id));
  if (improv && running) appendInbox(cfg.stateDir, channel.id, { cmd: "world", ...improv });
  else if (improv) state.improv = { ...(state.improv ?? {}), ...improv };
  if (cfg.casual !== undefined) {
    if (running) appendInbox(cfg.stateDir, channel.id, { cmd: "casual", on: cfg.casual });
    else state.casual = { ...(state.casual ?? {}), on: cfg.casual };
    log(`casual mode ${cfg.casual ? "on: each player character gets a phone when run starts" : "off"}${cfg.casual && channel.knowledge_mode !== "isolated" ? ` — but this channel's knowledge mode is ${channel.knowledge_mode}: phones need an isolated channel with one player per group` : ""}`);
  }
  if (improv) log(`improvisation mode ${improv.on ? `on (world ${String(improv.world ?? state.improv?.world ?? "").length} characters)` : "off"}${running ? "; handed to the running table" : "; the world setting is posted in the Main Chat when run starts"}`);

  for (const existing of roster.coplayers) {
    await completeExistingCharacter(api, llm, channel.id, existing.characterId, { rules, language, era: channel.era, pointsMode, world, profile, level: cfg.level, log });
  }

  const missing = cfg.coplayers - roster.coplayers.length;
  if (missing < 0) log(`the channel already has ${roster.coplayers.length} co-players (asked for ${cfg.coplayers}); keeping them`);
  for (let i = 0; i < missing; i++) {
    log(`preparing co-player ${roster.coplayers.length + 1}/${cfg.coplayers} with ${cfg.llm.provider} / ${cfg.llm.model || "mock"}`);
    const characters = await api.characters(channel.id);
    const takenNames = characters.map((c) => c.name);
    const partyNotes = characters.map((c) => `- ${c.name}${roster.isCoplayer(c.id) ? " (co-player)" : c.kind === "pc" ? " (player character)" : " (NPC)"}`).join("\n");
    const args = { language, era: channel.era, rules, pointsMode, takenNames, partyNotes, index: roster.coplayers.length, total: cfg.coplayers, world, profile, level: cfg.level, log };
    const generated = await generateCoplayer(llm, args);
    const saved = await saveCharacter(api, channel.id, generated, { kind: "coplayer", rules, llm, language, pointsMode, profile, level: cfg.level });
    roster.coplayers.push({ characterId: saved.id, name: saved.name, persona: saved.persona, speakingStyle: saved.speakingStyle, seats: seats.map((w) => openSeat(w)) });
    if (!running) saveState(cfg.stateDir, { ...loadState(cfg.stateDir, channel.id), ...state, ...roster.toJSON() });
    log(`co-player ${roster.coplayers.length}/${cfg.coplayers}: ${saved.name} (${profile.castNote(saved.card) || saved.card.basic?.occupation || profile.vocab.pc})`);
  }
  if (!running) saveState(cfg.stateDir, { ...loadState(cfg.stateDir, channel.id), ...state, ...roster.toJSON() });
  const file = running ? "(kept by the running table)" : `${cfg.stateDir}/${channel.id}.json`;
  console.log(`\nchannel: ${channel.name}${created ? " (created)" : ""}\n  CHANNEL_ID=${channel.id}\n  server: ${channel.server_id}${invite ? `\n  invite code for players: ${invite.code}` : ""}\n  state: ${file}\n  co-players: ${roster.coplayers.map((c) => c.name).join(", ") || "(none)"}\n  LLM: ${cfg.llm.provider}${cfg.llm.model ? ` ${cfg.llm.model}` : ""}${cfg.llm.provider === "mock" ? " (placeholder text, for testing only)" : ""}\n\n${created ? "Invite players to the server with the code and add them to the channel in the web app, then: " : "Make sure the players are channel members, then: "}CHANNEL_ID=${channel.id} npm start`);
}

// The table for a channel: roster, timelines, guard and scenario from the state file. `write` saves changes back
// (compare-and-swap); read-only commands pass write:false and never touch the file.
// A save refused because another process changed the file is fatal: `onConflict` decides how to stop (default: throw).
async function openTable(cfg, { llm = null, plannerLlm = null, write = true, heal = false, deferArrivals = false, channel: known = null, onConflict = (e) => { throw e; } } = {}) {
  const api = known?.api ?? (await signIn(cfg));
  const channel = known?.channel ?? (await resolveChannel(api, cfg, { create: false })).channel;
  const state = loadState(cfg.stateDir, channel.id) ?? { channelId: channel.id, serverId: channel.server_id };
  let version = Number(state.version) || 0;
  const persist = write
    ? (t) => {
      const next = { ...state, channelId: channel.id, serverId: channel.server_id, ...t.roster.toJSON(), timelines: t.timelines.toJSON(), guard: t.guard.toJSON(), scenario: t.scenario, improv: t.improv, casual: t.casual, planner: t.planner, calendar: t.calendar, bonds: t.bonds, journal: t.journal, owedArrivals: t.owedArrivals };
      delete next.version;
      try { version = saveState(cfg.stateDir, next, { expectVersion: version }); }
      catch (e) { if (!(e instanceof StateConflict)) throw e; onConflict(e); }
    }
    : () => {};
  const table = new Table({
    api, llm, cfg, channelId: channel.id, store: Store.open(cfg.stateDir, channel.id), roster: new Roster(state), timelines: new Timelines(state.timelines ?? []), guard: new Guard(state.guard ?? {}),
    scenario: state.scenario ?? null, improv: state.improv ?? null, casual: state.casual ?? null, planner: state.planner ?? null, calendar: state.calendar ?? null, bonds: state.bonds ?? null, plannerLlm, journal: state.journal ?? null, owedArrivals: state.owedArrivals ?? [], deferArrivals, log, persist,
  });
  await table.init({ heal });
  if (write) table.save();
  if (write && table.splitWarning && cfg.timelineAuto) log(`note: ${table.splitWarning}`);
  return { api, channel, table };
}

async function run(cfg) {
  // The lock comes first: healing an interrupted split and every save need to be this process's alone.
  const signedIn = await signIn(cfg);
  const { channel: ch } = await resolveChannel(signedIn, cfg, { create: false });
  const release = acquireLock(cfg.stateDir, ch.id);
  if (!release) throw new Error(`another process (pid ${lockHolder(cfg.stateDir, ch.id) ?? "?"}) already keeps this channel`);
  // Another writer changed the state file under us: continuing would act on a stale table, so stop loudly.
  const onConflict = (e) => { log(`stopping: ${e.message}. Restart \`run\` to continue from the file.`); release(); process.exit(3); };
  let opened;
  // The story planner's own model, when it differs from the GM's (otherwise the table reuses the GM's instance).
  const sameModel = ["provider", "apiBase", "model", "effort", "apiKey"].every((k) => cfg.planner[k] === cfg.llm[k]);
  const plannerLlm = sameModel ? null : withProgress(createLlm(cfg.planner), log);
  try { opened = await openTable(cfg, { llm: withProgress(createLlm(cfg.llm), log), plannerLlm, heal: true, channel: { api: signedIn, channel: ch }, onConflict }); }
  catch (e) { release(); throw e; }
  const { api, channel, table } = opened;
  const roster = table.roster;
  const rt = new Realtime({ apiBase: cfg.apiBase, token: api.token, channelId: channel.id, log });
  rt.on("event", (ev) => { try { table.onEvent(ev)?.catch?.((e) => log(`event ${ev.type}: ${e.message}`)); } catch (e) { log(`event ${ev.type}: ${e.message}`); } });
  rt.on("reconnected", () => table.refresh().catch(() => {}));
  rt.start();
  table.startTicker();
  // CLI commands (split, rejoin, advance) arrive in the inbox; this process is the only one that writes the state.
  const take = () => {
    for (const cmd of drainInbox(cfg.stateDir, channel.id)) {
      log(`command from the CLI: ${cmd.cmd}`);
      table.queue = table.queue.then(() => table.command(cmd)).catch((e) => log(`command ${cmd.cmd} failed: ${e.message}`));
    }
  };
  const inbox = inboxPath(cfg.stateDir, channel.id);
  fs.watchFile(inbox, { interval: 1000 }, take);
  take();
  log(`keeping "${channel.name}" in ${table.language}; co-players: ${roster.coplayers.map((c) => c.name).join(", ") || "(none)"}; NPCs: ${roster.npcs.length}; LLM: ${cfg.llm.provider}; autonomy: ${cfg.autonomy ? `on (side every ${cfg.autonomySideIntervalMs / 1000}s, quiet after ${cfg.autonomyQuietMs / 1000}s, idle after ${cfg.autonomyIdleMinutes} min)` : "off"}; planner: ${cfg.planner.enabled ? `${cfg.planner.provider}${cfg.planner.model ? ` ${cfg.planner.model}` : ""} (${cfg.planner.effort})` : "off"}; timelines: ${cfg.timelineAuto ? "proactive" : "model-led"}; scenarios: ${cfg.scenarioAuto ? `GM-driven (≥ ${cfg.scenarioMinMinutes} min, ≥ ${cfg.scenarioMinLines} lines)` : "manual"}`);
  if (cfg.kickoff) {
    const main = table.mainWindow();
    if (main) table.schedule(main.id, { kickoff: true, delay: 0 });
  }
  // Stopping ends the session: one with enough play gets its final review first (a second signal skips it).
  let stopping = false;
  const stop = async () => {
    if (stopping) { log("stopping now, without the final review"); finish(); return; }
    stopping = true;
    table.stopTicker(); fs.unwatchFile(inbox); rt.stop();
    try { if (await table.finishSession()) log("final review done"); } catch (e) { log(`final review failed: ${e.message}`); }
    finish();
  };
  const finish = () => { table.store.close(); release(); process.exit(0); };
  process.on("SIGINT", () => { if (!stopping && cfg.planner.finalReview && table.planner.session?.lines >= cfg.planner.finalReviewMinLines) log("stopping: the session's final review runs first (Ctrl-C again to skip it)"); stop(); });
  process.on("SIGTERM", stop);
}

// A manual command: handed to the running `run` process when there is one, applied here otherwise (under the lock,
// with any arrival left in the state file for the next `run`).
async function manual(cfg, cmd, describe) {
  const api = await signIn(cfg);
  const { channel } = await resolveChannel(api, cfg, { create: false });
  if (lockHolder(cfg.stateDir, channel.id)) {
    appendInbox(cfg.stateDir, channel.id, cmd);
    console.log(`queued for the running table (pid ${lockHolder(cfg.stateDir, channel.id)}): ${describe}`);
    return;
  }
  const release = acquireLock(cfg.stateDir, channel.id);
  if (!release) throw new Error("another process took the channel meanwhile; try again");
  try {
    // A split interrupted half-way is finished only by `run` (it needs the turn loop for its opening turns).
    if (loadState(cfg.stateDir, channel.id)?.journal) throw new Error("a split was interrupted half-way; start `run` to finish it, then try again");
    const { table } = await openTable(cfg, { deferArrivals: true, channel: { api, channel } });
    await table.command(cmd);
    console.log(`${describe}: done. ${table.owedArrivals.length ? "Its opening turn will run when `run` starts." : ""}`);
  } finally { release(); }
}

// What `--improv`, `--world` and `--secrets` change in the improvisation settings (null: nothing given). The texts
// are read from the Keeper's own files.
function improvChange(cfg, current) {
  if (cfg.improv === undefined && !cfg.worldFile && !cfg.secretsFile) return null;
  const on = cfg.improv ?? true;
  const out = { on };
  if (cfg.worldFile) out.world = readSetting(cfg.worldFile, { what: "world", max: WORLD_MAX });
  if (cfg.secretsFile) out.secrets = readSetting(cfg.secretsFile, { what: "secrets", max: SECRETS_MAX });
  if (on && !out.world && !current?.world) throw new Error("improvisation mode needs a world setting: --world <file>");
  return out;
}

// `world --world world.md [--secrets secrets.md] [--improv false]`: improvisation mode's setting, during a campaign.
function world(cfg) {
  const change = improvChange(cfg, null);
  if (!change) throw new Error("world needs --world <file>, --secrets <file> or --improv false");
  return manual(cfg, { cmd: "world", ...change }, `improvisation ${change.on ? "on" : "off"}`);
}

const list = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// `split --who "Alice Hale,Harriet Vance" --place "Old Harbour" [--span long] [--time …] [--opening …]`
// (`--coplayers` and `--name` are accepted as older spellings of --who and --place.)
function split(cfg, args) {
  const who = list(args.who ?? args.coplayers);
  const place = args.place ?? args.name;
  if (!place || !who.length) throw new Error("split needs --who <names, comma-separated> and --place <where they go>");
  return manual(cfg, { cmd: "split", who, place, span: args.span, time: args.time ?? "", opening: args.opening ?? "" }, `split ${who.join(", ")} → ${place}`);
}

// `rejoin --timeline "Old Harbour"` (a thread's name or handle such as T2)
function rejoin(cfg, args) {
  if (!args.timeline) throw new Error("rejoin needs --timeline <thread name or handle>");
  return manual(cfg, { cmd: "rejoin", timeline: args.timeline }, `rejoin ${args.timeline}`);
}

// `advance --title "The next morning" [--location …] [--time …]`: open the next scenario now, without the GM's limits.
function advance(cfg, args) {
  return manual(cfg, { cmd: "advance", title: args.title ?? "", location: args.location ?? "", time: args.time ?? "" }, `advance to ${args.title || "the next scenario"}`);
}

async function status(cfg) {
  const { channel, table } = await openTable(cfg, { write: false });
  const { roster, timelines, windows } = table;
  const wname = (id) => windows.find((w) => w.id === id)?.name ?? id;
  const cname = (id) => table.characters.find((c) => c.id === id)?.name ?? id;
  const holder = lockHolder(cfg.stateDir, channel.id);
  console.log(`channel ${channel.name} (${channel.id}), GM: ${channel.my_role === "gm" ? "yes" : "NO"}; rules: ${table.profile.id === "dnd2024" ? "D&D 2024 (SRD 5.2): Dungeon Master, D20 Tests, initiative" : "Call of Cthulhu 7e"}; ${holder ? `kept by run (pid ${holder})` : "no run process"}`);
  if (table.splitWarning) console.log(`warning: ${table.splitWarning}`);
  console.log("GM and real NPCs share the Keeper's context: all chat, the Keeper board, reminders, script knowledge, documents, highlights.");
  console.log(`real NPCs: ${roster.npcs.map((n) => n.name).join(", ") || "(none)"}`);
  console.log("co-players see only the chat lines their character witnessed, during their seats:");
  for (const c of roster.coplayers) console.log(`  ${c.name} — now in ${openWindows(c).map(wname).join(", ") || "(nowhere)"}; ${c.seats.length} seat(s) so far`);
  console.log("timelines:");
  for (const t of timelines.list) console.log(`  T${t.handle} ${t.name} [${t.status}${t.mergedInto ? ` → ${timelines.get(t.mergedInto)?.name}` : ""}${t.status === "active" && t.id !== "main" ? `, ${t.span}${t.opened ? "" : ", not opened yet"}` : ""}]${t.windowId ? ` in "${wname(t.windowId)}"` : ""}: ${t.members.map(cname).join(", ") || "(no one)"}${t.narrativeTime ? `; ${t.narrativeTime}` : ""}${t.location ? ` @ ${t.location}` : ""}`);
  if (table.owedArrivals.length) console.log(`opening turns waiting for run: ${table.owedArrivals.map((a) => wname(a.windowId)).join(", ")}`);
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const usage = (since) => { const u = table.store.usageSince(since); return `${u.calls} calls, ${billableTokens(u)} billable-equivalent tokens (input ${u.input}, of which ${u.input ? Math.round((u.cacheRead / u.input) * 100) : 0}% read from cache; cache writes ${u.cacheWrite}; output ${u.output})`; };
  console.log(`model usage today: ${usage(day.getTime())}`);
  console.log(`model usage, last 7 days: ${usage(Date.now() - 7 * 86400000)}${cfg.dailyTokenBudget ? `; daily budget for autonomous turns: ${cfg.dailyTokenBudget}` : ""}`);
  const chapters = table.store.db.prepare("SELECT scope LIKE 'coplayer:%' AS cp, count(*) AS n FROM chapters GROUP BY 1").all();
  console.log(`memory: ${table.store.db.prepare("SELECT count(*) AS n FROM lines").get().n} chat lines kept locally; ${chapters.find((x) => !x.cp)?.n ?? 0} Keeper chapter(s), ${chapters.find((x) => x.cp)?.n ?? 0} co-player memory chapter(s); context budgets ${cfg.gmContextTokens} tokens (GM), ${cfg.coplayerContextTokens} (each co-player); prompt cache ${cfg.llm.cacheTtl}`);
  const ca = table.casual;
  console.log(`casual mode: ${ca.on ? (table.splitWarning ? `on, but not active here (${table.splitWarning})` : `on — ${Object.keys(ca.phones).length} phone(s), ${ca.pending.length} text(s) on their way (replies within ${cfg.casualMaxDelayMinutes} min); texts between AI characters in ${ca.log ? `"${wname(ca.log)}"` : "the phone log (opened by run)"}, at most ${cfg.casualAiTextsPerHour} answered an hour, ${cfg.casualAiChain} in a row`) : "off (a solemn game: no phones)"}`);
  console.log(`calendar: ${table.calendarOn() ? `${describeCalendar(table.calendar) || "no date yet (the story planner chooses the first one)"}${table.calendar.log.length ? `; last change by ${table.calendar.log.at(-1).by}` : ""}${table.calendar.routine ? `; routine: ${table.calendar.routine.text}` : ""}` : "off (a solemn game keeps no date; casual mode has one)"}`);
  const nameOf = (id) => table.characters.find((c) => c.id === id)?.name ?? id;
  console.log(`relationships: ${table.bonds.length ? table.bonds.map((b) => `${nameOf(b.a)} — ${nameOf(b.b)}: ${b.kind}${b.secret ? " (secret)" : ""}`).join("; ") : "(none recorded)"}`);
  const pl = table.planner, arc = pl.arc;
  const plMode = !pl.on ? "off" : table.improv.on ? "full plotting" : "pace only: module-led campaign";
  console.log(`story planner: ${pl.on ? `on (${plMode})${arc ? ` — plan v${arc.version}, ${Math.round((Date.now() - Date.parse(arc.updatedAt)) / 60000)} min ago (${arc.trigger}); beat "${arc.beat.title}", verdict: ${arc.verdict?.moveOn ? "move on" : "continue"}; ${arc.threads.length} thread(s)${pl.impulses.length ? `; impulses: ${pl.impulses.map((i) => i.name).join(", ")}` : ""}` : " — no plan yet (needs 10 lines, or `plan now`)"}; automatic after ${cfg.planner.intervalMs / 60000} min and ${cfg.planner.minLines} lines, cooldown ${cfg.planner.cooldownMs / 60000} min, ≤ ${cfg.planner.maxRunsPerHour}/h; model ${cfg.planner.provider}${cfg.planner.model ? ` ${cfg.planner.model}` : ""} effort ${cfg.planner.effort}` : "off"}`);
  const im = table.improv;
  const notes = pl.table;
  console.log(`planner window: ${pl.window ? `"${wname(pl.window)}" — ${notes.filter((n) => n.kind === "correction").length} correction(s), ${notes.filter((n) => n.kind === "wish").length} wish(es) standing${pl.inbox.length ? `; ${pl.inbox.length} line(s) not read yet` : ""}` : cfg.planner.wishWindow && pl.on ? "opened by run" : "off"}${notes.length ? `\n  ${notes.map((n) => `${n.id} [${n.kind}] ${n.text}`).join("\n  ")}` : ""}`);
  const ses = pl.session;
  console.log(`final review: ${cfg.planner.finalReview && pl.on ? `on — after a session of ≥ ${cfg.planner.finalReviewMinLines} player lines, once nobody has written for ${cfg.autonomyIdleMinutes} min (or when run stops); moves the calendar up to ${cfg.planner.finalReviewMaxDays} days` : "off"}${ses ? `; session in progress: ${ses.lines} player line(s) since ${new Date(ses.startedAt).toISOString().slice(0, 16).replace("T", " ")}` : ""}${pl.between ? "; the next session opens from the last review" : ""}`);
  console.log(`improvisation: ${im.on ? `on — world ${im.world.length} characters (${im.published.hash ? "posted in the Main Chat" : "not posted yet; run posts it"}), secrets ${im.secrets.length} characters, ${im.truths.length} hidden truth(s) decided in play; the module's script knowledge and hints are ignored` : "off"}`);
  console.log(`autonomy: ${cfg.autonomy ? `on — side timelines every ${cfg.autonomySideIntervalMs / 1000}s; a shared window moves after ${cfg.autonomyQuietMs / 1000}s of silence, up to ${cfg.autonomyQuietTurns} times; pauses after ${cfg.autonomyIdleMinutes} min without a human line; at most ${cfg.autonomyMaxTurnsPerHour} autonomous turns an hour` : "off"}`);
  console.log(`timelines: ${cfg.timelineAuto ? `proactive (at most ${cfg.timelineMaxActive} at once, ${cfg.timelineMaxArrivalsPerHour} arrivals an hour)` : "model-led (TIMELINE_AUTO=false)"}; scenarios: ${cfg.scenarioAuto ? `GM-driven from the Main Chat after ${cfg.scenarioMinMinutes} min and ${cfg.scenarioMinLines} lines; never during a short split` : "manual only"}`);
}

const args = parseArgs(process.argv.slice(2));
loadEnvFile(args.env ?? path.join(process.cwd(), ".env"));
loadEnvFile(path.join(here, "..", ".env"));
const cfg = buildConfig(args, process.env, loadConfigFile(configPath(args, process.env, process.cwd(), path.join(here, ".."))));
for (const w of cfg.warnings) console.error(`warning: ${w}`);
const command = args._[0] ?? "run";
// `plan now|on|off|show [--full]`: the story planner, during a campaign. `show` is read-only.
async function plan(cfg, args) {
  const v = String(args._?.[1] ?? "").toLowerCase();
  if (v === "show") {
    const { table } = await openTable(cfg, { write: false });
    const { renderStoryPlan } = await import("./planner.mjs");
    if (!table.planner.arc) { console.log("no story plan yet"); return; }
    console.log(renderStoryPlan(table.planner.arc, 100000));
    if (table.planner.impulses.length) console.log(`\nimpulses: ${table.planner.impulses.map((i) => `${i.name}: "${i.text}"`).join("\n          ")}`);
    if (args.full) { const rec = table.store.latestPlan(); if (rec) console.log(`\n--- v${rec.version} (${rec.trigger}) in full ---\n${JSON.stringify(rec.record, null, 2)}`); }
    return;
  }
  if (!["now", "on", "off"].includes(v)) throw new Error("plan needs now, on, off or show");
  return manual(cfg, { cmd: "plan", action: v }, `story planner: ${v}`);
}

// `date [--days N] [--time morning] [--set 1925-03-14] [--why …]`: the story's calendar in a casual game (forward
// only); no flag shows it.
async function date(cfg, args) {
  if (args.days === undefined && args.set === undefined && args.time === undefined) {
    const { table } = await openTable(cfg, { write: false });
    console.log(renderCalendar(table.calendar));
    return;
  }
  const days = args.days === undefined ? 0 : Number(args.days);
  if (!Number.isFinite(days) || days < 0) throw new Error("date --days needs a number of days, 0 or more");
  return manual(cfg, { cmd: "date", days, date: args.set === undefined ? undefined : String(args.set), time: args.time === undefined ? undefined : String(args.time), why: args.why ? String(args.why) : undefined }, `calendar${days ? ` +${days} day(s)` : ""}${args.set ? ` to ${args.set}` : ""}`);
}

// `bond "<a>" "<b>" "<kind>" [--note …] [--secret]` records a relationship; `bond end "<a>" "<b>" [kind]` ends it.
function bond(cfg, args) {
  const [, first, ...rest] = args._ ?? [];
  const end = first === "end";
  const [a, b, kind] = end ? rest : [first, ...rest];
  if (!a || !b || (!end && !kind)) throw new Error('bond needs "<character>" "<character>" "<kind>" (or bond end "<a>" "<b>" [kind])');
  return manual(cfg, { cmd: "bond", a, b, kind: kind ?? "", note: args.note === undefined ? undefined : String(args.note), secret: args.secret === undefined ? undefined : args.secret === true || args.secret === "true", end }, `${end ? "end " : ""}bond ${a} — ${b}${kind ? `: ${kind}` : ""}`);
}

// `casual on|off`: casual mode's phones, during a campaign.
function casual(cfg, args) {
  const v = String(args._?.[1] ?? (cfg.casual === undefined ? "" : cfg.casual)).toLowerCase();
  if (!["on", "off", "true", "false"].includes(v)) throw new Error("casual needs on or off");
  const on = v === "on" || v === "true";
  return manual(cfg, { cmd: "casual", on }, `casual mode ${on ? "on" : "off"}`);
}

const commands = { setup, run, status, split, rejoin, advance, world, casual, plan, date, bond };
if (!commands[command]) {
  console.error(`usage: acerciae-gm <setup|run|status|split|rejoin|advance|world|casual|plan|date|bond> [--coplayers N] [--channel ID] [--kickoff] …  (see README.md)`);
  process.exit(2);
}
commands[command](cfg, args).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
