#!/usr/bin/env node
// acerciae-gm: an AI Game Master for an Acerciae channel.
//   setup   sign in, create or attach to a channel the account is GM of, and create the co-players (role cards by the LLM)
//   run     play: the GM and real NPCs answer the table, then the co-players act; side timelines and quiet windows
//           move on their own clock
//   split   send investigators off to a place of their own (a window with the GM); rejoin brings a thread back
//   advance open the next scenario now
//   status  show the channel, the cast, the timelines and how each role is fed (read-only)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Api } from "./api.mjs";
import { buildConfig, loadEnvFile, parseArgs } from "./config.mjs";
import { createLlm } from "./llm/index.mjs";
import { withProgress } from "./llm/progress.mjs";
import { Realtime } from "./realtime.mjs";
import { Roster, openSeat, openWindows } from "./roles/roster.mjs";
import { generateCoplayer, saveCharacter } from "./roles/cardgen.mjs";
import { completeExistingCharacter } from "./roles/complete.mjs";
import { StateConflict, acquireLock, appendInbox, drainInbox, inboxPath, loadState, lockHolder, saveState } from "./state.mjs";
import { Table, languageName } from "./loop.mjs";
import { Timelines } from "./timelines.mjs";
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

// The channel to keep: --channel (must already be GM there), or a new server and channel created by this account.
async function resolveChannel(api, cfg, { create }) {
  if (cfg.channelId) {
    const ch = await api.channel(cfg.channelId);
    if (ch.my_role !== "gm") throw new Error(`${cfg.username} is not the GM of channel ${cfg.channelId}; add it as GM first`);
    return { channel: ch, created: false };
  }
  if (!create) throw new Error("set CHANNEL_ID (or --channel); run `setup` first to create one");
  let serverId = cfg.serverId;
  if (!serverId) { serverId = (await api.createServer(cfg.serverName)).id; log(`created server "${cfg.serverName}"`); }
  const ch = await api.createChannel(serverId, { name: cfg.channelName, knowledge_mode: "public", rule_system: "coc7" });
  if (cfg.era) await api.updateChannel(ch.id, { era: cfg.era });
  log(`created channel "${cfg.channelName}"`);
  return { channel: await api.channel(ch.id), created: true };
}

function seatWindows(cfg, windows) {
  const main = windows.find((w) => w.kind === "main") ?? windows[0];
  if (!cfg.coplayerWindows.length) return main ? [main.id] : [];
  return windows.filter((w) => cfg.coplayerWindows.some((x) => x === w.id || x.toLowerCase() === w.name.toLowerCase())).map((w) => w.id);
}

async function setup(cfg) {
  const api = await signIn(cfg);
  const { channel } = await resolveChannel(api, cfg, { create: true });
  const llm = withProgress(createLlm(cfg.llm), log);
  const settings = await api.serverSettings(channel.server_id);
  const language = languageName(cfg.language || settings?.language || "en");
  const pointsMode = Boolean(settings?.features?.coc7_points);
  const rules = await api.coc7Rules();
  const windows = await api.windows(channel.id);
  const seats = seatWindows(cfg, windows);
  const state = loadState(cfg.stateDir, channel.id) ?? { channelId: channel.id, serverId: channel.server_id };
  delete state.version;
  const roster = new Roster(state).reconcile(await api.characters(channel.id), seats);
  // While `run` keeps the channel it is the only writer; it picks new co-players up by their mark.
  const running = Boolean(lockHolder(cfg.stateDir, channel.id));

  for (const existing of roster.coplayers) {
    await completeExistingCharacter(api, llm, channel.id, existing.characterId, { rules, language, era: channel.era, pointsMode, log });
  }

  const missing = cfg.coplayers - roster.coplayers.length;
  if (missing < 0) log(`the channel already has ${roster.coplayers.length} co-players (asked for ${cfg.coplayers}); keeping them`);
  for (let i = 0; i < missing; i++) {
    log(`preparing co-player ${roster.coplayers.length + 1}/${cfg.coplayers} with ${cfg.llm.provider} / ${cfg.llm.model || "mock"}`);
    const characters = await api.characters(channel.id);
    const takenNames = characters.map((c) => c.name);
    const partyNotes = characters.map((c) => `- ${c.name}${c.kind === "pc" ? " (player character)" : roster.isCoplayer(c.id) ? " (co-player)" : " (NPC)"}`).join("\n");
    const args = { language, era: channel.era, rules, pointsMode, takenNames, partyNotes, index: roster.coplayers.length, total: cfg.coplayers };
    const generated = await generateCoplayer(llm, args);
    const saved = await saveCharacter(api, channel.id, generated, { kind: "coplayer", rules, llm, language, pointsMode });
    roster.coplayers.push({ characterId: saved.id, name: saved.name, persona: saved.persona, speakingStyle: saved.speakingStyle, seats: seats.map((w) => openSeat(w)) });
    if (!running) saveState(cfg.stateDir, { ...loadState(cfg.stateDir, channel.id), ...state, ...roster.toJSON() });
    log(`co-player ${roster.coplayers.length}/${cfg.coplayers}: ${saved.name} (${saved.card.basic.occupation || "investigator"})`);
  }
  if (!running) saveState(cfg.stateDir, { ...loadState(cfg.stateDir, channel.id), ...state, ...roster.toJSON() });
  const file = running ? "(kept by the running table)" : `${cfg.stateDir}/${channel.id}.json`;
  let invite = null;
  try { invite = await api.createInvite(channel.server_id); } catch { /* not a maintainer, or the server is closed */ }
  console.log(`\nchannel: ${channel.name}\n  CHANNEL_ID=${channel.id}\n  server: ${channel.server_id}${invite ? `\n  invite code for players: ${invite.code}` : ""}\n  state: ${file}\n  co-players: ${roster.coplayers.map((c) => c.name).join(", ") || "(none)"}\n  LLM: ${cfg.llm.provider}${cfg.llm.model ? ` ${cfg.llm.model}` : ""}${cfg.llm.provider === "mock" ? " (placeholder text, for testing only)" : ""}\n\nInvite players to the channel in the web app, then: CHANNEL_ID=${channel.id} npm start`);
}

// The table for a channel: roster, timelines, guard and scenario from the state file. `write` saves changes back
// (compare-and-swap); read-only commands pass write:false and never touch the file.
// A save refused because another process changed the file is fatal: `onConflict` decides how to stop (default: throw).
async function openTable(cfg, { llm = null, write = true, heal = false, deferArrivals = false, channel: known = null, onConflict = (e) => { throw e; } } = {}) {
  const api = known?.api ?? (await signIn(cfg));
  const channel = known?.channel ?? (await resolveChannel(api, cfg, { create: false })).channel;
  const state = loadState(cfg.stateDir, channel.id) ?? { channelId: channel.id, serverId: channel.server_id };
  let version = Number(state.version) || 0;
  const persist = write
    ? (t) => {
      const next = { ...state, channelId: channel.id, serverId: channel.server_id, ...t.roster.toJSON(), timelines: t.timelines.toJSON(), guard: t.guard.toJSON(), scenario: t.scenario, journal: t.journal, owedArrivals: t.owedArrivals };
      delete next.version;
      try { version = saveState(cfg.stateDir, next, { expectVersion: version }); }
      catch (e) { if (!(e instanceof StateConflict)) throw e; onConflict(e); }
    }
    : () => {};
  const table = new Table({
    api, llm, cfg, channelId: channel.id, roster: new Roster(state), timelines: new Timelines(state.timelines ?? []), guard: new Guard(state.guard ?? {}),
    scenario: state.scenario ?? null, journal: state.journal ?? null, owedArrivals: state.owedArrivals ?? [], deferArrivals, log, persist,
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
  try { opened = await openTable(cfg, { llm: withProgress(createLlm(cfg.llm), log), heal: true, channel: { api: signedIn, channel: ch }, onConflict }); }
  catch (e) { release(); throw e; }
  const { api, channel, table } = opened;
  const roster = table.roster;
  const rt = new Realtime({ apiBase: cfg.apiBase, token: api.token, channelId: channel.id, log });
  rt.on("event", (ev) => table.onEvent(ev));
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
  log(`keeping "${channel.name}" in ${table.language}; co-players: ${roster.coplayers.map((c) => c.name).join(", ") || "(none)"}; NPCs: ${roster.npcs.length}; LLM: ${cfg.llm.provider}; autonomy: ${cfg.autonomy ? `on (side every ${cfg.autonomySideIntervalMs / 1000}s, quiet after ${cfg.autonomyQuietMs / 1000}s, idle after ${cfg.autonomyIdleMinutes} min)` : "off"}; timelines: ${cfg.timelineAuto ? "proactive" : "model-led"}; scenarios: ${cfg.scenarioAuto ? `GM-driven (≥ ${cfg.scenarioMinMinutes} min, ≥ ${cfg.scenarioMinLines} lines)` : "manual"}`);
  if (cfg.kickoff) {
    const main = table.mainWindow();
    if (main) table.schedule(main.id, { kickoff: true, delay: 0 });
  }
  const stop = () => { table.stopTicker(); fs.unwatchFile(inbox); rt.stop(); release(); process.exit(0); };
  process.on("SIGINT", stop);
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
  console.log(`channel ${channel.name} (${channel.id}), GM: ${channel.my_role === "gm" ? "yes" : "NO"}; ${holder ? `kept by run (pid ${holder})` : "no run process"}`);
  if (table.splitWarning) console.log(`warning: ${table.splitWarning}`);
  console.log("GM and real NPCs share the Keeper's context: all chat, the Keeper board, reminders, script knowledge, documents, highlights.");
  console.log(`real NPCs: ${roster.npcs.map((n) => n.name).join(", ") || "(none)"}`);
  console.log("co-players see only the chat lines their character witnessed, during their seats:");
  for (const c of roster.coplayers) console.log(`  ${c.name} — now in ${openWindows(c).map(wname).join(", ") || "(nowhere)"}; ${c.seats.length} seat(s) so far`);
  console.log("timelines:");
  for (const t of timelines.list) console.log(`  T${t.handle} ${t.name} [${t.status}${t.mergedInto ? ` → ${timelines.get(t.mergedInto)?.name}` : ""}${t.status === "active" && t.id !== "main" ? `, ${t.span}${t.opened ? "" : ", not opened yet"}` : ""}]${t.windowId ? ` in "${wname(t.windowId)}"` : ""}: ${t.members.map(cname).join(", ") || "(no one)"}${t.narrativeTime ? `; ${t.narrativeTime}` : ""}${t.location ? ` @ ${t.location}` : ""}`);
  if (table.owedArrivals.length) console.log(`opening turns waiting for run: ${table.owedArrivals.map((a) => wname(a.windowId)).join(", ")}`);
  console.log(`autonomy: ${cfg.autonomy ? `on — side timelines every ${cfg.autonomySideIntervalMs / 1000}s; a shared window moves after ${cfg.autonomyQuietMs / 1000}s of silence, up to ${cfg.autonomyQuietTurns} times; pauses after ${cfg.autonomyIdleMinutes} min without a human line; at most ${cfg.autonomyMaxTurnsPerHour} autonomous turns an hour` : "off"}`);
  console.log(`timelines: ${cfg.timelineAuto ? `proactive (at most ${cfg.timelineMaxActive} at once, ${cfg.timelineMaxArrivalsPerHour} arrivals an hour)` : "model-led (TIMELINE_AUTO=false)"}; scenarios: ${cfg.scenarioAuto ? `GM-driven from the Main Chat after ${cfg.scenarioMinMinutes} min and ${cfg.scenarioMinLines} lines; never during a short split` : "manual only"}`);
}

const args = parseArgs(process.argv.slice(2));
loadEnvFile(args.env ?? path.join(process.cwd(), ".env"));
loadEnvFile(path.join(here, "..", ".env"));
const cfg = buildConfig(args);
const command = args._[0] ?? "run";
const commands = { setup, run, status, split, rejoin, advance };
if (!commands[command]) {
  console.error(`usage: acerciae-gm <setup|run|status|split|rejoin|advance> [--coplayers N] [--channel ID] [--kickoff] …  (see README.md)`);
  process.exit(2);
}
commands[command](cfg, args).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
