#!/usr/bin/env node
// acerciae-gm: an AI Game Master for an Acerciae channel.
//   setup   sign in, create or attach to a channel the account is GM of, and create the co-players (role cards by the LLM)
//   run     play: the GM and real NPCs answer the table, then the co-players act; side timelines and quiet windows
//           move on their own clock
//   split   send co-players off on a timeline of their own (a window only they sit in); rejoin brings them back
//   status  show the channel, the cast, the timelines and how each role is fed
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
import { loadState, saveState, statePath } from "./state.mjs";
import { Table, languageName } from "./loop.mjs";
import { Timelines } from "./timelines.mjs";

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
  const roster = new Roster(state).reconcile(await api.characters(channel.id), seats);

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
    saveState(cfg.stateDir, { ...state, ...roster.toJSON() });
    log(`co-player ${roster.coplayers.length}/${cfg.coplayers}: ${saved.name} (${saved.card.basic.occupation || "investigator"})`);
  }
  const file = saveState(cfg.stateDir, { ...state, ...roster.toJSON() });
  let invite = null;
  try { invite = await api.createInvite(channel.server_id); } catch { /* not a maintainer, or the server is closed */ }
  console.log(`\nchannel: ${channel.name}\n  CHANNEL_ID=${channel.id}\n  server: ${channel.server_id}${invite ? `\n  invite code for players: ${invite.code}` : ""}\n  state: ${file}\n  co-players: ${roster.coplayers.map((c) => c.name).join(", ") || "(none)"}\n  LLM: ${cfg.llm.provider}${cfg.llm.model ? ` ${cfg.llm.model}` : ""}${cfg.llm.provider === "mock" ? " (placeholder text, for testing only)" : ""}\n\nInvite players to the channel in the web app, then: CHANNEL_ID=${channel.id} npm start`);
}

// The table for a channel: the roster and timelines from the state file, saved back whenever they change.
async function openTable(cfg, { llm = null } = {}) {
  const api = await signIn(cfg);
  const { channel } = await resolveChannel(api, cfg, { create: false });
  const state = loadState(cfg.stateDir, channel.id) ?? { channelId: channel.id, serverId: channel.server_id };
  let written = "";
  const persist = (t) => { const next = { ...state, ...t.roster.toJSON(), timelines: t.timelines.toJSON() }; written = JSON.stringify(next, null, 2); saveState(cfg.stateDir, next); };
  const table = await new Table({ api, llm, cfg, channelId: channel.id, roster: new Roster(state), timelines: new Timelines(state.timelines ?? []), log, persist }).init();
  persist(table);
  return { api, channel, table, state, persist, lastWritten: () => written };
}

async function run(cfg) {
  const { api, channel, table, lastWritten } = await openTable(cfg, { llm: withProgress(createLlm(cfg.llm), log) });
  const roster = table.roster;
  const rt = new Realtime({ apiBase: cfg.apiBase, token: api.token, channelId: channel.id, log });
  rt.on("event", (ev) => table.onEvent(ev));
  rt.on("reconnected", () => table.refresh().catch(() => {}));
  rt.start();
  table.startTicker();
  // A `split`, `rejoin` or `setup` run beside this process changes the state file: pick it up.
  const file = statePath(cfg.stateDir, channel.id);
  fs.watchFile(file, { interval: 2000 }, () => {
    let text; try { text = fs.readFileSync(file, "utf8"); } catch { return; }
    if (text === lastWritten()) return;
    try { table.reload(JSON.parse(text)).then(() => log("state file changed: roster and timelines reloaded")); } catch (e) { log(`state file unreadable: ${e.message}`); }
  });
  log(`keeping "${channel.name}" in ${table.language}; co-players: ${roster.coplayers.map((c) => c.name).join(", ") || "(none)"}; NPCs: ${roster.npcs.length}; LLM: ${cfg.llm.provider}; autonomy: ${cfg.autonomy ? `on (side every ${cfg.autonomySideIntervalMs / 1000}s, quiet after ${cfg.autonomyQuietMs / 1000}s, idle after ${cfg.autonomyIdleMinutes} min)` : "off"}`);
  if (cfg.kickoff) {
    const main = table.mainWindow();
    if (main) table.schedule(main.id, { kickoff: true, delay: 0 });
  }
  const stop = () => { table.stopTicker(); fs.unwatchFile(file); rt.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// `split --name "The docks" --coplayers "Harriet Vance,Tomas Leclerc" [--location …] [--time …] [--opening …]`
async function split(cfg, args) {
  const { table } = await openTable(cfg);
  const names = String(args.coplayers ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!args.name || !names.length) throw new Error("split needs --name <thread> and --coplayers <names, comma-separated>");
  const from = (args.from && table.windows.find((w) => w.name.toLowerCase() === String(args.from).toLowerCase() || w.id === args.from)) ?? table.mainWindow();
  const n = await table.split(from.id, { name: args.name, coplayers: names, location: args.location ?? "", narrative_time: args.time ?? "", opening: args.opening ?? "" });
  const t = table.timelines.byName(args.name);
  if (!t) throw new Error("no co-player matched; nothing was split");
  console.log(`timeline "${t.name}" opened in window "${table.windows.find((w) => w.id === t.windowId)?.name}" with ${t.members.length} co-player(s)${n ? "; opening posted" : ""}. A running \`run\` picks this up within seconds.`);
}

// `rejoin --timeline "The docks" [--into "Main Chat"] [--text …]`
async function rejoin(cfg, args) {
  const { table } = await openTable(cfg);
  if (!args.timeline) throw new Error("rejoin needs --timeline <thread name>");
  const t = table.timelines.byName(args.timeline);
  if (!t || t.status !== "active") throw new Error(`no active timeline named "${args.timeline}"`);
  await table.rejoin({ timeline: args.timeline, into: args.into, text: args.text });
  console.log(`timeline "${t.name}" merged into ${table.timelines.get(t.mergedInto)?.name ?? "the main story"}; its co-players are back.`);
}

async function status(cfg) {
  const { channel, table } = await openTable(cfg);
  const { roster, timelines, windows } = table;
  const wname = (id) => windows.find((w) => w.id === id)?.name ?? id;
  const cname = (id) => table.characters.find((c) => c.id === id)?.name ?? id;
  console.log(`channel ${channel.name} (${channel.id}), GM: ${channel.my_role === "gm" ? "yes" : "NO"}`);
  console.log("GM and real NPCs share the Keeper's context: all chat, the Keeper board, reminders, script knowledge, documents, highlights.");
  console.log(`real NPCs: ${roster.npcs.map((n) => n.name).join(", ") || "(none)"}`);
  console.log("co-players see only the chat lines their character witnessed, during their seats:");
  for (const c of roster.coplayers) console.log(`  ${c.name} — now in ${openWindows(c).map(wname).join(", ") || "(nowhere)"}; ${c.seats.length} seat(s) so far`);
  console.log("timelines:");
  for (const t of timelines.list) console.log(`  ${t.name} [${t.status}${t.mergedInto ? ` → ${timelines.get(t.mergedInto)?.name}` : ""}]${t.windowId ? ` in "${wname(t.windowId)}"` : ""}: ${t.members.map(cname).join(", ") || "(no one)"}${t.narrativeTime ? `; ${t.narrativeTime}` : ""}${t.location ? ` @ ${t.location}` : ""}`);
  console.log(`autonomy: ${cfg.autonomy ? `on — side timelines every ${cfg.autonomySideIntervalMs / 1000}s; a shared window moves after ${cfg.autonomyQuietMs / 1000}s of silence, up to ${cfg.autonomyQuietTurns} times; pauses after ${cfg.autonomyIdleMinutes} min without a human line; at most ${cfg.autonomyMaxTurnsPerHour} autonomous turns an hour` : "off"}`);
}

const args = parseArgs(process.argv.slice(2));
loadEnvFile(args.env ?? path.join(process.cwd(), ".env"));
loadEnvFile(path.join(here, "..", ".env"));
const cfg = buildConfig(args);
const command = args._[0] ?? "run";
const commands = { setup, run, status, split, rejoin };
if (!commands[command]) {
  console.error(`usage: acerciae-gm <setup|run|status|split|rejoin> [--coplayers N] [--channel ID] [--kickoff] …  (see README.md)`);
  process.exit(2);
}
commands[command](cfg, args).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
