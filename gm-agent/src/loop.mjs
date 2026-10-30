// The table loop. A line from a real person starts a turn (after a short quiet period): first the GM and the real
// NPCs act with the Keeper's context, then the co-players seated in that window act, each with only its own chat log,
// and the GM answers their moves at once in a follow-up round. Lines this client posts never start a turn by
// themselves, so it cannot talk to itself without bound.
//
// The table does not always wait for a human. On its own clock (tick) it also runs:
//   side   – a co-players-only window bound to a side timeline: its thread moves on, turn after turn;
//   quiet  – a window with human players that has been silent for a while: the scene moves on a little without
//            deciding anything for a player character, at most AUTONOMY_QUIET_TURNS times until a human posts again.
// Autonomy pauses when no human has posted in the channel for AUTONOMY_IDLE_MINUTES, and is capped per hour.
import { GmContext } from "./context/gmContext.mjs";
import { coplayerLog } from "./context/coplayerContext.mjs";
import { investigatorsFor } from "./context/profiles.mjs";
import { directTurn } from "./director.mjs";
import { coplayerTurn } from "./coplayer.mjs";
import { generateNpc, saveCharacter } from "./roles/cardgen.mjs";
import { openWindows } from "./roles/roster.mjs";
import { Timelines, MAIN } from "./timelines.mjs";

const LANGUAGES = { en: "English", zh: "Simplified Chinese", "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French", de: "German", ru: "Russian", pt: "Portuguese", it: "Italian" };
export const languageName = (code) => LANGUAGES[code] ?? LANGUAGES[String(code ?? "").split("-")[0]] ?? (code || "English");

const ROLL = /^\.(ra|rc|r|sc)(\s|$)/i;
const TRIGGER_KINDS = new Set(["ic", "ooc", "roll", "narration"]);
const norm = (s) => String(s ?? "").trim().toLowerCase();
const names = (v) => (Array.isArray(v) ? v : [v]).map((x) => String(x ?? "").trim()).filter(Boolean);

export class Table {
  constructor({ api, llm, cfg, channelId, roster, timelines, persist = () => {}, log = () => {}, sleep, now = Date.now }) {
    this.api = api;
    this.llm = llm;
    this.cfg = cfg;
    this.channelId = channelId;
    this.roster = roster;
    this.now = now;
    this.timelines = timelines ?? new Timelines([], { now });
    this.persist = persist;
    this.log = log;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.gm = new GmContext(api, channelId, { contextLines: cfg.contextLines, log });
    this.botMessageIds = new Set();
    this.timers = new Map();
    this.queue = Promise.resolve();
    this.pending = 0;          // turns waiting or running
    this.cards = new Map();
    this.turns = 0;
    this.lastSeq = 0;          // newest line seen in the channel
    // Autonomy bookkeeping: when humans last spoke (channel and per window), when each window last got a turn.
    this.lastHumanAt = 0;
    this.windowState = new Map();   // windowId → {lastLineAt, lastHumanAt, lastTurnAt, quietTurns}
    this.autonomousTurns = [];      // timestamps of the last hour's autonomous turns
    this.ticker = null;
  }

  async init() {
    this.me = this.api.user ?? (await this.api.me());
    this.channel = await this.api.channel(this.channelId);
    if (this.channel.my_role !== "gm") throw new Error(`the client's account is not the GM of channel ${this.channelId}`);
    const settings = await this.api.serverSettings(this.channel.server_id).catch(() => null);
    this.language = languageName(this.cfg.language || settings?.language || "en");
    this.rules = await this.api.coc7Rules().catch(() => null);
    await this.refresh();
    await this.observeHistory();
    return this;
  }

  async refresh() {
    [this.characters, this.windows] = await Promise.all([this.api.characters(this.channelId), this.api.windows(this.channelId)]);
    const main = this.mainWindow();
    this.roster.reconcile(this.characters, main ? [main.id] : []);
    this.timelines.reconcile(investigatorsFor(this.characters, this.roster).map((c) => c.id));
  }

  mainWindow() { return this.windows.find((w) => w.kind === "main") ?? this.windows[0]; }
  state(windowId) {
    if (!this.windowState.has(windowId)) this.windowState.set(windowId, { lastLineAt: 0, lastHumanAt: 0, lastTurnAt: 0, quietTurns: 0 });
    return this.windowState.get(windowId);
  }
  isHuman(m) { return m.author_id !== this.me?.id && !this.botMessageIds.has(m.id); }

  // On start: when humans last spoke, from the newest lines of every window (so a restart does not wake a dead table).
  async observeHistory() {
    for (const w of this.windows) {
      const rows = (await this.api.messages(this.channelId, w.id, 20).catch(() => [])) ?? [];
      for (const m of rows) this.noteLine(m);
    }
  }

  noteLine(m) {
    const at = Date.parse(m.created_at) || this.now();
    const st = this.state(m.chat_window_id);
    st.lastLineAt = Math.max(st.lastLineAt, at);
    this.lastSeq = Math.max(this.lastSeq, m.seq ?? 0);
    if (this.isHuman(m)) {
      st.lastHumanAt = Math.max(st.lastHumanAt, at);
      st.quietTurns = 0;
      this.lastHumanAt = Math.max(this.lastHumanAt, at);
    }
  }

  // A running `run` process reloads its roster and timelines when the state file is changed by a CLI command.
  reload(state) {
    this.roster.coplayers = new this.roster.constructor(state).coplayers;
    this.roster.npcs = state.npcs ?? this.roster.npcs;
    this.timelines = new Timelines(state.timelines ?? [], { now: this.now });
    return this.refresh();
  }

  save() { this.persist(this); }

  // ---- events
  onEvent(ev) {
    if (ev.channel_id && ev.channel_id !== this.channelId) return undefined;
    if (ev.stream === "context") { this.gm.onContextEvent(ev); return undefined; }
    if (ev.type === "character.updated" && ev.character) this.cards.delete(ev.character.id);
    if (ev.type === "window.changed") this.refresh().catch((e) => this.log(`refresh: ${e.message}`));
    if (ev.type === "message.posted") return this.onMessage(ev.message);
    return undefined;
  }

  isTrigger(m) {
    if (!m || m.channel_id !== this.channelId) return false;
    if (!this.isHuman(m)) return false;
    return m.visibility === "window" && TRIGGER_KINDS.has(m.kind);
  }

  // Returns the scheduled turn (settled when it ran), or undefined when the line starts no turn.
  onMessage(m) {
    if (m && m.channel_id === this.channelId) this.noteLine(m);
    if (!this.isTrigger(m)) return undefined;
    return this.schedule(m.chat_window_id);
  }

  // Waits for a quiet moment in the window, then queues one turn (turns run one at a time). A line arriving before the
  // turn starts restarts the wait; every caller's promise settles when that one turn has run.
  schedule(windowId, { kickoff = false, mode = "human", delay = this.cfg.debounceMs, ...extra } = {}) {
    const pending = this.timers.get(windowId) ?? { resolvers: [], kickoff: false, mode, extra };
    clearTimeout(pending.timer);
    pending.kickoff ||= kickoff;
    if (mode === "human") { pending.mode = "human"; pending.extra = {}; }   // a human line outranks an autonomous turn
    if (!this.timers.has(windowId)) this.pending++;
    this.timers.set(windowId, pending);
    return new Promise((resolve) => {
      pending.resolvers.push(resolve);
      pending.timer = setTimeout(() => {
        this.timers.delete(windowId);
        const done = () => { this.pending--; for (const r of pending.resolvers) r(); };
        this.queue = this.queue.then(() => this.turn(windowId, { kickoff: pending.kickoff, mode: pending.mode, ...pending.extra })).catch((e) => this.log(`turn failed: ${e.message}`)).then(done);
      }, delay);
    });
  }

  // ---- one turn
  async turn(windowId, { kickoff = false, mode = "human", ...extra } = {}) {
    this.turns++;
    await this.refresh();
    const st = this.state(windowId);
    st.lastTurnAt = this.now();
    if (mode === "quiet") st.quietTurns++;
    if (mode !== "human" && !kickoff) this.autonomousTurns.push(this.now());
    let budget = this.cfg.maxActionsPerTurn;
    const timeline = this.timelines.ofWindow(windowId);
    const round = async (roundMode, roundExtra) => {
      const ctx = await this.gm.build({ windowId, roster: this.roster, characters: this.characters, windows: this.windows, timelines: this.timelines });
      const plan = await directTurn(this.llm, { language: this.language, contextText: ctx.text, newest: ctx.newest, mode: roundMode, kickoff: roundMode === "kickoff", timeline, ...roundExtra });
      this.log(`turn ${this.turns} (${roundMode}): ${plan.actions.length} Keeper action(s), co-players ${plan.coplayersMayAct ? "may act" : "wait"}`);
      for (const action of plan.actions) {
        if (budget <= 0) break;
        budget -= await this.act(windowId, action, ctx, { mode: roundMode });
      }
      return plan;
    };
    const plan = await round(kickoff ? "kickoff" : mode, extra);
    if (!plan.coplayersMayAct && mode !== "side") return;
    const seated = this.roster.coplayersIn(windowId);
    const first = seated.filter((c) => plan.spotlight.some((n) => norm(n) === norm(c.name)));
    let acted = 0;
    for (const c of [...first, ...seated.filter((x) => !first.includes(x))]) {
      if (budget <= 0) break;
      const n = await this.coplayerAct(windowId, c, first.includes(c), { side: mode === "side" });
      acted += n; budget -= n;
    }
    // Co-players are players too: their choices get the Keeper's answer now, not at the next human line.
    if (acted > 0 && budget > 0) await round("followup", {});
  }

  // The Keeper's moves. Returns how many lines were posted.
  async act(windowId, a, ctx, { mode } = {}) {
    switch (a.type) {
      case "narrate": return this.post(windowId, { content: a.text, kind: "narration" });
      case "note": return this.post(windowId, { content: a.text, kind: "narration", visibility: "gm_only" });
      case "npc":
      case "new_npc": {
        const who = this.characterByName(a.name);
        if (this.roster.coplayerByName(a.name) || who?.kind === "pc") { this.log(`the Keeper tried to voice ${a.name}, a ${who?.kind === "pc" ? "player character" : "co-player"}; skipped`); return 0; }
        const npc = this.roster.npcByName(a.name) ?? (await this.createNpc(a.name, a.brief, ctx.text));
        if (!npc || !a.text) return 0;
        return this.post(windowId, { content: a.text, kind: "ic", character_id: npc.characterId });
      }
      case "whisper": {
        const target = this.characterByName(a.to);
        if (!target) return this.post(windowId, { content: `(whisper for ${a.to}) ${a.text}`, kind: "narration", visibility: "gm_only" });
        return this.post(windowId, { content: a.text, kind: "narration", visibility: "whisper", whisper_to: [target.id] });
      }
      case "request_roll": return this.requestRoll(windowId, a, mode);
      case "split": return this.split(windowId, a);
      case "rejoin": return this.rejoin(a);
      case "timeline": return this.updateTimeline(a);
      default: return 0;
    }
  }

  async requestRoll(windowId, a, mode) {
    const command = String(a.command ?? "").trim();
    const target = this.characterByName(a.who);
    if (!ROLL.test(command) || !target) return a.text ? this.post(windowId, { content: a.text, kind: "narration" }) : 0;
    let n = 0;
    if (this.roster.isCoplayer(target.id) || this.roster.isNpc(target.id)) {
      // The client rolls for the characters it plays; the platform rolls against their own sheets.
      if (a.text) n += await this.post(windowId, { content: a.text, kind: "narration" });
      n += await this.post(windowId, { content: command, kind: "ic", character_id: target.id });
      return n;
    }
    // A player's roll is asked for, never made: the request is narration, which is all a quiet turn may do too.
    return this.post(windowId, { content: `${a.text ? `${a.text}\n` : ""}→ ${target.name}: ${command}`, kind: "narration" });
  }

  // ---- timelines
  coplayersNamed(list) { return names(list).map((n) => this.roster.coplayerByName(n)).filter(Boolean); }

  // Co-players leave for a thread of their own: a window only this account (and they) sit in, bound to a new timeline.
  async split(fromWindowId, a) {
    const members = this.coplayersNamed(a.coplayers);
    if (!members.length) { this.log(`split "${a.name}": no co-player named; skipped`); return 0; }
    const name = String(a.name || "Side thread").trim().slice(0, 60);
    let window;
    try { window = await this.api.createWindow(this.channelId, { name: `Side: ${name}`, kind: "group", members: [] }); }
    catch (e) { this.log(`split "${name}": could not create the window: ${e.message}`); return 0; }
    this.roster.moveSeats(members, [window.id], this.lastSeq);
    this.timelines.split({ name, members: members.map((c) => c.characterId), windowId: window.id, returnTo: [fromWindowId], narrativeTime: a.narrative_time ?? "", location: a.location ?? "" });
    this.save();
    await this.refresh();
    this.log(`split: ${members.map((c) => c.name).join(", ")} → "${name}"`);
    const opening = String(a.opening ?? a.text ?? "").trim();
    return opening ? this.post(window.id, { content: opening, kind: "narration" }) : 0;
  }

  // The thread is done: its co-players return, and the timeline is merged back.
  async rejoin(a) {
    const t = this.timelines.byName(a.timeline);
    if (!t || t.id === MAIN || t.status !== "active") { this.log(`rejoin "${a.timeline}": no such active timeline; skipped`); return 0; }
    const into = a.into ? this.windows.find((w) => norm(w.name) === norm(a.into) || w.id === a.into) : null;
    const targets = into ? [into.id] : (t.returnTo?.length ? t.returnTo : [this.mainWindow()?.id].filter(Boolean));
    const members = this.roster.coplayers.filter((c) => t.members.includes(c.characterId));
    this.roster.moveSeats(members, targets, this.lastSeq, this.lastSeq);   // they hear the line that called them back
    const dest = this.timelines.ofWindow(targets[0]);
    this.timelines.merge(t.id, dest?.status === "active" ? dest.id : MAIN);
    this.save();
    this.log(`rejoin: ${members.map((c) => c.name).join(", ")} ← "${t.name}"`);
    let n = 0;
    if (t.windowId) n += await this.post(t.windowId, { content: `Thread "${t.name}" rejoined the main party.`, kind: "narration", visibility: "gm_only" });
    if (a.text) n += await this.post(targets[0], { content: a.text, kind: "narration" });
    return n;
  }

  // Time, place and notes of a timeline; investigators moved between threads (never into another window).
  updateTimeline(a) {
    const t = this.timelines.byName(a.timeline) ?? this.timelines.main();
    const ids = (list) => names(list).map((n) => this.characterByName(n)).filter((c) => c && (c.kind === "pc" || this.roster.isCoplayer(c.id))).map((c) => c.id);
    const r = this.timelines.update(t.id, { narrativeTime: a.narrative_time, location: a.location, notes: a.notes, add: ids(a.add), remove: ids(a.remove) });
    if (r) this.save();
    return 0;
  }

  // ---- autonomy
  startTicker() {
    if (!this.cfg.autonomy || this.ticker) return;
    this.ticker = setInterval(() => { this.tick().catch((e) => this.log(`autonomy: ${e.message}`)); }, this.cfg.autonomyTickMs);
    if (this.ticker.unref) this.ticker.unref();
  }
  stopTicker() { clearInterval(this.ticker); this.ticker = null; }

  // Picks at most one window that should move on its own, and queues its turn.
  async tick() {
    if (!this.cfg.autonomy || this.pending > 0) return null;
    const now = this.now();
    const idle = this.cfg.autonomyIdleMinutes * 60000;
    if (now - this.lastHumanAt > idle) return null;      // nobody at the table
    this.autonomousTurns = this.autonomousTurns.filter((t) => now - t < 3600000);
    if (this.autonomousTurns.length >= this.cfg.autonomyMaxTurnsPerHour) return null;
    const candidates = [];
    for (const w of this.windows) {
      const st = this.state(w.id);
      const timeline = this.timelines.ofWindow(w.id);
      const humans = (w.members ?? []).some((m) => m.user_id !== this.me?.id);
      const sinceLine = now - Math.max(st.lastLineAt, st.lastTurnAt);
      if (timeline?.status === "active" && !humans && this.roster.coplayersIn(w.id).length) {
        if (sinceLine >= this.cfg.autonomySideIntervalMs) candidates.push({ w, mode: "side", waited: sinceLine, extra: { timeline } });
      } else if (humans && st.lastHumanAt && now - st.lastHumanAt <= idle && st.quietTurns < this.cfg.autonomyQuietTurns) {
        // Only a window where a human spoke recently moves on; a long-abandoned private window stays as it is.
        const quiet = now - Math.max(st.lastHumanAt, st.lastTurnAt);
        if (quiet >= this.cfg.autonomyQuietMs) candidates.push({ w, mode: "quiet", waited: quiet, extra: { quietMinutes: Math.round((now - st.lastHumanAt) / 60000) } });
      }
    }
    if (!candidates.length) return null;
    const pick = candidates.sort((a, b) => b.waited - a.waited)[0];
    this.log(`autonomy: ${pick.mode} turn in "${pick.w.name}"`);
    return this.schedule(pick.w.id, { mode: pick.mode, delay: 0, ...pick.extra });
  }

  async createNpc(name, brief, gmContext) {
    if (!String(name ?? "").trim()) return null;
    const generated = await generateNpc(this.llm, { language: this.language, era: this.channel.era, rules: this.rules, name, brief, gmContext: gmContext.slice(-6000) });
    generated.name = name;
    generated.brief = brief || generated.persona;
    const saved = await saveCharacter(this.api, this.channelId, generated, { kind: "npc", rules: this.rules });
    const entry = { characterId: saved.id, name: saved.name, brief: brief || saved.persona };
    this.roster.npcs.push(entry);
    this.save();
    this.log(`new NPC: ${saved.name}`);
    await this.refresh();
    return entry;
  }

  characterByName(name) {
    const n = norm(name);
    return this.characters.find((c) => norm(c.name) === n) ?? this.characters.find((c) => n && norm(c.name).split(/\s+/)[0] === n.split(/\s+/)[0]);
  }

  async card(characterId) {
    if (!this.cards.has(characterId)) {
      const space = await this.api.characterSpace(this.channelId, characterId).catch(() => null);
      this.cards.set(characterId, space?.character?.role_card ?? null);
    }
    return this.cards.get(characterId);
  }

  // A co-player's move, from its own witnessed chat (every window it sat in, during its seats) and its companions'
  // profiles. Nothing from the Keeper's side.
  async coplayerAct(windowId, coplayer, spotlight, { side = false } = {}) {
    const messages = [];
    for (const w of new Set(coplayer.seats.map((s) => s.windowId))) messages.push(...((await this.api.messages(this.channelId, w, this.cfg.contextLines).catch(() => [])) ?? []));
    const log = coplayerLog(coplayer, messages, this.cfg.contextLines);
    const t = this.timelines.of(coplayer.characterId);
    const timeline = t ? { name: t.name, narrativeTime: t.narrativeTime, location: t.location } : null;
    let move;
    try {
      const companions = investigatorsFor(this.characters, this.roster, { except: coplayer.characterId });
      move = await coplayerTurn(this.llm, { language: this.language, coplayer, card: await this.card(coplayer.characterId), companions, log, spotlight, timeline, side });
    } catch (e) { this.log(`co-player ${coplayer.name}: ${e.message}`); return 0; }
    if (move.action === "speak") return this.post(windowId, { content: move.text, kind: move.kind, character_id: coplayer.characterId });
    if (move.action === "roll") {
      let n = 0;
      if (move.text) n += await this.post(windowId, { content: move.text, kind: "ic", character_id: coplayer.characterId });
      return n + (await this.post(windowId, { content: move.command, kind: "ic", character_id: coplayer.characterId }));
    }
    return 0;
  }

  async post(windowId, body) {
    try {
      const m = await this.api.postMessage(this.channelId, windowId, { visibility: "window", ...body });
      this.botMessageIds.add(m.id);
      if (this.botMessageIds.size > 2000) this.botMessageIds.delete(this.botMessageIds.values().next().value);
      this.noteLine(m);
      if (this.cfg.verbose) this.log(`posted ${body.kind}${body.visibility && body.visibility !== "window" ? `/${body.visibility}` : ""}: ${body.content.slice(0, 100)}`);
      await this.sleep(this.cfg.postDelayMs);
      return 1;
    } catch (e) {
      this.log(`post failed (${e.code || e.status}): ${e.message}`);
      return 0;
    }
  }
}
