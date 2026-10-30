#!/usr/bin/env node
// acerciae-gm: an AI Game Master for an Acerciae channel.
//   setup   sign in, create or attach to a channel the account is GM of, and create the co-players (role cards by the LLM)
//   run     play: the GM and real NPCs answer the table, then the co-players act
//   status  show the channel, the cast and how each role is fed
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Api } from "./api.mjs";
import { buildConfig, loadEnvFile, parseArgs } from "./config.mjs";
import { createLlm, completeJson } from "./llm/index.mjs";
import { Realtime } from "./realtime.mjs";
import { Roster } from "./roles/roster.mjs";
import { generateCoplayer, saveCharacter } from "./roles/cardgen.mjs";
import { loadState, saveState } from "./state.mjs";
import { Table, languageName } from "./loop.mjs";

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
  const llm = createLlm(cfg.llm);
  const settings = await api.serverSettings(channel.server_id).catch(() => null);
  const language = languageName(cfg.language || settings?.language || "en");
  const pointsMode = Boolean(settings?.features?.coc7_points);
  const rules = await api.coc7Rules().catch(() => null);
  const windows = await api.windows(channel.id);
  const seats = seatWindows(cfg, windows);
  const state = loadState(cfg.stateDir, channel.id) ?? { channelId: channel.id, serverId: channel.server_id };
  const roster = new Roster(state).reconcile(await api.characters(channel.id), seats);

  const missing = cfg.coplayers - roster.coplayers.length;
  if (missing < 0) log(`the channel already has ${roster.coplayers.length} co-players (asked for ${cfg.coplayers}); keeping them`);
  for (let i = 0; i < missing; i++) {
    const characters = await api.characters(channel.id);
    const takenNames = characters.map((c) => c.name);
    const partyNotes = characters.map((c) => `- ${c.name}${c.kind === "pc" ? " (player character)" : roster.isCoplayer(c.id) ? " (co-player)" : " (NPC)"}`).join("\n");
    const args = { language, era: channel.era, rules, pointsMode, takenNames, partyNotes, index: roster.coplayers.length, total: cfg.coplayers };
    const generated = await generateCoplayer(llm, args);
    const retry = (violations) => completeJson(llm, {
      system: `Fix this COC7 point-buy role card so the platform accepts it. Reply with only the corrected JSON object of the same shape.`,
      user: `PLATFORM SAYS: ${violations}\nCARD: ${JSON.stringify(generated)}`,
      purpose: "coplayer_card",
    }, (x) => (x?.role_card ? x : { ...generated, role_card: x }));
    const saved = await saveCharacter(api, channel.id, generated, { kind: "coplayer", rules, retry });
    roster.coplayers.push({ characterId: saved.id, name: saved.name, persona: saved.persona, speakingStyle: saved.speakingStyle, windows: [...seats] });
    saveState(cfg.stateDir, { ...state, ...roster.toJSON() });
    log(`co-player ${roster.coplayers.length}/${cfg.coplayers}: ${saved.name} (${saved.card.basic.occupation || "investigator"})`);
  }
  const file = saveState(cfg.stateDir, { ...state, ...roster.toJSON() });
  let invite = null;
  try { invite = await api.createInvite(channel.server_id); } catch { /* not a maintainer, or the server is closed */ }
  console.log(`\nchannel: ${channel.name}\n  CHANNEL_ID=${channel.id}\n  server: ${channel.server_id}${invite ? `\n  invite code for players: ${invite.code}` : ""}\n  state: ${file}\n  co-players: ${roster.coplayers.map((c) => c.name).join(", ") || "(none)"}\n  LLM: ${cfg.llm.provider}${cfg.llm.model ? ` ${cfg.llm.model}` : ""}${cfg.llm.provider === "mock" ? " (placeholder text, for testing only)" : ""}\n\nInvite players to the channel in the web app, then: CHANNEL_ID=${channel.id} npm start`);
}

async function run(cfg) {
  const api = await signIn(cfg);
  const { channel } = await resolveChannel(api, cfg, { create: false });
  const state = loadState(cfg.stateDir, channel.id) ?? { channelId: channel.id, serverId: channel.server_id };
  const roster = new Roster(state);
  const table = await new Table({
    api, llm: createLlm(cfg.llm), cfg, channelId: channel.id, roster, log,
    persist: (r) => saveState(cfg.stateDir, { ...state, ...r.toJSON() }),
  }).init();
  saveState(cfg.stateDir, { ...state, ...roster.toJSON() });
  const rt = new Realtime({ apiBase: cfg.apiBase, token: api.token, channelId: channel.id, log });
  rt.on("event", (ev) => table.onEvent(ev));
  rt.on("reconnected", () => table.refresh().catch(() => {}));
  rt.start();
  log(`keeping "${channel.name}" in ${table.language}; co-players: ${roster.coplayers.map((c) => c.name).join(", ") || "(none)"}; NPCs: ${roster.npcs.length}; LLM: ${cfg.llm.provider}`);
  if (cfg.kickoff) {
    const main = table.windows.find((w) => w.kind === "main") ?? table.windows[0];
    if (main) table.schedule(main.id, { kickoff: true, delay: 0 });
  }
  const stop = () => { rt.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function status(cfg) {
  const api = await signIn(cfg);
  const { channel } = await resolveChannel(api, cfg, { create: false });
  const windows = await api.windows(channel.id);
  const roster = new Roster(loadState(cfg.stateDir, channel.id) ?? {}).reconcile(await api.characters(channel.id), seatWindows(cfg, windows));
  const wname = (id) => windows.find((w) => w.id === id)?.name ?? id;
  console.log(`channel ${channel.name} (${channel.id}), GM: ${channel.my_role === "gm" ? "yes" : "NO"}`);
  console.log("GM and real NPCs share the Keeper's context: all chat, the Keeper board, reminders, script knowledge, documents, highlights.");
  console.log(`real NPCs: ${roster.npcs.map((n) => n.name).join(", ") || "(none)"}`);
  console.log("co-players see only the chat lines their character witnessed:");
  for (const c of roster.coplayers) console.log(`  ${c.name} — seated in ${c.windows.map(wname).join(", ")}`);
}

const args = parseArgs(process.argv.slice(2));
loadEnvFile(args.env ?? path.join(process.cwd(), ".env"));
loadEnvFile(path.join(here, "..", ".env"));
const cfg = buildConfig(args);
const command = args._[0] ?? "run";
const commands = { setup, run, status };
if (!commands[command]) {
  console.error(`usage: acerciae-gm <setup|run|status> [--coplayers N] [--channel ID] [--kickoff] …  (see README.md)`);
  process.exit(2);
}
commands[command](cfg).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
