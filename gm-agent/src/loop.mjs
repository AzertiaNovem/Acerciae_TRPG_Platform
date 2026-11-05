// The table loop. A line from a real person starts a turn (after a short quiet period): first the GM and the real
// NPCs act with the Keeper's context, then the co-players seated in that window act, each with only its own chat log,
// and the GM answers their moves at once in a follow-up round. Lines this client posts never start a turn by
// themselves, so it cannot talk to itself without bound.
//
// Proactive timelines (TIMELINE_AUTO): each Keeper round may report where investigators are (whereabouts.mjs). The
// table then splits them into threads of their own — a window for the place, with the players who went and the GM —
// and reunites them in the Main Chat when they are together again. Every new or changed scene gets an arrival turn
// at once. A player who keeps writing in the old window is answered in their own scene (relay).
//
// The table does not always wait for a human. On its own clock (tick) it also runs:
//   side   – a co-players-only window bound to a side timeline: its thread moves on, turn after turn;
//   quiet  – a window with human players that has been silent for a while: the scene moves on a little without
//            deciding anything for a player character, at most AUTONOMY_QUIET_TURNS times until a human posts again.
// Autonomy pauses when no human has posted in the channel for AUTONOMY_IDLE_MINUTES, and is capped per hour.
//
// The GM may also open the next scenario (campaign-wide), only from the Main Chat, never while a short split is
// active, and not before SCENARIO_MIN_MINUTES and SCENARIO_MIN_LINES.
import { GmContext, duration } from "./context/gmContext.mjs";
import { sceneForks } from "./sceneForks.mjs";
import { randomUUID } from "node:crypto";
import { coplayerLog, renderLine } from "./context/coplayerContext.mjs";
import { Store, billableTokens } from "./store.mjs";
import { History, Memory, estimateTokens, CHUNK_LINES } from "./memory.mjs";
import { Generation } from "./generation.mjs";
import { metered } from "./llm/parts.mjs";
import { usageSink } from "./usage.mjs";
import { recall } from "./context/recall.mjs";
import { investigatorsFor } from "./context/profiles.mjs";
import { directTurn } from "./director.mjs";
import { coplayerSelf, coplayerTurn } from "./coplayer.mjs";
import { prepareActor, playerRules, awaitingReview } from "./pbta.mjs";
import { generateNpc, saveCharacter } from "./roles/cardgen.mjs";
import { isPlayerCharacter, openWindows } from "./roles/roster.mjs";
import { Timelines, MAIN, placeKey } from "./timelines.mjs";
import { correctionNotice, publicLines, readDestinations, sceneHandoff } from "./continuity.mjs";
import { readPresence } from "./presence.mjs";
import { Guard, planWhereabouts, whereaboutsBrief } from "./whereabouts.mjs";
import { addTruth, hashText, improvState, worldMessages } from "./improv.mjs";
import { PHONE_LOG, PHONE_PREFIX, casualState, coplayerPhoneReply, dueAt, pairKey, parseAddress, renderThread } from "./casual.mjs";
import { WISH_WINDOW, addToInbox, mergeTableNotes, plannerReply, renderCorrectionsFor, renderInbox, renderTableNotes } from "./wishes.mjs";
import { leaksSecret, noteSessionLine, planStory, plannerDue, plannerModeOf, plannerState, renderFinalNote, renderImpulse, renderPlanNote, renderStoryPlan, sessionEnded, stallSignature } from "./planner.mjs";
import { MAX_ADVANCE_DAYS, advanceCalendar, calendarPace, calendarState, describeCalendar, describeRoutine, fitEra, noteCalendarLine, renderCalendar, setRoutine } from "./calendar.mjs";
import { applyBond, bondsState, renderBonds, renderBondsFor, resolveBonds } from "./bonds.mjs";
import { impression } from "./context/traits.mjs";
import { rulesProfile, ruleSystemOf } from "./rules/index.mjs";

const LANGUAGES = { en: "English", zh: "Simplified Chinese", "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French", de: "German", ru: "Russian", pt: "Portuguese", it: "Italian" };
export const languageName = (code) => LANGUAGES[code] ?? LANGUAGES[String(code ?? "").split("-")[0]] ?? (code || "English");

const TRIGGER_KINDS = new Set(["ic", "ooc", "roll", "narration"]);
const SPEAKER_KINDS = new Set(["ic", "roll", "narration"]);       // lines that let a player's character move (not OOC)
const MOVE_MODES = new Set(["human", "followup", "side", "relay", "manual"]);
const norm = (s) => String(s ?? "").trim().toLowerCase();
const names = (v) => (Array.isArray(v) ? v : [v]).map((x) => String(x ?? "").trim()).filter(Boolean);
// Splits text at paragraph or line breaks into pieces of at most `max` characters.
function chunk(text, max) {
  const out = [];
  let cur = "";
  for (const line of String(text).split(/(?<=\n)/)) {
    for (const piece of line.length > max ? line.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) : [line]) {
      if (cur.length + piece.length > max) { out.push(cur); cur = ""; }
      cur += piece;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const HOUR = 3600000;

export class Table {
  // `deferArrivals`: a short-lived CLI process records arrivals in the state file for the `run` process to play.
  constructor({ api, llm, cfg, channelId, roster, timelines, guard, store = null, scenario = null, improv = null, casual = null, planner = null, plannerLlm = null, calendar = null, bonds = null, journal = null, owedArrivals = [], deferArrivals = false, persist = () => {}, log = () => {}, sleep, now = Date.now }) {
    this.api = api;
    // The client's own store (store.mjs): the chat's local copy, compacted chapters, token usage. In memory when none
    // is given (tests, read-only commands).
    this.store = store ?? new Store();
    this.planner = plannerState(planner);
    this.generation = new Generation(this.planner.paused);
    this.lastPlayerSeq = this.planner.pauseSeq;
    this.pauseLines = new Set();
    const signalOf = () => this.generation.signal;
    this.llm = metered(llm, { signalOf, sink: usageSink(this.store, log), channelId, now, log, provider: cfg.llm?.provider, model: cfg.llm?.model });
    this.cfg = cfg;
    this.channelId = channelId;
    this.roster = roster;
    this.now = now;
    this.timelines = timelines ?? new Timelines([], { now });
    this.guard = guard ?? new Guard();
    this.scenario = scenario;            // {id, since}: when the client saw the current scenario begin
    this.improv = improvState(improv);   // improvisation mode: world setting, hidden truths (improv.mjs)
    this.casual = casualState(casual);   // casual mode: phones, pending replies (casual.mjs)
    this.calendar = calendarState(calendar); // the story's date (calendar.mjs)
    this.bonds = bondsState(bonds);       // relationships between characters (bonds.mjs)
    // The planner's own model, metered into the same usage so the daily budget counts it; the GM's when none is given.
    this.plannerLlm = plannerLlm ? metered(plannerLlm, { signalOf, sink: usageSink(this.store, log), channelId, now, log, provider: cfg.planner?.provider, model: cfg.planner?.model }) : this.llm;
    this.journal = journal;              // an applyPlan in progress, for roll-forward after a crash
    this.owedArrivals = [...owedArrivals];
    this.deferArrivals = deferArrivals;
    this.persist = persist;
    this.log = log;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.history = new History({ api, store: this.store, channelId, pageSize: cfg.contextLines, backfill: cfg.historyBackfillLines ?? 1000, log });
    this.memory = new Memory({ store: this.store, llm: this.llm, gmBudget: cfg.gmContextTokens ?? 60000, coplayerBudget: cfg.coplayerContextTokens ?? 24000, log });
    this.gm = new GmContext(api, channelId, { history: this.history, memory: this.memory, budget: cfg.gmContextTokens ?? 60000, recallTokens: cfg.recallTokens ?? 1200, log });
    this.botMessageIds = new Set();
    this.timers = new Map();
    this.queue = Promise.resolve();
    this.pending = 0;          // turns waiting or running
    this.cards = new Map();
    this.attrs = new Map();
    this.turns = 0;
    this.lastSeq = 0;          // newest line seen in the channel
    this.windowSeq = new Map();      // windowId → newest line seen there (seat cut points)
    this.speakers = new Map();       // windowId → [{id, seq, content}] player lines since that window's last turn
    // Autonomy bookkeeping: when humans last spoke (channel and per window), when each window last got a turn.
    this.lastHumanAt = 0;
    this.windowState = new Map();   // windowId → {lastLineAt, lastHumanAt, lastTurnAt, quietTurns}
    this.autonomousTurns = [];      // timestamps of the last hour's autonomous turns
    this.lastLineBy = new Map();    // player character id → when its player last wrote
    this.returning = new Map();     // player character id → how long its player had been away (until the next turn)
    this.arrivalTimes = [];         // timestamps of the last hour's arrival turns
    this.ticker = null;
    this.refreshGen = 0;
    this.refreshing = null;
    this.memberCache = null;
  }

  async init({ heal = false } = {}) {
    this.me = this.api.user ?? (await this.api.me());
    this.channel = await this.api.channel(this.channelId);
    if (this.channel.my_role !== "gm") throw new Error(`the client's account is not the GM of channel ${this.channelId}`);
    // Who can read a split scene's window besides its members: everyone in public mode; in isolated mode, the players
    // who share a player group with a member.
    this.publicSplits = this.channel.knowledge_mode !== "isolated";
    const groups = this.publicSplits ? [] : ((await this.api.playerGroups(this.channelId).catch(() => null)) ?? []);
    this.sharedGroups = groups.filter((g) => (g.members ?? []).length > 1).map((g) => g.name || g.id);
    this.splitWarning = this.publicSplits
      ? "this channel's knowledge mode is public, so every player can read every split scene's window"
      : this.sharedGroups.length ? `players who share a player group (${this.sharedGroups.join(", ")}) can read each other's split scene windows` : null;
    const settings = await this.api.serverSettings(this.channel.server_id).catch(() => null);
    this.language = languageName(this.cfg.language || settings?.language || "en");
    this.memory.language = this.language;
    this.profile = rulesProfile(ruleSystemOf(this.channel));
    this.memory.vocab = this.profile.vocab;
    this.gm.profile = this.profile;
    this.rules = this.channel.rule_system === "pbta" ? null : await this.profile.fetchRules(this.api, this.channelId).catch(() => null);
    this.initiative = new Map();
    await this.refresh();
    for (const w of this.windows) if (Number.isFinite(Number(w.last_seq))) this.noteSeq(w.id, Number(w.last_seq));
    await this.observeHistory();
    this.speakers.clear();                 // history never authorises a move
    if (this.channel.current_scene_id && this.scenario?.id !== this.channel.current_scene_id) {
      const scenes = (await this.api.scenes(this.channelId).catch(() => [])) ?? [];
      const cur = scenes.find((s) => s.id === this.channel.current_scene_id);
      this.scenario = { id: this.channel.current_scene_id, since: Date.parse(cur?.created_at) || this.now() };
    }
    if (heal && this.pbta && awaitingReview((await this.api.pbtaDraft(this.channelId)).status)) throw Error("Rule draft awaits GM review");
    if (heal) await this.heal();
    if (heal) await this.publishWorld();
    this.ready = true;
    if (heal) await this.ensureTableWindows();
    return this;
  }

  // On `run`: legacy unbound threads are folded back into the main timeline; an interrupted split is finished; threads
  // whose first scene was never played, and arrivals owed by a CLI command, get their arrival turn.
  async heal() {
    let changed = false;
    for (const t of this.timelines.active()) {
      if (t.id === MAIN || t.windowId) continue;
      this.timelines.merge(t.id, MAIN, this.lastSeq + 1);
      this.log(`timeline "${t.name}" had no window of its own; folded into the main story`);
      changed = true;
    }
    if (this.journal?.phase === "A") {
      this.log("finishing a split that was interrupted");
      const j = this.journal; this.journal = null;
      // One-time recovery of pre-fork agent journals: retain windows already created by that version.
      for (const op of j.ops) if (op.op === "split" && !op.requestId) {
        const users = op.ids.filter(id => this.isPc(id)).map(id => this.userOf(id)).sort();
        const old = j.created?.find(c => c.placeKey === placeKey(op.place) && JSON.stringify([...(c.users ?? [])].sort()) === JSON.stringify(users));
        if (old && this.windows.some(w => w.id === old.windowId)) op.legacyWindowId = old.windowId;
      }
      await this.applyPlan({ ops: j.ops, changed: j.changed ?? [], ignored: [], guard: {}, prevOf: () => null }, { windowId: j.windowId, mode: ["correction", "presence"].includes(j.mode) ? j.mode : "manual", correctionSeq: j.correctionSeq, turn: this.guard.turn, quiet: true, opId: j.opId });
    } else if (this.journal) {
      await this.applyAudience(this.journal.audience ?? []);
      this.journal = null; changed = true;
    }
    // Upgrade an existing split table before another narration can expose the primary scene.
    const partition = this.partitionPlan([]);
    if (partition.length) await this.applyPlan({ ops: partition, changed: [], ignored: [], guard: {} }, { windowId: this.windowOf(this.timelines.main()), mode: "presence", turn: this.guard.turn, quiet: true });
    await this.archiveRetired();
    for (const t of this.timelines.active()) if (t.windowId && !t.opened) this.scheduleArrival(t.windowId, { names: t.members.map((id) => this.nameOf(id)), place: t.location, reunion: false }, { force: true });
    const owed = this.owedArrivals.splice(0);
    for (const a of owed) this.scheduleArrival(a.windowId, a.arrival, { force: true });
    if (changed || owed.length) this.save();
  }

  // Single-flight, generation-checked: a stale list never overwrites a newer one.
  async refresh() {
    const gen = ++this.refreshGen;
    const [characters, windows, channel] = await Promise.all([this.api.characters(this.channelId), this.api.windows(this.channelId), this.api.channel(this.channelId)]);
    if ((channel.rule_system ?? "coc7e") !== (this.channel.rule_system ?? "coc7e")) throw Error("Rule system changed. Restart setup and run.");
    const pbta = channel.rule_system === "pbta" ? await this.api.pbtaRules(this.channelId) : null;
    if (gen < this.appliedGen) return;
    this.appliedGen = gen;
    this.pbta = pbta;
    // A player character first seen after start-up: a new player at the table (see welcomeNewcomers).
    const fresh = this.ready && this.characters ? characters.filter((c) => !this.characters.some((x) => x.id === c.id)) : [];
    this.characters = characters;
    this.windows = windows;
    const main = this.mainWindow();
    this.roster.reconcile(this.characters, main ? [main.id] : [], { castBy: this.me?.id });
    this.timelines.reconcile(investigatorsFor(this.characters, this.roster).map((c) => c.id));
    this.lastRefreshAt = this.now();
    if (!this.ready) return;
    const newcomers = fresh.filter((c) => this.isPc(c.id) && c.user_id);
    // A player who just joined is seated in the planner window and gets a phone (casual mode).
    if (newcomers.length || this.casual.on || this.plannerWindowWanted()) this.ensureTableWindows().catch((e) => this.log(`windows: ${e.message}`));
    if (newcomers.length) this.welcomeNewcomers(newcomers);
  }

  mainWindow() { return this.windows.find((w) => w.kind === "main") ?? this.windows[0]; }
  windowName(id) { return this.windows.find((w) => w.id === id)?.name ?? "another window"; }
  nameOf(id) { return this.characters.find((c) => c.id === id)?.name ?? id; }
  // A player character, played by a real person (a GM-cast PC is a co-player).
  isPc(id) { return isPlayerCharacter(this.characters.find((c) => c.id === id), this.roster); }
  userOf(id) { return this.characters.find((c) => c.id === id)?.user_id ?? null; }
  // After the first split even the primary story has a private window; Main Chat becomes the lobby.
  scene(windowId) {
    if (windowId === this.mainWindow()?.id) return this.timelines.main().windowId ? null : this.timelines.main();
    return this.timelines.activeOfWindow(windowId);
  }
  // Where a timeline is played.
  windowOf(timeline) { return timeline?.windowId ?? (timeline?.id === MAIN ? this.mainWindow()?.id : null); }
  primaryWindowId() { return this.windowOf(this.timelines.main()); }
  sceneHistory(windowId) {
    const seen = new Set(), lines = [];
    let id = windowId, cutoff = Infinity;
    while (id && !seen.has(id)) {
      seen.add(id);
      lines.push(...this.history.lines(id).filter(m => m.seq <= cutoff));
      const win = this.windows.find(w => w.id === id);
      cutoff = Math.min(cutoff, win?.fork_seq ?? 0);
      id = win?.fork_parent_id;
    }
    return lines.sort((a,b) => a.seq-b.seq);
  }
  partitionPlan(ops) { return sceneForks(this.timelines, ops, { windowOf: t => this.windowOf(t) }); }
  async archiveRetired() {
    for (const w of this.windows) if (w.kind !== "main" && !w.archived_at && this.timelines.retired(w.id)) {
      await this.api.updateWindow(this.channelId, w.id, { archived: true });
      w.archived_at = new Date(this.now()).toISOString();
    }
  }
  windowUsers(windowId) { return (this.windows.find((w) => w.id === windowId)?.members ?? []).filter(m => !m.visibility_paused).map((m) => m.user_id).filter((u) => u && u !== this.me?.id); }

  async applyAudience(actions) {
    for (const action of actions) {
      const win = this.windows.find(w => w.id === action.windowId);
      const member = win?.members?.find(m => m.user_id === action.userId);
      if (!member && action.paused) continue;
      if (!member) await this.api.addWindowMember(this.channelId, action.windowId, { user_id: action.userId, character_id: action.characterId });
      else if (!!member.visibility_paused !== action.paused) await this.api.setWindowVisibility(this.channelId, action.windowId, action.userId, action.paused);
    }
    if (actions.length) await this.refresh();
  }

  state(windowId) {
    if (!this.windowState.has(windowId)) this.windowState.set(windowId, { lastLineAt: 0, lastHumanAt: 0, lastTurnAt: 0, quietTurns: 0 });
    return this.windowState.get(windowId);
  }
  isHuman(m) { return m.author_id !== this.me?.id && !this.botMessageIds.has(m.id); }
  noteSeq(windowId, seq) {
    if (!Number.isFinite(seq)) return;
    this.windowSeq.set(windowId, Math.max(this.windowSeq.get(windowId) ?? 0, seq));
    this.lastSeq = Math.max(this.lastSeq, seq);
  }

  // On start: when humans last spoke, from the newest lines of every window (so a restart does not wake a dead table).
  // Brings the local copy of every window up to date (a first backfill, or the gap since the table last ran) and notes
  // the newest lines for pacing.
  async observeHistory({ controlsOnly = false } = {}) {
    const after = controlsOnly ? this.lastPlayerSeq : 0;
    const controls = [];
    for (const w of this.windows) {
      await this.history.sync(w.id).catch((e) => this.log(`history ${w.name}: ${e.message}`));
      const lines = this.history.lines(w.id, { after });
      if (!controlsOnly) for (const m of lines.slice(-20)) this.noteLine(m);
      for (const m of lines) {
        if (this.pauseCommand(m)) this.pauseLines.add(m.id);
        if (m.seq > this.lastPlayerSeq && this.playerSpeech(m)) controls.push(m);
      }
    }
    for (const m of controls.sort((a, b) => a.seq - b.seq)) this.updatePause(m, { historical: true });
  }

  // The story keeps a date only in a casual game; a solemn game has none (calendar.mjs).
  calendarOn() { return Boolean(this.casual.on); }
  // The Keeper's pace on the calendar (config `calendar`; 0: no limit).
  calendarPaceCfg() { return { minMinutes: this.cfg.calendarMinMinutes ?? 0, minLines: this.cfg.calendarMinLines ?? 0, maxDays: this.cfg.calendarMaxDays ?? 0 }; }

  // The Keeper's context for a turn in `windowId` (gmContext.mjs), with the calendar (casual games) and the relationships.
  async buildGm(windowId, extra = {}) {
    const initiative = await this.initiativeOf(windowId);
    return this.gm.build({ windowId, initiative, roster: this.roster, characters: this.characters, windows: this.windows, timelines: this.timelines, sceneOf: (w) => this.scene(w), improv: this.improv, hide: this.hiddenLines(), awayOf: (id) => this.awayOf(id), calendar: this.calendarOn() ? renderCalendar(this.calendar, { pace: this.calendarPaceCfg(), now: this.now() }) : "", bonds: renderBonds(this.bonds, (id) => this.nameOf(id)), table: renderTableNotes(this.planner.table), ...extra });
  }

  // How the Keeper reads a line: visibility and the timeline it comes from (see gmContext.mjs).
  renderForGm(m) { return renderLine({ ...m, whisper_to_names: (m.whisper_to ?? []).map((id) => this.nameOf(id)) }, { markVisibility: true, timeline: this.timelines.ofLine(m).name, gm: this.profile?.vocab.gm }); }
  // How a co-player reads a line (its own view, no visibility marks).
  renderForCoplayer(m) { return renderLine(m, { gm: this.profile?.vocab.gm }); }

  // D&D: a window's Initiative order from the platform, kept until the next initiative.changed event.
  async initiativeOf(windowId) {
    if (this.profile?.id !== "dnd2024" || !windowId) return null;
    if (!this.initiative.has(windowId)) this.initiative.set(windowId, await this.api.initiative(this.channelId, windowId).catch(() => null));
    return this.initiative.get(windowId);
  }

  // How long a player character's player has been away, or null while they are around (AUTONOMY_IDLE_MINUTES).
  awayOf(id) {
    if (!this.isPc(id)) return null;
    const last = this.lastLineBy.get(id);
    const gap = this.now() - (last ?? 0);
    return last !== undefined && gap > this.cfg.autonomyIdleMinutes * 60000 ? gap : null;
  }

  // Waits for background compaction (tests, shutdown).
  async memoryIdle() { await this.memory.idle(); }

  noteLine(m) {
    this.history.add(m);
    const at = Date.parse(m.created_at) || this.now();
    const st = this.state(m.chat_window_id);
    st.lastLineAt = Math.max(st.lastLineAt, at);
    this.noteSeq(m.chat_window_id, m.seq ?? 0);
    if (this.isHuman(m)) {
      st.lastHumanAt = Math.max(st.lastHumanAt, at);
      st.quietTurns = 0;
      st.coplayersActed = new Set();       // every human line gives each co-player one more go
      if (m.character_id) {
        // A player back after being away (AUTONOMY_IDLE_MINUTES) is welcomed back by the next turn.
        const prev = this.lastLineBy.get(m.character_id);
        if (prev !== undefined && at - prev > this.cfg.autonomyIdleMinutes * 60000) this.returning.set(m.character_id, at - prev);
        this.lastLineBy.set(m.character_id, Math.max(prev ?? 0, at));
      }
      this.lastHumanAt = Math.max(this.lastHumanAt, at);
      if (Object.keys(this.casual.chain).length) this.casual.chain = {};   // AI characters may text on again
      if (m.character_id && m.visibility === "window" && SPEAKER_KINDS.has(m.kind) && this.isPc(m.character_id)) {
        if (!this.speakers.has(m.chat_window_id)) this.speakers.set(m.chat_window_id, []);
        this.speakers.get(m.chat_window_id).push({ id: m.character_id, seq: m.seq, content: m.content });
      }
    }
  }

  // A running `run` process reloads its roster and timelines when the state file is changed by a CLI command; it is
  // queued like a turn, so it never lands in the middle of one.
  reload(state) {
    this.queue = this.queue.then(async () => {
      this.roster.coplayers = new this.roster.constructor(state).coplayers;
      this.roster.npcs = state.npcs ?? this.roster.npcs;
      this.timelines = new Timelines(state.timelines ?? [], { now: this.now });
      const guard = new Guard(state.guard ?? {});
      guard.turn = Math.max(guard.turn, this.guard.turn);
      this.guard = guard;
      for (const a of state.owedArrivals ?? []) this.scheduleArrival(a.windowId, a.arrival, { force: true });
      this.owedArrivals = [];
      await this.refresh();
    }).catch((e) => this.log(`reload: ${e.message}`));
    return this.queue;
  }

  save() { try { this.persist(this); } catch (e) { this.log(`state not saved: ${e.message}`); } }

  // ---- events
  onEvent(ev) {
    if (ev.channel_id && ev.channel_id !== this.channelId) return undefined;
    if (ev.stream === "context") { this.gm.onContextEvent(ev); return undefined; }
    if (ev.type === "character.updated" && ev.character) this.cards.delete(ev.character.id);
    if (ev.type === "window.changed") { this.memberCache = null; this.refresh().catch((e) => this.log(`refresh: ${e.message}`)); }
    if (ev.type === "initiative.changed") this.initiative.delete(ev.chat_window_id ?? "*");
    if (ev.type === "scene.changed" && ev.scene?.status === "active" && ev.scene.id !== this.scenario?.id) {
      // A plan made before the platform opened its first scenario is not stale because of it: no replan for that.
      if (this.planner.arc && this.planner.scenarioId === null && !this.scenario) this.planner.scenarioId = ev.scene.id;
      this.scenario = { id: ev.scene.id, since: this.now() };
      this.beatClosed();
      this.save();
    }
    if (ev.type === "message.posted") return this.onMessage(ev.message);
    return undefined;
  }

  isTrigger(m) {
    if (!m || m.channel_id !== this.channelId) return false;
    if (!this.isHuman(m)) return false;
    return m.visibility === "window" && TRIGGER_KINDS.has(m.kind);
  }

  playerSpeech(m) {
    return m?.channel_id === this.channelId && m.author_id && this.isHuman(m) && m.author_role === "player" &&
      ["ic", "ooc", "narration"].includes(m.kind) && Boolean(String(m.content ?? "").trim());
  }

  pauseCommand(m) {
    return this.playerSpeech(m) && this.isPlannerWindow(m.chat_window_id) &&
      m.visibility === "window" && String(m.content).trim() === "/pause";
  }

  updatePause(m, { historical = false } = {}) {
    const command = this.pauseCommand(m);
    if (command) this.pauseLines.add(m.id);
    if (!this.playerSpeech(m) || m.seq <= this.lastPlayerSeq) return;
    this.lastPlayerSeq = m.seq;
    if (!command && !this.generation.paused) return;
    const changed = command !== this.generation.paused;
    if (command) {
      this.generation.pause();
      this.speakers.clear();
      for (const pending of this.timers.values()) {
        clearTimeout(pending.timer);
        this.pending--;
        for (const resolve of pending.resolvers) resolve();
      }
      this.timers.clear();
    } else {
      this.speakers.clear();
      this.generation.resume();
    }
    this.planner.paused = command;
    this.planner.pauseSeq = m.seq;
    this.save();
    if (changed && command && !historical) {
      const content = this.language === "Simplified Chinese" ? "主持已暂停。频道内下一条玩家发言会恢复主持，已预约的手机消息仍会按时送达。"
        : this.language === "Traditional Chinese" ? "主持已暫停。頻道內下一則玩家發言會恢復主持，已預約的手機訊息仍會準時送達。"
        : "Hosting paused. The next player message in this channel resumes play. Scheduled phone messages will still arrive.";
      return this.post(m.chat_window_id, { kind: "ooc", content }, { count: false, allowPaused: true });
    }
  }

  // Returns the scheduled turn (settled when it ran), or undefined when the line starts no turn.
  onMessage(m) {
    if (!m || m.channel_id !== this.channelId) return;
    if (this.pauseCommand(m)) {
      this.history.add(m);
      return this.updatePause(m);
    }
    // Ignore re-delivery of pre-pause events. A newer real utterance resumes first
    // and then goes through its usual chat, planner or phone handler.
    if (this.isHuman(m) && m.seq <= this.planner.pauseSeq) return;
    this.updatePause(m);
    this.noteLine(m);
    if (this.generation.paused) return;
    if (this.isHuman(m) && !this.isPlannerWindow(m.chat_window_id)) this.noteSession(m);
    // A player's line of play counts toward the calendar's pace (chatter out of character does not).
    if (this.playerSpeech(m) && m.kind !== "ooc" && !this.isPlannerWindow(m.chat_window_id)) noteCalendarLine(this.calendar);
    // A correction in chat or the planner window takes effect before the next GM/companion turn.
    let placement;
    if (this.isTrigger(m) && (this.isPlannerWindow(m.chat_window_id) || ((this.scene(m.chat_window_id) || m.chat_window_id === this.mainWindow()?.id) &&
        (m.kind === "ooc" || this.timelines.active().length > 1)))) {
      placement = this.queue = this.queue.then(this.generation.task(() => this.correctPlacement(m))).catch(e => this.log("placement correction: " + e.message));
    }
    if (m && this.isPlannerWindow(m.chat_window_id)) {
      this.onWishLine(m);
      return placement;
    }
    if (m && m.chat_window_id && m.chat_window_id === this.casual.log) return undefined;   // the Keeper's own phone log
    if (m && this.isPhone(m.chat_window_id)) return this.onPhoneLine(m);   // a phone never starts a scene turn
    if (!this.isTrigger(m)) return undefined;
    return this.schedule(m.chat_window_id);
  }

  // Waits for a quiet moment in the window, then queues one turn (turns run one at a time). A line arriving before the
  // turn starts restarts the wait; every caller's promise settles when that one turn has run. A human line outranks
  // an autonomous turn; an arrival rides along with whatever turn is pending and never shortens a human's wait.
  schedule(windowId, { kickoff = false, mode = "human", delay = this.cfg.debounceMs, ...extra } = {}) {
    const signal = this.generation.signal;
    if (signal.aborted) return;
    const existing = this.timers.get(windowId);
    const pending = existing ?? { resolvers: [], kickoff: false, mode, extra: {} };
    if (existing && mode === "arrival" && existing.mode === "human") {
      pending.extra.arrival = extra.arrival;
      return new Promise((resolve) => pending.resolvers.push(resolve));
    }
    clearTimeout(pending.timer);
    pending.kickoff ||= kickoff;
    if (mode === "human") { pending.mode = "human"; pending.extra = existing?.extra?.arrival ? { arrival: existing.extra.arrival } : {}; }
    else if (!existing || mode === "arrival" || mode === "relay" || mode === "phone") { pending.mode = mode; pending.extra = { ...(existing?.extra ?? {}), ...extra }; }
    if (!existing) this.pending++;
    this.timers.set(windowId, pending);
    return new Promise((resolve) => {
      pending.resolvers.push(resolve);
      pending.timer = setTimeout(() => {
        this.timers.delete(windowId);
        const done = () => { this.pending--; for (const r of pending.resolvers) r(); if (!signal.aborted) this.maybePlan(); };
        this.queue = this.queue.then(this.generation.task(() => this.turn(windowId, { kickoff: pending.kickoff, mode: pending.mode, ...pending.extra }))).catch((e) => this.log(`turn failed: ${e.message}`)).then(done);
      }, delay);
    });
  }

  // ---- one turn
  async turn(windowId, { kickoff = false, mode = "human", ...extra } = {}) {
    if (this.generation.signal.aborted) return;
    if (this.journal) await this.heal();
    await this.adoptPlan();
    if (mode === "phone") { this.turns++; await this.refresh(); return this.phoneTurn(windowId, extra.phone ?? {}); }
    this.turns++;
    const turnNo = this.guard.beginTurn();
    await this.refresh();
    this.generation.signal.throwIfAborted();
    const partition = this.partitionPlan([]);
    if (partition.length) await this.applyPlan({ ops: partition, changed: [], ignored: [], guard: {} }, { windowId, mode: "presence", turn: turnNo, quiet: true });
    if (this.windows.find(w => w.id === windowId)?.archived_at) return;
    if (this.timelines.retired(windowId) && mode !== "human") return;   // that scene is over
    const st = this.state(windowId);
    st.lastTurnAt = this.now();
    if (mode === "quiet") st.quietTurns++;
    if (mode === "quiet" || mode === "side" || (mode === "arrival" && extra.autonomous)) this.autonomousTurns.push(this.now());
    // Players' lines are taken only by the turns that can act on them; an arrival, quiet or side turn running first
    // leaves them for the human turn that follows.
    const takesLines = mode === "human" || mode === "relay";
    const batch = takesLines ? this.speakers.get(windowId) ?? [] : [];
    if (takesLines) this.speakers.delete(windowId);
    const autonomous = mode === "quiet" || mode === "side" || (mode === "arrival" && Boolean(extra.autonomous));
    let scene = this.scene(windowId);
    const sceneThread = scene;
    if (extra.arrival?.newcomer && scene) {
      // A player joining after the first split needs access to the private primary scene
      // before its welcome is posted. Do not grant access to its earlier private messages.
      const ids = (extra.arrival.ids ?? []).filter(id => scene.members.includes(id) && this.isPc(id));
      await this.applyAudience(ids.map(id => ({ windowId, userId: this.userOf(id), characterId: id, paused: false })));
    }
    if (extra.arrival?.names && scene && !extra.arrival.newcomer) {
      const names = extra.arrival.names.filter(name => scene.members.includes(this.investigatorByName(name)));
      if (!names.length && mode === "arrival") return;
      extra.arrival = names.length ? { ...extra.arrival, names } : undefined;
    }
    if (mode === "arrival" && sceneThread && !sceneThread.opened) { sceneThread.opened = true; this.save(); }

    // Relay: lines here only from players whose character is in another scene with a window of its own (this
    // window's own scene, or a scene that is over).
    const lobby = windowId === this.mainWindow()?.id && !scene;
    if (mode === "human" && this.cfg.timelineAuto && batch.length && (scene || this.timelines.retired(windowId) || lobby)) {
      const visitors = batch.filter((l) => !scene || !scene.members.includes(l.id));
      if (visitors.length === batch.length) {
        const away = visitors.filter((l) => this.windowOf(this.timelines.of(l.id)) && this.windowOf(this.timelines.of(l.id)) !== windowId);
        if (away.length === visitors.length) {
          const readers = new Set(this.windowUsers(windowId));
          for (const l of away) {
            const home = this.windowOf(this.timelines.of(l.id));
            await this.post(windowId, { content: `→ "${this.windowName(home)}"`, kind: "narration", visibility: "whisper", whisper_to: [l.id] }, { count: false });
            // The line is answered in the player's own scene only if that does not widen who reads it.
            if (!this.windowUsers(home).every((u) => readers.has(u))) { this.log(`relay: ${this.nameOf(l.id)}'s line stays where it was written (their scene has other readers)`); continue; }
            this.speakers.set(home, [...(this.speakers.get(home) ?? []), l]);
            this.schedule(home, { mode: "relay", delay: 0, relay: { speaker: this.nameOf(l.id), window: this.windowName(windowId), text: l.content } });
          }
          return;
        }
      }
    }
    // Public conversation remains public; it does not wake the Keeper or any scene's co-players.
    if (lobby) return;
    const speakerIds = new Set(batch.map((l) => l.id));
    const visitorsIn = scene ? [...speakerIds].filter((id) => !scene.members.includes(id)) : [];

    let budget = this.cfg.maxActionsPerTurn;
    const timeline = this.timelines.ofWindow(windowId);
    // The first turn a player starts after a final review opens the new session from what it prepared (once).
    let between = windowId === this.primaryWindowId() && (["human", "relay"].includes(mode) || kickoff) ? this.betweenNote() : null;
    if (between?.transition) {
      if (!await this.postHandoff(windowId, between.transition)) throw Error("session handoff was not posted; keeping it for the next turn");
      delete this.planner.between.transition;
      this.save();
    }
    let here = null;                       // an arrival that lands in this very window
    let lastCtx = null;
    const round = async (roundMode, roundExtra) => {
      if (this.cfg.timelineAuto && MOVE_MODES.has(roundMode)) {
        const sourceReaders = new Set(this.windowUsers(windowId));
        await this.reconcilePresence(windowId, turnNo);
        if (this.timelines.retired(windowId)) {
          // A human line which triggered the reunion still needs an answer, in the actual scene.
          const readers = sourceReaders;
          for (const l of batch) {
            const home = this.windowOf(this.timelines.of(l.id));
            if (!home || home === windowId || !this.windowUsers(home).every(u => readers.has(u))) continue;
            this.speakers.set(home, [...(this.speakers.get(home) ?? []), l]);
            this.schedule(home, { mode: "relay", delay: 0, relay: { speaker: this.nameOf(l.id), window: this.windowName(windowId), text: l.content } });
          }
          return { actions: [], coplayersMayAct: false, spotlight: [], whereabouts: [] };
        }
      }
      scene = this.scene(windowId);
      const ctx = await this.buildGm(windowId, { storyPlan: this.storyPlanSection() });
      lastCtx = ctx;
      // Compaction runs beside the turn: this round's prompt is already built.
      this.memory.maintainGm(windowId, ctx.lines(windowId), ctx.render, { windowName: this.windowName(windowId) });
      const scope = new Set([...(scene?.members ?? []), ...visitorsIn]);
      const mayMove = [...scope].filter(id => this.isPc(id) ? ["human", "relay"].includes(roundMode) && speakerIds.has(id) : MOVE_MODES.has(roundMode));
      const whereabouts = this.cfg.timelineAuto && scene
        ? whereaboutsBrief({ timelines: this.timelines, scene: { timeline: scene }, nameOf: (id) => this.nameOf(id), windowName: (id) => this.windowName(id), isPc: (id) => this.isPc(id), mayMove, capReached: this.timelines.active().length >= this.cfg.timelineMaxActive })
        : "";
      const verdict = await this.scenarioVerdict(windowId, roundMode, mode);
      const scenario = this.cfg.scenarioAuto ? `Scenario change: ${verdict.ok ? (verdict.planner ? "possible this turn (the story planner judges the current event has run its course)." : "possible this turn, if the story as a whole has moved on.") : `not this turn (${verdict.reason}).`}` : "";
      const local = this.pbta ? ctx.lines(windowId).slice(-32) : [];
      const intents = local.filter(line => {
        if (roundExtra.rulingReady || line.kind !== "ic") return false;
        if (this.isPc(line.character_id)) return roundMode === "human" && batch.some(l => l.seq === line.seq);
        return roundMode === "followup";
      });
      const pbta = this.pbta && {
        ...this.pbta,
        characters: this.characters.map(c => ({ id: c.id, name: c.name, sheet: c.role_card?.pbta })),
        lines: local.map(m => ({ id: m.id, character_id: m.character_id, kind: m.kind, text: m.dice?.text ?? m.content })),
        eligible_declarations: intents.map(m => m.id),
        rulings: await this.api.pbtaRulings(this.channelId, windowId),
      };
      // A public handoff or seat correction just posted by the table must not replace the player's question.
      const newest = roundMode === "human" && ctx.newest && !this.isHuman(ctx.newest)
        ? ctx.lines(windowId).findLast(m => this.isTrigger(m)) ?? ctx.newest : ctx.newest;
      const request = { language: this.language, profile: this.profile, context: ctx.parts, pbta, newest, mode: roundMode, kickoff: roundMode === "kickoff", timeline, whereabouts, scenario, auto: this.cfg.timelineAuto, improv: this.improv.on, casual: this.casualOn(), planner: this.plannerVerdict(), between, calendar: this.calendarOn(), ...roundExtra };
      let plan = await directTurn(this.llm, request);
      const moves = MOVE_MODES.has(roundMode) && !(roundMode === "followup" && (mode === "arrival" || mode === "kickoff"));
      let placements;
      if (this.cfg.timelineAuto && scene && plan.whereabouts.length && moves) {
        const checked = await this.checkDestinations(windowId, plan.whereabouts, scope, batch, roundMode);
        placements = planWhereabouts({
          timelines: this.timelines, scene: { timeline: scene, windowId }, reports: checked.reports, scopeIds: scope, speakers: speakerIds, verifiedCompanions: true, mode: roundMode,
          resolve: n => this.investigatorByName(n), isPc: id => this.isPc(id), userOf: id => this.userOf(id), windowUsers: w => this.windowUsers(w),
          guard: this.guard, turn: turnNo, now: this.now(), cfg: this.cfg,
        });
        const blocked = new Set(placements.ignored.map(i => i.id));
        placements.ignored.push(...checked.ignored);
        if (checked.disputed || blocked.size) {
          // Drafted dialogue/opening may already put the wrong person in the other room.
          const verified = checked.reports.map(r => ({ who: r.who.filter(n => !blocked.has(this.investigatorByName(n))), destination: r.place || r.thread })).filter(r => r.who.length);
          plan = await directTurn(this.llm, { ...request, whereabouts: whereabouts + "\nVerified departures for this round: " + JSON.stringify(verified) + ". Everyone else stays. Redraft actions to respect these placements; do not report new moves." });
        }
      }
      this.generation.signal.throwIfAborted();
      if (placements?.ops.some(o => ["split", "move", "merge", "fork_main"].includes(o.op))) {
        const out = await this.applyPlan(placements, { windowId, mode: roundMode, turn: turnNo, autonomous });
        placements = null;
        if (out?.moved.length) {
          if (out.here) here = out.here;
          // Discard prose written for the old audience. Each new scene gets its own opening/context.
          if (this.scene(windowId) && !here) this.schedule(windowId, { mode: "followup", delay: 0 });
          return { actions: [], coplayersMayAct: false, spotlight: [], whereabouts: [] };
        }
      }
      if (between) { between = null; this.planner.between = null; this.save(); }
      this.log(`turn ${this.turns} (${roundMode}): ${plan.actions.length} Keeper action(s), co-players ${plan.coplayersMayAct ? "may act" : "wait"}${plan.whereabouts.length ? `, ${plan.whereabouts.length} whereabouts` : ""}`);
      const evidenceThrough = this.lastSeq;
      for (const action of plan.actions) {
        this.generation.signal.throwIfAborted();
        if (budget <= 0) break;
        if (this.pbta && action.type === "move" && !intents.some(m => m.id === action.source_id && m.character_id === action.character_id)) continue;
        budget -= await this.act(windowId, action, ctx, { mode: roundMode, parent: mode, scope, evidenceThrough });
        if (sceneThread && !this.scene(windowId)) break;
        if (this.pbta && (action.type === "move" || (["npc", "new_npc"].includes(action.type) && action.move_id))) {
          // Discard any consequences the model guessed before it saw the server's dice.
          if (!roundExtra.rulingReady && budget > 0) return round("followup", { rulingReady: true });
          break;
        }
        if (this.pbta && action.type === "ask") break;
      }
      // Whereabouts apply in rounds that may move someone; never inside an arrival or a kickoff (no cascades).
      this.generation.signal.throwIfAborted();
      if (placements) {
        for (const i of placements.ignored) this.log(`whereabouts: ${this.nameOf(i.id)}: movement proposal not applied (${i.why})`);
        const out = await this.applyPlan(placements, { windowId, mode: roundMode, turn: turnNo, autonomous });
        if (out?.here) here = out.here;
      } else if (this.cfg.timelineAuto && scene) {
        this.guard.apply(planWhereabouts({ timelines: this.timelines, scene: { timeline: scene }, reports: [], scopeIds: scope, guard: this.guard, turn: turnNo, now: this.now(), cfg: this.cfg }).guard);
      }
      // Published arrivals may establish a reunion even if the director omitted whereabouts or a movement
      // proposal was rejected. Reconcile before choosing co-players so their next turn reads the real cast.
      if (this.cfg.timelineAuto && moves) await this.reconcilePresence(windowId, turnNo);
      return plan;
    };
    // Players back after being away are welcomed back in this turn.
    const returning = takesLines ? [...new Set(batch.map((l) => l.id))].filter((id) => this.returning.has(id)).map((id) => ({ name: this.nameOf(id), away: duration(this.returning.get(id)) })) : [];
    for (const l of batch) this.returning.delete(l.id);
    let plan = await round(kickoff ? "kickoff" : mode, returning.length ? { ...extra, returning } : extra);
    if (!kickoff && mode !== "arrival") this.noteStall(windowId, lastCtx);
    if (here) { const arrival = here; here = null; plan = await round("arrival", { arrival }); }
    if (!this.scene(windowId) && sceneThread) return;                    // this window's scene just ended
    const side = mode === "side" || (mode === "arrival" && !this.presentPlayers(windowId).length);
    if (!plan.coplayersMayAct && !side) return;
    // Pace: in a quiet turn a co-player acts only if it has not since the last human line, so slow humans are not
    // drowned out by the AI side of the table.
    const st2 = this.state(windowId);
    const seated = this.roster.coplayersIn(windowId).filter((c) => mode !== "quiet" || !st2.coplayersActed?.has(c.characterId));
    const first = seated.filter((c) => plan.spotlight.some((n) => norm(n) === norm(c.name)));
    let acted = 0;
    for (const c of [...first, ...seated.filter((x) => !first.includes(x))]) {
      if (budget <= 0) break;
      const n = await this.coplayerAct(windowId, c, first.includes(c), { side });
      if (n) (st2.coplayersActed ??= new Set()).add(c.characterId);
      acted += n; budget -= n;
    }
    // Co-players are players too: their choices get the Keeper's answer now, not at the next human line.
    if (acted > 0 && budget > 0) {
      await round("followup", {});
      if (here) { const arrival = here; here = null; await round("arrival", { arrival }); }
    }
  }

  presenceThreads() {
    const hidden = this.hiddenLines();
    return this.timelines.active().filter(t => t.members.length).map(t => {
      // Reused side windows must not supply records from the previous scene that occupied them.
      const start = t.id === MAIN ? 0 : this.timelines.log.find(e => e.timelineId === t.id)?.fromSeq ?? 0;
      const lines = this.sceneHistory(this.windowOf(t)).filter(m => m.seq >= start)
        .filter(m => m.visibility === "window" && !hidden.has(m.id) && ["ic", "narration", "ooc"].includes(m.kind) &&
          (!m.character_id || this.timelines.timelineAt(m.character_id, m.seq).id === t.id))
        .slice(-40).map(m => ({ seq: m.seq, actor: m.character_id || null, kind: m.kind,
          keeper: m.author_role === "gm" && !m.character_id && m.kind === "narration",
          speaker: m.character_name || m.author_name || "Keeper", text: m.content }));
      return { key: "T" + t.handle, location: t.location, time: t.narrativeTime,
        members: t.members.map(id => ({ id, name: this.nameOf(id) })), lines };
    });
  }

  async reconcilePresence(windowId, turn) {
    const scene = this.scene(windowId);
    const threads = this.presenceThreads();
    if (!scene || threads.length < 2) return;
    const current = "T" + scene.handle;
    const digest = hashText(JSON.stringify(threads));
    if (this.presenceChecked?.get(current) === digest) return;
    let placements;
    try { placements = await readPresence(this.llm, { current, threads }); }
    catch (e) { this.generation.signal.throwIfAborted(); this.log("scene presence: " + e.message); return; }
    this.generation.signal.throwIfAborted();
    // A newer correction/departure received while the model was thinking invalidates its snapshot.
    if (hashText(JSON.stringify(this.presenceThreads())) !== digest) return;
    (this.presenceChecked ??= new Map()).set(current, digest);
    if (!placements.length) return;
    const result = planWhereabouts({ timelines: this.timelines, scene: { timeline: scene, windowId },
      reports: placements.map(p => ({ who: [this.nameOf(p.id)], thread: p.thread })),
      scopeIds: new Set(placements.map(p => p.id)), mode: "presence", resolve: n => this.investigatorByName(n),
      isPc: id => this.isPc(id), userOf: id => this.userOf(id), windowUsers: w => this.windowUsers(w),
      guard: this.guard, turn, now: this.now(), cfg: this.cfg });
    // If an entire thread is folded into the Main Chat, keep the confirmed room instead of its stale label.
    for (const p of placements) {
      const destination = this.timelines.byHandle(p.thread);
      const regroup = result.ops.find(o => o.op === "split" && o.replaces === destination.id && o.ids.includes(p.id));
      if (regroup) { regroup.place = p.place; continue; }
      const merged = result.ops.find(o => o.op === "merge" && o.from === destination.id);
      const final = merged?.into || destination.id;
      const relocation = result.ops.find(o => o.op === "relocate" && o.timeline === final);
      if (relocation) relocation.location = p.place;
      else if (result.ops.some(o => o.op === "move" && o.to === final && o.ids.includes(p.id)))
        result.ops.push({ op: "relocate", timeline: final, location: p.place });
    }
    this.log("scene presence: " + placements.map(p => `${this.nameOf(p.id)} joins ${this.nameOf(p.with)} at ${p.place} (#${p.actorSeq}, #${p.targetSeq})`).join("; "));
    await this.applyPlan(result, { windowId, mode: "presence", turn });
  }

  async checkDestinations(windowId, reports, scope, batch, mode) {
    const messages = this.history.lines(windowId).filter(m => m.visibility === "window");
    const lines = publicLines(messages);
    const actors = [];
    for (const id of scope) {
      const pc = this.isPc(id);
      if (pc && !["relay", "human"].includes(mode)) continue;
      const sources = pc ? batch.filter(l => l.id === id).map(l => l.seq) : messages.filter(m =>
        m.character_id === id && m.kind === "ic" && m.seq > this.guard.rec(id).changedSeq &&
        this.timelines.timelineAt(id, m.seq).id === this.timelines.of(id).id).map(m => m.seq);
      for (const l of batch.filter(l => l.id === id)) {
        if (!lines.some(m => m.seq === l.seq)) lines.push({ seq: l.seq, speaker: this.nameOf(id), text: l.content, kind: "ic" });
      }
      // A quiet character's last decision can precede a busy window's recent tail.
      for (const seq of sources.slice(-6)) {
        if (lines.some(l => l.seq === seq)) continue;
        const at = messages.findIndex(m => m.seq === seq);
        if (at >= 0) for (const l of publicLines(messages.slice(Math.max(0, at - 2), at + 1))) {
          if (!lines.some(existing => existing.seq === l.seq)) lines.push(l);
        }
      }
      const present = sources.filter(seq => lines.some(l => l.seq === seq));
      if (present.length) actors.push({ id, name: this.nameOf(id), sources: present });
    }
    lines.sort((a, b) => a.seq - b.seq);
    const options = new Map();
    for (const report of reports) {
      const key = report.thread === "NEW" ? "new:" + placeKey(report.place) : report.thread;
      if (!options.has(key)) options.set(key, report);
    }
    const destinations = [...options].map(([key, r]) => {
      const t = this.timelines.byHandle(key);
      return { key, place: t?.location || r.place || t?.name, companions: t?.members.map(id => this.nameOf(id)),
        recent: t ? publicLines(this.history.lines(this.windowOf(t)).filter(m => !this.hiddenLines().has(m.id))).slice(-16) : [] };
    });
    let decisions = [];
    try { decisions = await readDestinations(this.llm, { lines, actors, destinations }); }
    catch (e) { this.log("movement evidence: " + e.message); }
    const checked = [], ignored = [];
    let disputed = false;
    for (const [key, r] of options) {
      const who = decisions.filter(m => m.destination === key).map(m => this.nameOf(m.id));
      const proposed = reports.filter(other => other.thread === r.thread && (r.thread !== "NEW" || placeKey(other.place) === placeKey(r.place))).flatMap(other => other.who);
      const target = r.thread === "NEW" ? this.timelines.atPlace(r.place) : this.timelines.byHandle(r.thread);
      const missing = proposed.map(n => this.investigatorByName(n)).filter(id => id &&
        this.timelines.of(id) !== target && !who.includes(this.nameOf(id)));
      const changed = missing.length > 0 || who.some(name => !proposed.some(n => this.investigatorByName(n) === this.investigatorByName(name)));
      disputed ||= changed;
      for (const id of missing) ignored.push({ id, why: "their own latest decision does not support this destination" });
      if (who.length) checked.push({ ...r, who, opening: changed ? "" : r.opening });
    }
    return { reports: checked, ignored, disputed };
  }

  async correctPlacement(message) {
    const threads = this.timelines.active();
    const allowed = threads.filter(t => this.windowUsers(this.windowOf(t)).includes(message.author_id) ||
      t.members.some(id => this.isPc(id) && this.userOf(id) === message.author_id));
    if (!allowed.length) return;
    const actors = threads.flatMap(t => t.members).filter(id => this.roster.isCoplayer(id) || this.userOf(id) === message.author_id)
      .map(id => ({ id, name: this.nameOf(id), sources: [message.seq], current: "T" + this.timelines.of(id).handle }));
    const destinations = threads.map(t => ({ key: "T" + t.handle, place: t.location || t.name, companions: t.members.map(id => this.nameOf(id)) }));
    const lines = publicLines(this.history.lines(message.chat_window_id).filter(m => m.seq <= message.seq)).slice(-24);
    const decisions = await readDestinations(this.llm, { lines, actors, destinations, correction: message.seq });
    const reports = [];
    for (const m of decisions) {
      const target = this.timelines.byHandle(m.destination), from = this.timelines.of(m.id);
      if (m.destination === "NEW") {
        if (!allowed.includes(from) || this.timelines.atPlace(m.place)) continue;
      } else {
        const restoringPrevious = allowed.includes(from) && this.guard.rec(m.id).prev === target.id;
        if (target === from || (!allowed.includes(target) && !restoringPrevious)) continue;
      }
      if ((this.guard.rec(m.id).correctionSeq ?? 0) >= message.seq) continue;
      reports.push({ who: [this.nameOf(m.id)], thread: m.destination, place: m.place, ownScene: true, span: "short" });
    }
    if (!reports.length) return;
    const scene = this.scene(message.chat_window_id) || allowed[0];
    const turn = this.guard.beginTurn();
    const result = planWhereabouts({ timelines: this.timelines, scene: { timeline: scene }, reports,
      scopeIds: new Set(decisions.map(m => m.id)), mode: "correction", resolve: n => this.investigatorByName(n),
      isPc: id => this.isPc(id), userOf: id => this.userOf(id), windowUsers: w => this.windowUsers(w),
      guard: this.guard, turn, now: this.now(), cfg: this.cfg });
    await this.applyPlan(result, { windowId: message.chat_window_id, mode: "correction", turn, correctionSeq: message.seq });
  }

  async postHandoff(windowId, time, upTo) {
    const hidden = this.hiddenLines();
    const t = this.scene(windowId);
    // Side windows can be reused for a different scene. Old occupants' lines belong to their earlier stay.
    const start = t && t.id !== MAIN ? this.timelines.log.find(e => e.timelineId === t.id)?.fromSeq ?? 0 : 0;
    const messages = this.history.lines(windowId, { after: Math.max(0, start - 1), upTo }).filter(m => !hidden.has(m.id));
    const body = await sceneHandoff(this.llm, { messages, time, language: this.language, log: this.log });
    return this.post(windowId, body);
  }

  presentPlayers(windowId) {
    const scene = this.scene(windowId);
    if (scene) return scene.members.filter((id) => this.isPc(id));
    return (this.windows.find((w) => w.id === windowId)?.members ?? []).filter((m) => m.user_id !== this.me?.id).map((m) => m.character_id);
  }

  // ---- applying whereabouts: platform calls, then local state, then posts and arrivals
  async channelUsers() { return (await this.channelMemberRows()).users; }
  // The channel's members, cached for a minute (a window.changed event, as when someone joins, drops the cache).
  async channelMemberRows() {
    if (!this.memberCache || this.now() - this.memberCache.at > 60000) {
      const rows = (await this.api.channelMembers(this.channelId).catch(() => null)) ?? null;
      this.memberCache = { at: this.now(), rows, users: rows ? new Set(rows.map((r) => r.id ?? r.user_id)) : null };
    }
    return this.memberCache;
  }

  async applyPlan(result, { windowId, mode, turn, autonomous = false, quiet = false, correctionSeq = 0, opId = randomUUID() }) {
    const reconciling = mode === "correction" || mode === "presence";
    const ops = this.partitionPlan(result.ops.map(o => ({ ...o })));
    if (!ops.length) { this.guard.apply(result.guard); if (result.ignored?.length) this.noteIgnored(windowId, result.ignored); return null; }
    const lastSeq = this.lastSeq;
    // Persist the exact parent and idempotency key BEFORE sending a fork request. Recovery also covers
    // a server commit whose response was lost. No scene is played until every audience has its fork.
    for (const [i, o] of ops.entries()) if (["split", "fork_main"].includes(o.op)) {
      o.parentWindowId ??= this.windowOf(this.timelines.get(o.replaces || o.fromTimeline) ?? this.timelines.main());
      o.requestId ??= `scene:${opId}:${i}`;
    }
    this.journal = { opId, mode, correctionSeq, ops, changed: result.changed, windowId, created: [], phase: "A" };
    this.save();
    const users = await this.channelUsers();
    const windowFor = new Map();
    for (const o of ops.filter(o => ["split", "fork_main"].includes(o.op))) {
      if (o.legacyWindowId) { windowFor.set(o, o.legacyWindowId); continue; }
      const pcs = o.ids.filter(id => this.isPc(id));
      const members = [];
      for (const id of pcs) {
        const user_id = this.userOf(id);
        if (!user_id || (users && !users.has(user_id))) throw Error("Cannot fork a scene for someone outside this channel");
        if (!members.some(m => m.user_id === user_id)) members.push({ user_id, character_id: id });
      }
      const w = await this.api.forkWindow(this.channelId, o.parentWindowId, {
        name: `${pcs.length ? "Scene" : "Side"}: ${String(o.place).slice(0, 60)}`, kind: "group", members, request_id: o.requestId,
      });
      windowFor.set(o, w.id);
      this.journal.created.push({ windowId: w.id });
      this.save();
    }

    // B. Commit all local placements together, after every server fork exists.
    const fromSeq = lastSeq + 1;
    const before = new Map(investigatorsFor(this.characters, this.roster).map((c) => [c.id, this.timelines.of(c.id).id]));
    const beforeWindows = new Map([...before].map(([id, t]) => [id, this.windowOf(this.timelines.get(t))]));
    for (const o of ops) if (o.op === "move") this.timelines.move(o.ids, o.to, fromSeq);
    const created = [];
    for (const o of ops) {
      if (o.op !== "split" || o.skip) continue;
      let t;
      if (o.primary) {
        t = this.timelines.move(o.ids, MAIN, fromSeq);
        this.timelines.bind(MAIN, windowFor.get(o));
        this.timelines.relocate(MAIN, { location: o.place, narrativeTime: o.time });
        t.opened = reconciling;
      } else t = this.timelines.split({ name: o.place, members: o.ids, windowId: windowFor.get(o), returnTo: [windowId], location: o.place, narrativeTime: o.time ?? "", span: o.span, opened: reconciling, fromSeq });
      if (o.replaces) this.timelines.merge(o.replaces, t.id, fromSeq);
      created.push({ op: o, timeline: t });
    }
    for (const o of ops) if (o.op === "merge") this.timelines.merge(o.from, o.into, fromSeq);
    for (const o of ops) if (o.op === "relocate") this.timelines.relocate(o.timeline, { location: o.location, narrativeTime: o.narrativeTime });
    for (const o of ops) if (o.op === "bind_main") this.timelines.bind(MAIN, o.windowId);
    for (const o of ops.filter(o => o.op === "fork_main")) {
      this.timelines.bind(MAIN, windowFor.get(o));
      this.timelines.main().opened = reconciling;
      created.push({ op: o, timeline: this.timelines.main() });
    }
    const after = new Map([...before.keys()].map((id) => [id, this.timelines.of(id).id]));
    const moved = [...before.keys()].filter((id) => before.get(id) !== after.get(id) || beforeWindows.get(id) !== this.windowOf(this.timelines.of(id)));
    // Co-players' seats follow their timeline's window, cut per window.
    const cut = (w) => this.windowSeq.get(w) ?? lastSeq;
    for (const id of moved) {
      const cp = this.roster.coplayers.find((c) => c.characterId === id);
      const target = this.windowOf(this.timelines.of(id));
      if (cp && target) this.roster.moveSeats([cp], [target], cut, () => fromSeq);
    }
    this.guard.apply(result.guard);
    const travelled = moved.filter(id => before.get(id) !== after.get(id));
    this.guard.commit(travelled, { turn, now: this.now(), seq: lastSeq, prevOf: (id) => before.get(id), windowed: created.flatMap((c) => c.op.ids.filter((id) => this.isPc(id))) });
    if (correctionSeq) for (const id of travelled) this.guard.by[id].correctionSeq = correctionSeq;
    const audience = [];
    for (const id of moved.filter(id => this.isPc(id))) {
      const userId = this.userOf(id), source = beforeWindows.get(id), dest = this.windowOf(this.timelines.of(id));
      if (source === dest) continue;
      if (source && source !== this.mainWindow()?.id && !this.scene(source)?.members.some(other => this.isPc(other) && this.userOf(other) === userId))
        audience.push({ windowId: source, userId, paused: true });
      if (dest) audience.push({ windowId: dest, userId, characterId: id, paused: false });
    }
    this.journal = { ...this.journal, phase: "B", audience };
    this.checkInvariants();
    this.save();

    // C. Refresh (the new windows), then D. posts and E. arrivals. A failed refresh never stops the posts.
    try { await this.refresh(); } catch (e) { this.log(`refresh after a split failed: ${e.message}`); }
    await this.applyAudience(audience);
    const ignored = [...(result.ignored ?? [])];
    const summary = [];
    for (const { op, timeline: t } of created) {
      const w = t.windowId;
      if (op.opening) await this.post(w, { content: op.opening, kind: "narration" }, { count: false });
      const leaving = op.ids.filter((id) => this.isPc(id) && beforeWindows.get(id) !== w);
      const sources = [...new Set(leaving.map((id) => beforeWindows.get(id)))].filter(Boolean);
      for (const src of sources) {
        const to = leaving.filter((id) => beforeWindows.get(id) === src);
        if (to.length) await this.post(src, { content: `→ "${this.windowName(w)}"`, kind: "narration", visibility: "whisper", whisper_to: to }, { count: false });
      }
      summary.push(`${op.ids.map((id) => this.nameOf(id)).join(", ")} → ${t.name} ("${this.windowName(w)}", ${t.span} split)`);
      if (!reconciling) {
        const continuing = op.op === "fork_main" && !ops.some(o => o.op === "relocate" && o.timeline === MAIN);
        if (continuing && !this.deferArrivals) { t.opened = true; this.schedule(w, { mode: "followup", delay: 0 }); }
        else this.scheduleArrival(w, { names: op.ids.map((id) => this.nameOf(id)), place: t.location, opening: op.opening, reunion: false }, { autonomous, mode });
      }
    }
    // Reunions: everyone who ended in an existing thread, grouped by where they ended, one arrival per window.
    let here = null;
    const inNew = new Set(created.flatMap((c) => c.timeline.members));
    const byWindow = new Map();
    for (const id of moved) {
      if (inNew.has(id)) continue;
      const dest = this.timelines.get(after.get(id));
      const w = dest && this.windowOf(dest);
      if (!w) continue;
      if (!byWindow.has(w)) byWindow.set(w, { dest, ids: [] });
      byWindow.get(w).ids.push(id);
    }
    // A thread merged away points its old window at where its members went (only if some of them went there).
    for (const o of ops.filter((x) => x.op === "merge")) {
      const old = this.timelines.get(o.from);
      if (!old?.windowId) continue;
      const went = moved.filter((id) => before.get(id) === o.from).map((id) => this.windowOf(this.timelines.get(after.get(id)) ?? this.timelines.main()));
      const target = went.sort((a, b) => went.filter((x) => x === b).length - went.filter((x) => x === a).length)[0];
      if (target && target !== old.windowId) await this.post(old.windowId, { content: `→ "${this.windowName(target)}"`, kind: "narration" }, { count: false });
      // Its scene is over: what happened there becomes a chapter of the Keeper's memory.
      this.memory.maintainGm(old.windowId, this.history.lines(old.windowId).filter((m) => !this.hiddenLines().has(m.id)), (m) => this.renderForGm(m), { windowName: this.windowName(old.windowId), whole: true });
    }
    for (const [w, { dest, ids }] of byWindow) {
      summary.push(`${ids.map((id) => this.nameOf(id)).join(", ")} → ${dest.name}`);
      const arrival = { names: ids.map((id) => this.nameOf(id)), place: dest.location, reunion: true };
      if (reconciling) continue;
      if (w === windowId) here = arrival;
      else this.scheduleArrival(w, arrival, { autonomous, mode });
    }
    if (reconciling) {
      // Correct both casts without announcing a fictional journey or revealing the other room.
      const affected = new Set(moved.flatMap(id => [before.get(id), after.get(id)]));
      for (const id of affected) {
        const t = this.timelines.get(id), w = this.windowOf(t);
        if (t.status === "active" && w) await this.post(w, {
          content: correctionNotice(this.language, t.location || t.name, t.members.map(id => this.nameOf(id))), kind: "narration",
        }, { count: false });
      }
    }
    if (!quiet && summary.length) await this.post(windowId, { content: `Timelines: ${summary.join("; ")}`, kind: "narration", visibility: "gm_only" }, { count: false });
    if (ignored.length) this.noteIgnored(windowId, ignored);
    this.journal = null;
    this.save();
    await this.archiveRetired();
    return { here, moved };
  }

  noteIgnored(windowId, ignored) {
    const text = ignored.map((i) => `${this.nameOf(i.id)}: ${i.why}`).join("; ");
    this.post(windowId, { content: `Whereabouts not applied: ${text}`, kind: "narration", visibility: "gm_only" }, { count: false }).catch(() => {});
  }

  // Arrivals are capped per hour; those that come from autonomous turns also respect the idle pause and the hourly
  // autonomy cap. `force` (roll-forward after a restart, CLI-owed arrivals) skips the caps.
  scheduleArrival(windowId, arrival, { autonomous = false, force = false } = {}) {
    if (this.deferArrivals) { this.owedArrivals.push({ windowId, arrival }); return null; }
    const now = this.now();
    this.arrivalTimes = this.arrivalTimes.filter((t) => now - t < HOUR);
    if (!force) {
      if (this.arrivalTimes.length >= this.cfg.timelineMaxArrivalsPerHour) { this.log(`arrival in "${this.windowName(windowId)}" skipped: hourly arrival cap`); return null; }
      if (autonomous) {
        this.autonomousTurns = this.autonomousTurns.filter((t) => now - t < HOUR);
        if (now - this.lastHumanAt > this.cfg.autonomyIdleMinutes * 60000 || this.autonomousTurns.length >= this.cfg.autonomyMaxTurnsPerHour || this.overBudget()) { this.log("arrival skipped: autonomy paused"); return null; }
      }
    }
    this.arrivalTimes.push(now);
    return this.schedule(windowId, { mode: "arrival", delay: 0, arrival, autonomous });
  }

  // LLM_DAILY_TOKEN_BUDGET: once today's billable-equivalent tokens reach it, the table stops starting turns of its own
  // (answers to humans still run). Logged once a day.
  overBudget() {
    if (!this.cfg.dailyTokenBudget) return false;
    const day = new Date(this.now()); day.setHours(0, 0, 0, 0);
    const spent = billableTokens(this.store.usageSince(day.getTime()));
    if (spent < this.cfg.dailyTokenBudget) return false;
    if (this.budgetNoted !== day.getTime()) { this.budgetNoted = day.getTime(); this.log(`daily token budget reached (${spent} of ${this.cfg.dailyTokenBudget}): no autonomous turns until tomorrow`); }
    return true;
  }

  // After every change: each co-player has one open seat, in its timeline's window; every investigator is in one
  // active timeline; every active thread other than the main one has a window. Violations are logged and repaired.
  checkInvariants() {
    const ids = investigatorsFor(this.characters, this.roster).map((c) => c.id);
    const counts = new Map(ids.map((id) => [id, 0]));
    for (const t of this.timelines.active()) for (const id of t.members) counts.set(id, (counts.get(id) ?? 0) + 1);
    if ([...counts.values()].some((n) => n !== 1)) { this.log("invariant: an investigator was in zero or several timelines; repaired"); this.timelines.reconcile(ids); }
    for (const t of this.timelines.active()) if (t.id !== MAIN && !t.windowId) { this.log(`invariant: thread "${t.name}" had no window; merged`); this.timelines.merge(t.id, MAIN, this.lastSeq + 1); }
    for (const cp of this.roster.coplayers) {
      const want = this.windowOf(this.timelines.of(cp.characterId));
      const open = openWindows(cp);
      if (want && !(open.length === 1 && open[0] === want)) {
        this.log(`invariant: ${cp.name}'s seat did not match its timeline; repaired`);
        this.roster.moveSeats([cp], [want], (w) => this.windowSeq.get(w) ?? this.lastSeq);
      }
    }
  }

  // ---- the Keeper's moves. Returns how many lines were posted.
  async act(windowId, a, ctx, { mode, parent = mode, scope = null, evidenceThrough } = {}) {
    this.generation.signal.throwIfAborted();
    switch (a.type) {
      case "time_skip": {
        const scene = this.scene(windowId);
        const time = typeof a.time === "string" && a.time.trim().slice(0, 120);
        if (!scene || !time || scene.narrativeTime === time) return 0;
        this.timelines.relocate(scene.id, { narrativeTime: time });
        this.save();
        return this.postHandoff(windowId, time, evidenceThrough);
      }
      case "narrate": return this.post(windowId, { content: a.text, kind: "narration" });
      case "note": return this.post(windowId, { content: a.text, kind: "narration", visibility: "gm_only" });
      case "truth":
        if (this.improv.on && addTruth(this.improv, a.text)) { this.log(`hidden truth recorded: ${a.text.slice(0, 100)}`); this.save(); this.declare(a.text, true); }
        return 0;
      case "world_change": this.declare(a.text, a.secret === true || a.secret === "true"); return 0;
      case "planner_note": return this.plannerNote(a);
      case "date": {
        if (!this.calendarOn()) return 0;
        // While the planner is on, the story's first date is its to choose (from the era, the world and its plots).
        const first = !this.calendar.date && a.date && this.plannerMode() !== "off";
        if (first) this.log(`calendar: the Keeper's first date "${a.date}" left to the story planner`);
        const change = this.moveCalendar({ days: a.advance_days, date: first ? undefined : a.date, time: a.time, why: a.reason ?? a.text, by: "keeper" });
        const held = await this.calendarHeld(windowId, change);
        if (change.changed && change.from && change.to) {
          const scene = this.scene(windowId);
          if (scene && a.time) { this.timelines.relocate(scene.id, { narrativeTime: a.time }); this.save(); }
          return held + await this.postHandoff(windowId, change.to, evidenceThrough);
        }
        return held;
      }
      case "bond": this.recordBond(a, "keeper"); return 0;
      case "dice": return this.gmDice(windowId, a);
      case "text": return this.casualOn() ? this.sendText(a) : 0;
      case "npc":
      case "new_npc": {
        const who = this.characterByName(a.name);
        if (this.roster.coplayerByName(a.name) || who?.kind === "pc") { this.log(`the Keeper tried to voice ${a.name}, a ${this.roster.isCoplayer(who?.id) || !who ? "co-player" : "player character"}; skipped`); return 0; }
        let npc = this.roster.npcByName(a.name);
        if (!npc && a.type === "npc") { this.log(`the Keeper named an unknown NPC (${a.name}); skipped instead of creating a character`); return 0; }
        if (!npc) npc = await this.createNpc(a.name, a.brief, ctx.text);
        if (!npc || !a.text) return 0;
        if (this.pbta && a.move_id) {
          const sheet = this.characters.find(c => c.id === npc.characterId);
          const move = this.pbta.pack.moves.find(m => m.id === a.move_id);
          if (!sheet || !move || /^[.。]/.test(a.text.trim())) return 0;
          await prepareActor(this.api, this.llm, this.channelId, {
            rules: this.pbta, language: this.language, world: this.improv.world, existing: sheet,
            npc: true, requiredBook: move.book,
          });
          const line = await this.api.postMessage(this.channelId, windowId, {
            content: a.text, kind: "ic", character_id: npc.characterId,
          });
          this.noteLine(line);
          const result = await this.api.pbtaRuling(this.channelId, windowId, {
            op: "move", source_id: line.id, character_id: npc.characterId, move_id: move.id,
            modifier: a.modifier ?? 0, revision: this.pbta.revision,
          });
          this.noteLine(result);
          return 2;
        }
        return this.post(windowId, { content: a.text, kind: "ic", character_id: npc.characterId });
      }
      case "whisper": {
        const target = this.characterByName(a.to);
        if (!target) return this.post(windowId, { content: `(whisper for ${a.to}) ${a.text}`, kind: "narration", visibility: "gm_only" });
        return this.post(windowId, { content: a.text, kind: "narration", visibility: "whisper", whisper_to: [target.id] });
      }
      case "ask":
      case "mark":
      case "move": {
        if (!this.pbta) return 0;
        const target = this.characters.find(c => c.id === a.character_id);
        if (!target || (scope && target.kind === "pc" && !scope.has(target.id))) return 0;
        if (a.type === "move" && target.kind === "npc" && !target.role_card?.pbta?.book) {
          const move = this.pbta.pack.moves.find(m => m.id === a.move_id);
          if (!move) return 0;
          await prepareActor(this.api, this.llm, this.channelId, {
            rules: this.pbta, language: this.language, world: this.improv.world, existing: target,
            npc: true, requiredBook: move.book,
          });
        }
        const result = await this.api.pbtaRuling(this.channelId, windowId, { ...a, op: a.type, revision: this.pbta.revision });
        this.noteLine(result);
        this.cards.delete(target.id);
        return 1;
      }
      case "request_roll": return this.pbta ? 0 : this.requestRoll(windowId, a, scope);
      case "split": return this.cfg.timelineAuto ? 0 : this.legacySplit(windowId, a);
      case "rejoin": return this.cfg.timelineAuto ? 0 : this.legacyRejoin(a);
      case "timeline": {
        const t = this.timelines.byName(a.timeline) ?? this.timelines.main();
        const changed = a.narrative_time && a.narrative_time !== t.narrativeTime;
        this.updateTimeline(a);
        const w = this.windowOf(t);
        return changed && w ? this.postHandoff(w, t.narrativeTime, evidenceThrough) : 0;
      }
      case "advance_scenario":
      case "enter_scenario": return this.changeScenario(windowId, a, mode, parent, evidenceThrough);
      default: return 0;
    }
  }

  async requestRoll(windowId, a, scope = null) {
    const command = String(a.command ?? "").trim();
    const target = this.characterByName(a.who);
    if (!this.profile.roll.test(command) || !target) return a.text ? this.post(windowId, { content: a.text, kind: "narration" }) : 0;
    // Only someone in this scene (or a player writing here from elsewhere) can be asked to roll for it.
    if (scope && (this.isPc(target.id) || this.roster.isCoplayer(target.id)) && !scope.has(target.id)) {
      return this.post(windowId, { content: `Roll request for ${target.name} not posted: they are not in this scene.`, kind: "narration", visibility: "gm_only" });
    }
    let n = 0;
    if (this.roster.isCoplayer(target.id) || this.roster.isNpc(target.id)) {
      // The client rolls for the characters it plays; the platform rolls against their own sheets.
      if (a.text) n += await this.post(windowId, { content: a.text, kind: "narration" });
      n += await this.post(windowId, { content: command, kind: "ic", character_id: target.id });
      return n;
    }
    // A player's roll is asked for, never made, and asked in the player's own scene.
    const home = this.isPc(target.id) ? this.windowOf(this.timelines.of(target.id)) : null;
    return this.post(home ?? windowId, { content: `${a.text ? `${a.text}\n` : ""}→ ${target.name}: ${command}`, kind: "narration" });
  }

  // The GM's own dice (D&D: a monster's initiative, the order, plain rolls), posted as the GM account's line so the
  // platform rolls it; it has no character, so nothing is rolled against a sheet.
  async gmDice(windowId, a) {
    const command = String(a.command ?? "").trim();
    if (!this.profile.gmDice?.test(command)) { this.log(`dice "${command}" skipped: not a command the GM may run`); return 0; }
    let n = 0;
    if (a.text) n += await this.post(windowId, { content: a.text, kind: "narration" });
    n += await this.post(windowId, { content: command, kind: "narration" });
    this.initiative.delete(windowId);
    return n;
  }

  // ---- scenarios
  // `parent` is the turn's own mode: a followup round inside a quiet, side or arrival turn is still autonomous.
  async scenarioVerdict(windowId, mode, parent = mode) {
    if (mode === "manual") return { ok: true };
    if (!this.cfg.scenarioAuto) return { ok: false, reason: "automatic scenario changes are off" };
    if (windowId !== this.primaryWindowId()) return { ok: false, reason: "only from the primary scene" };
    if (!["human", "followup"].includes(mode) || !["human", "relay"].includes(parent)) return { ok: false, reason: "only right after a player's or co-player's line, never in an autonomous turn" };
    const short = this.timelines.active().find((t) => t.id !== MAIN && t.span !== "long");
    if (short) return { ok: false, reason: `the party is briefly split ("${short.name}"): bring them together first` };
    const minutes = (this.now() - (this.scenario?.since ?? 0)) / 60000;
    // The story planner's "move on" lifts the pace guard (not the other rules).
    if (this.planner.arc?.verdict?.moveOn) return { ok: true, planner: true };
    if (minutes < this.cfg.scenarioMinMinutes) return { ok: false, reason: `the current scenario began ${Math.floor(minutes)} min ago (at least ${this.cfg.scenarioMinMinutes})` };
    const scenes = (await this.api.scenes(this.channelId).catch(() => [])) ?? [];
    const cur = scenes.find((s) => s.id === this.channel.current_scene_id || s.id === this.scenario?.id);
    const events = Number(cur?.event_count ?? 0);
    if (cur && events < this.cfg.scenarioMinLines) return { ok: false, reason: `only ${events} lines in the current scenario (at least ${this.cfg.scenarioMinLines})` };
    return { ok: true, scenes };
  }

  async changeScenario(windowId, a, mode, parent = mode, evidenceThrough) {
    const v = await this.scenarioVerdict(windowId, mode, parent);
    if (!v.ok) return this.post(windowId, { content: `Scenario change refused: ${v.reason}.`, kind: "narration", visibility: "gm_only" });
    // A scenario change that jumps days ahead keeps to the calendar's pace: refused whole, so the new scene's time and
    // the date never disagree.
    if (this.calendarOn() && Number(a.advance_days) > 0 && mode !== "manual") {
      const { minMinutes, minLines } = this.calendarPaceCfg();
      const p = calendarPace(this.calendar, { now: this.now(), minMinutes, minLines });
      if (!p.ok) return this.post(windowId, { content: `Scenario change refused: the date moved on too recently to jump ahead again (${p.wait} first). Change the scenario within the same day (advance_days 0), or let the day play out.`, kind: "narration", visibility: "gm_only" });
    }
    try {
      let res;
      if (a.type === "enter_scenario") {
        const scenes = v.scenes ?? (await this.api.scenes(this.channelId));
        const target = scenes.find((s) => s.status === "active" && s.id !== this.channel.current_scene_id && (norm(s.title) === norm(a.scenario) || s.id === a.scenario));
        if (!target) return this.post(windowId, { content: `Scenario change refused: no prepared scenario "${a.scenario}".`, kind: "narration", visibility: "gm_only" });
        res = await this.api.enterScenario(this.channelId, target.id);
      } else {
        res = await this.api.advanceScenario(this.channelId, { title: a.title ?? "", location: a.location ?? "", narrative_time: a.narrative_time ?? "" });
      }
      const scene = res?.scene;
      this.channel.current_scene_id = scene?.id ?? this.channel.current_scene_id;
      this.scenario = { id: this.channel.current_scene_id, since: this.now() };
      const oldTime = this.timelines.main().narrativeTime;
      this.timelines.relocate(MAIN, { location: scene?.location || a.location, narrativeTime: scene?.narrative_time || a.narrative_time });
      const moved = Number(a.advance_days) > 0 && this.calendarOn() ? this.moveCalendar({ days: a.advance_days, why: `scenario: ${scene?.title ?? a.title ?? a.scenario ?? ""}`, by: "keeper" }) : null;
      const held = moved ? await this.calendarHeld(windowId, moved) : 0;
      this.beatClosed();   // the planner's "move on" is spent; the next plan opens the next beat
      this.save();
      this.log(`scenario: ${scene?.title ?? a.title ?? a.scenario} (${a.reason ?? "the story moved on"})`);
      const time = this.timelines.main().narrativeTime;
      const advancedDay = Boolean(moved?.changed);
      if ((time && time !== oldTime) || advancedDay) return held + await this.postHandoff(windowId, advancedDay ? describeCalendar(this.calendar, { time }) : time, evidenceThrough);
      return held;
    } catch (e) {
      return this.post(windowId, { content: `Scenario change failed: ${e.message}`, kind: "narration", visibility: "gm_only" });
    }
  }

  // ---- manual commands from the CLI (applied by the run process, or by the CLI itself when no run process is up)
  async command(cmd) {
    const turnNo = this.guard.beginTurn();
    await this.refresh();
    const resolveAll = (list) => names(list).map((n) => this.investigatorByName(n)).filter(Boolean);
    if (cmd.cmd === "world") return this.setWorld(cmd);
    if (cmd.cmd === "casual") return this.setCasual(cmd.on);
    if (cmd.cmd === "plan") return this.planCommand(cmd.action);
    if (cmd.cmd === "date" && !this.calendarOn()) throw new Error("date: the story keeps a calendar only in a casual game (casual on)");
    if (cmd.cmd === "date") { const r = this.moveCalendar({ days: cmd.days, date: cmd.date, time: cmd.time, why: cmd.why ?? "by the operator", by: "operator" }); if (r.refused) throw new Error(`date: ${r.refused}`); return r; }
    if (cmd.cmd === "bond") {
      const [a, b] = [cmd.a, cmd.b].map((n) => this.characterByName(n)?.id);
      if (!a || !b) throw new Error(`bond: no character named ${!a ? cmd.a : cmd.b}`);
      return this.recordBond({ a: this.nameOf(a), b: this.nameOf(b), kind: cmd.kind, note: cmd.note, secret: cmd.secret, end: cmd.end }, "operator");
    }
    if (cmd.cmd === "advance") return this.changeScenario(this.primaryWindowId(), { type: "advance_scenario", title: cmd.title, location: cmd.location, narrative_time: cmd.time, reason: "by the operator" }, "manual");
    let reports;
    let windowId = this.primaryWindowId();
    if (cmd.cmd === "split") {
      const ids = resolveAll(cmd.who);
      if (!ids.length) throw new Error("split: no investigator matched");
      windowId = this.windowOf(this.timelines.of(ids[0])) ?? windowId;
      reports = [{ who: ids.map((id) => this.nameOf(id)), thread: "NEW", place: cmd.place, ownScene: true, span: cmd.span === "long" ? "long" : "short", time: cmd.time ?? "", opening: cmd.opening ?? "" }];
    } else if (cmd.cmd === "rejoin") {
      const t = this.timelines.byName(cmd.timeline);
      if (!t || t.id === MAIN || t.status !== "active") throw new Error(`rejoin: no active timeline "${cmd.timeline}"`);
      windowId = t.windowId;
      reports = [{ who: t.members.map((id) => this.nameOf(id)), thread: "T0", place: "", ownScene: false, span: "short", time: "", opening: "" }];
    } else throw new Error(`unknown command ${cmd.cmd}`);
    const scene = this.scene(windowId) ?? this.timelines.main();
    const scope = new Set(investigatorsFor(this.characters, this.roster).map((c) => c.id));
    const result = planWhereabouts({ timelines: this.timelines, scene: { timeline: scene, windowId }, reports, scopeIds: scope, mode: "manual", resolve: (n) => this.investigatorByName(n), isPc: (id) => this.isPc(id), userOf: (id) => this.userOf(id), windowUsers: (w) => this.windowUsers(w), guard: this.guard, turn: turnNo, now: this.now(), cfg: this.cfg });
    return this.applyPlan(result, { windowId, mode: "manual", turn: turnNo });
  }

  // ---- the story planner (planner.mjs)
  // off unless the configuration (planner.enabled) and the table (`plan on|off`) both say on.
  plannerMode() { return this.cfg.planner && this.cfg.planner.enabled === false ? "off" : plannerModeOf(this.planner, this.improv); }
  storyPlanSection() { return this.plannerMode() === "off" ? "" : renderStoryPlan(this.planner.arc, this.cfg.planner?.planTokens ?? 1500); }
  plannerVerdict() {
    const arc = this.planner.arc;
    if (this.plannerMode() === "off") return null;
    return { on: true, moveOn: Boolean(arc?.verdict?.moveOn && !arc.beat?.closed), beat: arc?.beat?.title ?? "", why: arc?.verdict?.why ?? "", next: arc?.next?.[0]?.what ?? "" };
  }
  impulseFor(coplayerId) {
    if (this.plannerMode() !== "full") return null;
    const i = this.planner.impulses.find((x) => x.coplayerId === coplayerId);
    return i && this.lastSeq <= i.expiresSeq ? i : null;
  }

  // After a turn: the same scenario, place, world record, truths and threads as last time means the story stood still.
  noteStall(windowId, ctx) {
    const scene = this.scene(windowId);
    const sig = stallSignature({ scenarioId: this.scenario?.id, place: placeKey(scene?.location), worldVersion: ctx?.world?.version, worldChange: ctx?.world?.recent_changes?.[0]?.created_at ?? ctx?.world?.recent_changes?.[0]?.version, truths: this.improv.truths.length, threads: this.timelines.active().length });
    const st = this.planner.stall;
    if (st.sig === sig) st.turns++; else { st.turns = 0; st.sig = sig; }
  }

  // The GM's planner_note action: a signal for the next plan (and "this beat is done").
  async plannerNote(a) {
    const text = String(a.text ?? "").trim();
    if (!text) return 0;
    this.planner.notes = [...this.planner.notes, { text: text.slice(0, 400), beatDone: a.beat_done === true || a.beat_done === "true", seq: this.lastSeq }].slice(-5);
    this.planner.asked = { why: text.slice(0, 200), at: this.now() };
    if (a.beat_done === true || a.beat_done === "true") this.beatClosed();
    this.save();
    return this.post(this.mainWindow().id, { content: `Planner note: ${text}`, kind: "narration", visibility: "gm_only" }, { count: false });
  }
  beatClosed() {
    const arc = this.planner.arc;
    if (!arc) return;
    arc.beat.closed = true;
    arc.verdict = { ...arc.verdict, moveOn: false };
  }

  async planCommand(action) {
    if (action === "on" || action === "off") { this.planner.on = action === "on"; this.save(); this.log(`story planner ${action}`); return; }
    if (action !== "now") throw new Error(`unknown plan action ${action}`);
    if (this.generation.paused) throw new Error("hosting is paused until a player speaks");
    if (this.overBudget()) throw new Error("the daily token budget is spent; the planner waits for tomorrow");
    await this.runPlanner("manual");
    await this.adoptPlan();
  }

  // At a turn boundary: plan now if due (in the background, beside the turns).
  maybePlan() {
    const cfg = this.cfg.planner;
    if (this.generation.signal.aborted || !cfg || this.plannerMode() === "off" || (cfg.intervalMs === 0 && !this.planner.asked && this.planner.arc)) return null;
    const p = this.planner;
    const reason = plannerDue({
      on: p.on, busy: this.memory.jobs.has("planner"), overBudget: this.overBudget(), now: this.now(), lastHumanAt: this.lastHumanAt, idleMs: this.cfg.autonomyIdleMinutes * 60000,
      runs: p.runs, lastRunAt: p.lastRunAt, lastRunSeq: p.lastRunSeq, lastSeq: this.lastSeq, arc: p.arc, asked: p.asked, scenarioId: this.scenario?.id ?? null, plannerScenarioId: p.scenarioId, stallTurns: p.stall.turns, noDate: this.calendarOn() && !this.calendar.date,
    }, cfg);
    if (!reason) return null;
    return this.runPlanner(reason);
  }

  // The planning job: the Keeper's context plus the planner's briefing, three model calls, the result parked for the
  // next turn boundary. One at a time; failures are logged, never thrown. With `session` it is that session's final
  // review: it reads every window's lines of the session and also prepares the next one (`between`).
  runPlanner(reason, { session = null } = {}) {
    if (this.generation.signal.aborted) return null;
    if (this.memory.jobs.has("planner")) return this.memory.jobs.get("planner");
    const p = this.planner;
    p.runs = [...p.runs.filter((t) => this.now() - t < 3600000), this.now()];
    p.lastRunAt = this.now();
    const notes = [...p.notes], asked = p.asked;
    const inbox = [...p.inbox];   // Keep these durable until the plan succeeds, including across pause/restart.
    this.save();
    const since = session ? Math.min(p.lastRunSeq, session.fromSeq - 1) : p.lastRunSeq;
    return this.memory.run("planner", this.generation.task(async () => {
      const windowId = this.primaryWindowId();
      if (!windowId) return;
      const ctx = await this.buildGm(windowId, { peek: true });
      const hidden = this.hiddenLines();
      const windows = session ? this.windows : this.windows.filter((w) => w.id === windowId);
      const fresh = windows.flatMap((w) => this.history.lines(w.id).filter((m) => m.seq > since && !hidden.has(m.id)).map((m) => ({ m, w })))
        .sort((x, y) => x.m.seq - y.m.seq).slice(session ? -300 : -200)
        .map(({ m, w }) => (session && w.id !== windowId ? `[${w.name}] ${ctx.render(m)}` : ctx.render(m))).join("\n");
      const minutes = session ? Math.max(1, Math.round((session.lastAt - session.startedAt) / 60000)) : 0;
      const sinceText = [
        session ? `The session that just ended: ${session.lines} player lines over ${minutes} min, from line #${session.fromSeq}. Its lines in every window follow (window named when not the Main Chat).` : `${this.lastSeq - since} lines since (the newest ${Math.min(200, this.lastSeq - since)} of this window below)`,
        notes.length ? `The Keeper's notes to you: ${notes.map((n) => `"${n.text}"${n.beatDone ? " (beat done)" : ""}`).join("; ")}` : "",
        p.scenarioId && p.scenarioId !== this.scenario?.id ? "The scenario changed since the last plan." : "",
        fresh ? `Recent lines:\n${fresh}` : "",
      ].filter(Boolean).join("\n");
      const mode = this.plannerMode();
      const out = await planStory(this.plannerLlm, {
        language: this.language, profile: this.profile, mode, contextText: ctx.text, prev: p.arc, since: sinceText, coplayers: this.roster.coplayers, secrets: [this.improv.secrets, ...this.improv.truths.map((t) => t.text)],
        nextId: p.nextThreadId, lastSeq: this.lastSeq, trigger: reason, now: this.now(), impulseLines: this.cfg.planner?.impulseLines ?? 60, log: this.log,
        final: session ? { maxDays: this.cfg.planner?.finalReviewMaxDays ?? 30 } : null, calendar: this.calendarOn(),
        table: Boolean(p.window), wishes: p.window ? renderInbox(inbox, p.table) : "",
      });
      this.generation.signal.throwIfAborted();
      p.notes = p.notes.filter(n => !notes.includes(n));
      p.inbox = p.inbox.filter(l => !inbox.includes(l));
      if (p.asked === asked) p.asked = null;
      p.pending = { ...out, at: this.now(), trigger: reason, answered: inbox.length, ...(session ? { session } : {}) };
      this.save();
      if (this.pending === 0) await this.adoptPlan();
    }));
  }

  // Makes a finished plan the current one (idempotent), records it and tells the Keeper once per version. A plan may
  // set the story's first date and change relationships; a final review also moves the calendar on and records what
  // happened off-screen.
  async adoptPlan() {
    const p = this.planner;
    const pend = p.pending;
    if (!pend || this.generation.signal.aborted) return;
    p.pending = null;
    p.arc = pend.arc; p.impulses = pend.impulses ?? []; p.nextThreadId = pend.nextId ?? p.nextThreadId;
    p.lastRunSeq = this.lastSeq; p.scenarioId = this.scenario?.id ?? null; p.stall = { turns: 0, sig: null };
    this.store.addPlan({ version: pend.arc.version, at: pend.at ?? this.now(), trigger: pend.trigger ?? pend.arc.trigger, record: pend.record ?? {} });
    if (this.calendarOn() && pend.arc.calendar?.start && !this.calendar.date) {
      // The first date: a real YYYY-MM-DD, its year within the channel's era.
      const fit = fitEra(pend.arc.calendar.start, this.channel?.era);
      if (!fit) this.log(`planner: first date "${pend.arc.calendar.start}" is not YYYY-MM-DD; the next plan chooses again`);
      else {
        if (fit.moved) this.log(`planner: first date ${pend.arc.calendar.start} is outside the era "${this.channel.era}"; moved to ${fit.date}`);
        this.moveCalendar({ date: fit.date, time: pend.arc.calendar.time || undefined, why: "the story's first date", by: "planner" });
      }
    }
    let bonds = 0;
    for (const b of resolveBonds(pend.bonds, (n) => this.characterByName(n)?.id)) if (applyBond(this.bonds, b, { by: "planner", now: this.now() })) bonds++;
    this.save();
    const main = this.mainWindow();
    if (p.notedVersion < pend.arc.version) {
      p.notedVersion = pend.arc.version; this.save();
      if (main) await this.post(main.id, { content: `${renderPlanNote(pend.arc, p.impulses)}${bonds && !pend.between ? ` Relationships: ${bonds} change(s).` : ""}`, kind: "narration", visibility: "gm_only" }, { count: false });
    }
    if (pend.between) await this.applyBetween(pend, bonds);
    if (this.calendarOn()) this.applyRoutine(pend.arc.calendar);
    await this.applyTableNotes(pend);
  }

  // The planner's table notes (the players' standing wishes and corrections), and its answer in the planner window.
  async applyTableNotes(pend) {
    const p = this.planner;
    const merged = mergeTableNotes(p.table, pend.tableNotes, { nextId: p.nextNoteId, now: this.now() });
    p.table = merged.notes; p.nextNoteId = merged.nextId;
    if (merged.changed) { this.log(`planner: ${merged.changed} change(s) to the players' wishes and corrections`); this.save(); }
    if (!pend.answered || !p.window) return;
    const reply = plannerReply(pend.reply || "Noted.", [this.improv.secrets, ...this.improv.truths.map((t) => t.text), ...(pend.arc.threads ?? []).map((t) => t.twist)]);
    await this.post(p.window, { content: `🧭 ${reply}`, kind: "ooc" }, { count: false });
  }

  // The planner's routine for the current date (after a final review: for the date the next session resumes). It is
  // common knowledge, so one that quotes a secret or a hidden truth is dropped.
  applyRoutine(cal) {
    if (!cal?.routine) return;
    const secrets = [this.improv.secrets, ...this.improv.truths.map((t) => t.text)];
    if ([cal.routine, ...(cal.upcoming ?? []).map((u) => u.what)].some((t) => leaksSecret(t, secrets))) { this.log("planner: routine dropped (it quoted a secret)"); return; }
    setRoutine(this.calendar, { text: cal.routine, upcoming: cal.upcoming });
    this.save();
  }

  // The final review's result: the calendar moves on, off-screen developments go to the world record, and the first
  // turn of the next session is told how to open (betweenNote).
  async applyBetween(pend, bonds = 0) {
    const b = pend.between;
    const calendar = this.calendarOn() ? this.moveCalendar({ days: b.advanceDays, date: b.date || undefined, time: b.time, why: b.why || "between sessions", by: "final review" }) : null;
    let declared = 0, secret = 0;
    for (const o of b.offscreen ?? []) if (await this.declare(o.text, o.secret)) { declared++; if (o.secret) secret++; }
    let transition = calendar?.changed ? calendar.to : "";
    if (!calendar && b.time && !leaksSecret(b.time, [this.improv.secrets, ...this.improv.truths.map(t => t.text)])) transition = b.time;
    if (transition && b.time) this.timelines.relocate(MAIN, { narrativeTime: b.time });
    this.planner.between = { transition, days: calendar?.changed ? calendar.days : 0, today: calendar ? describeCalendar(this.calendar) : "", offscreen: b.offscreen ?? [], opening: b.opening, recap: b.recap, version: pend.arc.version, at: this.now() };
    this.planner.lastFinalAt = this.now();
    this.save();
    const main = this.mainWindow();
    if (main && pend.session) await this.post(main.id, { content: renderFinalNote({ session: pend.session, between: b, calendar, declared, secret, bonds }), kind: "narration", visibility: "gm_only" }, { count: false });
  }
  betweenNote() { return this.planner.between ? { ...this.planner.between } : null; }

  // ---- sessions and the final review
  // A player's line: the session goes on, or a new one begins.
  noteSession(m) {
    const fresh = !this.planner.session;
    const stale = noteSessionLine(this.planner, { at: Date.parse(m.created_at) || this.now(), seq: m.seq ?? this.lastSeq, idleMs: this.cfg.autonomyIdleMinutes * 60000 });
    if (stale && stale.lines >= (this.cfg.planner?.finalReviewMinLines ?? 10)) this.log("final review of the last session skipped: the players came back before it ran");
    if (fresh || stale) this.save();
  }

  // On the clock (every 10 s, autonomy or not): once nobody has written for the idle time, a session with enough play
  // gets its final review. Waits while a turn or a planner run is in progress.
  checkSessionEnd() {
    if (this.generation.paused) return null;
    const s = this.planner.session;
    const end = sessionEnded(s, { now: this.now(), idleMs: this.cfg.autonomyIdleMinutes * 60000, minLines: this.cfg.planner?.finalReviewMinLines ?? 10 });
    if (!end || this.pending > 0 || this.memory.jobs.has("planner")) return null;
    this.planner.session = null;
    this.save();
    if (end === "short") { this.log(`session over (${s.lines} player line(s)): too short for a final review`); return null; }
    return this.finalReview(s);
  }

  finalReview(session) {
    if (!this.cfg.planner || this.cfg.planner.finalReview === false || this.plannerMode() === "off") return null;
    if (this.overBudget()) { this.log("final review skipped: the daily token budget is spent"); return null; }
    this.log(`final review of the session (${session.lines} player lines)`);
    return this.runPlanner("final", { session });
  }

  // When `run` is stopped: the session in progress, if long enough, gets its final review first.
  async finishSession() {
    await this.memoryIdle();
    if (this.generation.paused) return false;
    const s = this.planner.session;
    if (!s || s.lines < (this.cfg.planner?.finalReviewMinLines ?? 10)) return false;
    this.planner.session = null;
    this.save();
    const job = this.finalReview(s);
    if (!job) return false;
    await job;
    await this.adoptPlan();
    return true;
  }

  // ---- the calendar and relationships
  // The Keeper keeps to the pace (config `calendar`); the final review has its own most days; the operator and the
  // planner's first date have neither.
  moveCalendar({ days, date, time, why = "", by = "keeper" }) {
    const pace = this.calendarPaceCfg();
    const limits = by === "final review" ? { maxDays: this.cfg.planner?.finalReviewMaxDays ?? 30 }
      : by === "keeper" ? { maxDays: pace.maxDays || MAX_ADVANCE_DAYS, pace: { minMinutes: pace.minMinutes, minLines: pace.minLines } } : {};
    const r = advanceCalendar(this.calendar, { days, date, time, why, by, seq: this.lastSeq, now: this.now(), ...limits });
    if (r.changed) { if (r.to) this.log(`calendar: ${r.from || "(no date)"} → ${r.to} (${by})${r.clipped ? `, ${r.days} of the ${r.clipped} day(s) asked` : ""}`); this.save(); }
    else if (r.refused) this.log(`calendar unchanged: ${r.refused}`);
    return r;
  }
  // The Keeper's date move that the pace held back or cut short: a note only the Keeper reads, so the story can follow
  // the date that stands.
  calendarHeld(windowId, r) {
    const text = r.pace ? `Calendar unchanged: ${r.refused}. Keep play within the current day (only the time of day moves).`
      : r.clipped ? `Calendar moved on ${r.days} day(s), not ${r.clipped}: at most ${r.days} at once. Tell the time that passed to match.` : "";
    return text ? this.post(windowId, { content: text, kind: "narration", visibility: "gm_only" }, { count: false }) : 0;
  }
  recordBond(a, by = "keeper") {
    const [x] = resolveBonds([a], (n) => this.characterByName(n)?.id);
    if (!x) { this.log(`bond skipped: no characters named "${a.a}" and "${a.b}"`); return null; }
    const r = applyBond(this.bonds, x, { by, now: this.now() });
    if (r) { this.log(`bond ${r}: ${this.nameOf(x.a)} — ${this.nameOf(x.b)}${x.kind ? `: ${x.kind}` : ""} (${by})`); this.save(); }
    return r;
  }

  // ---- casual mode: phones (casual.mjs)
  isPhone(windowId) { return Boolean(windowId) && Object.values(this.casual.phones).includes(windowId); }
  phoneOwner(windowId) { return Object.keys(this.casual.phones).find((id) => this.casual.phones[id] === windowId) ?? null; }
  // On, and allowed here: a phone is private only on an isolated channel with one player per group.
  casualOn() { return this.casual.on && !this.splitWarning; }

  async setCasual(on) {
    this.casual.on = Boolean(on);
    // A casual game keeps a date: with none yet, the next turn boundary asks the planner to choose the first one.
    if (this.casual.on && !this.calendar.date && this.planner.arc && this.plannerMode() !== "off") this.planner.asked = { why: "casual mode is on: choose the story's first date", at: this.now() };
    this.save();
    this.log(`casual mode ${this.casual.on ? "on" : "off"}${this.casual.on && this.splitWarning ? `, but not here: phones would not be private (${this.splitWarning})` : ""}`);
    if (this.casual.on) await this.ensureTableWindows();
  }

  // ---- the table's own windows: the planner window (wishes.mjs), the phones and the Keeper's phone log (casual.mjs)
  isPlannerWindow(windowId) { return Boolean(windowId) && windowId === this.planner.window; }
  // Windows that are no scene: no turn is played there and autonomy never moves them.
  isTableWindow(windowId) { return this.isPhone(windowId) || this.isPlannerWindow(windowId) || (Boolean(windowId) && windowId === this.casual.log); }
  plannerWindowWanted() { return this.cfg.planner?.wishWindow !== false && this.plannerMode() !== "off"; }

  async ensureTableWindows() {
    if (!this.ready || this.ensuringWindows) return;
    this.ensuringWindows = true;
    try {
      if (this.plannerWindowWanted()) await this.ensurePlannerWindow();
      if (this.casual.on) { await this.ensurePhones(); await this.ensurePhoneLog(); }
    } finally { this.ensuringWindows = false; }
  }

  // The planner window: every player of the channel in it (a newcomer is added), the Keeper reading.
  async ensurePlannerWindow() {
    const { rows } = await this.channelMemberRows();
    if (!rows) return;
    const players = rows.filter((r) => r.role === "player").map((r) => r.id ?? r.user_id).filter(Boolean);
    let w = this.windows.find((x) => x.id === this.planner.window);
    if (!w) {
      w = await this.api.createWindow(this.channelId, { name: WISH_WINDOW, kind: "private", members: players.map((user_id) => ({ user_id })) });
      this.planner.window = w.id;
      this.save();
      this.windows = [...this.windows, w];
      this.log(`planner window: opened "${w.name}"`);
      await this.post(w.id, { content: "🧭 This window is for the story planner, out of character. Tell it where you would like the story to go, or what went against your setting (\"Harriet would never leave a friend behind\", \"there is no magic in this world\"). It reads what you write here the next time it plans, answers here, and the Keeper keeps to it. No scene is played here. Send /pause to pause hosting until the next player message in the channel.", kind: "ooc" }, { count: false, allowPaused: true });
      return;
    }
    const seated = new Set((w.members ?? []).map((m) => m.user_id));
    for (const user_id of players.filter((u) => !seated.has(u))) {
      await this.api.addWindowMember(this.channelId, w.id, { user_id });
      this.log(`planner window: seated a new player (${rows.find((r) => (r.id ?? r.user_id) === user_id)?.display_name ?? user_id})`);
    }
  }

  // Casual mode: the Keeper's phone log, a window with only the Keeper in it, for texts no player is part of.
  async ensurePhoneLog() {
    if (!this.casualOn() || (this.casual.log && this.windows.some((w) => w.id === this.casual.log))) return;
    const w = await this.api.createWindow(this.channelId, { name: PHONE_LOG, kind: "private", members: [] });
    this.casual.log = w.id;
    this.save();
    this.windows = [...this.windows, w];
    this.log(`casual: opened "${w.name}"`);
    await this.post(w.id, { content: "📒 Texts between co-players and NPCs, for the Keeper only. Every line is one text: the sender, then → and the recipient.", kind: "narration" }, { count: false, allowPaused: true });
  }

  // A line in the planner window: kept for the planner's next run, whatever triggers it (no run of its own).
  onWishLine(m) {
    if (!this.isHuman(m) || m.visibility !== "window" || !String(m.content ?? "").trim()) return undefined;
    addToInbox(this.planner.inbox, { seq: m.seq, who: m.author_name || m.character_name || "a player", text: m.content, at: Date.parse(m.created_at) || this.now() });
    this.save();
    return undefined;
  }

  // New players join the current primary scene, which may now be a private fork.
  welcomeNewcomers(list) {
    const main = this.primaryWindowId();
    if (!main) return;
    for (const c of list) this.log(`new player: ${c.player_name ?? c.user_id} with ${c.name}`);
    this.schedule(main, { mode: "arrival", delay: this.cfg.debounceMs, arrival: { names: list.map((c) => c.name), ids: list.map(c => c.id), newcomer: true } });
  }

  // Every player character with a player gets a phone: a private window with only that player in it.
  async ensurePhones() {
    if (!this.casual.on || !this.ready || this.ensuringPhones) return;
    if (this.splitWarning) {
      if (!this.casualRefusedNoted) { this.casualRefusedNoted = true; this.log(`casual mode stays off on this channel: phones would not be private (${this.splitWarning}). Use an isolated channel with one player per group.`); }
      return;
    }
    this.ensuringPhones = true;
    try {
      const users = await this.channelUsers();
      for (const c of this.characters.filter((x) => this.isPc(x.id) && x.user_id && (!users || users.has(x.user_id)))) {
        const known = this.casual.phones[c.id];
        if (known && this.windows.some((w) => w.id === known)) continue;
        const w = await this.api.createWindow(this.channelId, { name: `${PHONE_PREFIX}${c.name}`.slice(0, 80), kind: "private", members: [{ user_id: c.user_id, character_id: c.id }] });
        this.casual.phones[c.id] = w.id;
        this.windows = [...this.windows, w];
        this.save();
        this.log(`casual: opened "${w.name}"`);
        await this.post(w.id, { content: `📱 ${c.name}'s phone. Text anyone in the story: start with @ and their name ("@Name …"). Without @, your message goes to whoever you texted last.`, kind: "narration" }, { count: false, allowPaused: true });
      }
    } catch (e) { this.log(`phones: ${e.message}`); } finally { this.ensuringPhones = false; }
  }

  // A player's line in their own phone: a text message to someone.
  onPhoneLine(m) {
    if (!this.casualOn() || !this.isHuman(m) || m.visibility !== "window" || m.kind === "ooc" || !m.character_id) return undefined;
    const from = m.character_id;
    this.speakers.delete(m.chat_window_id);   // a text never moves anyone between scenes
    if (from !== this.phoneOwner(m.chat_window_id)) return undefined;
    const contacts = this.characters.filter((c) => c.id !== from && (this.isPc(c.id) || this.roster.isCoplayer(c.id) || this.roster.isNpc(c.id))).map((c) => ({ id: c.id, name: c.name }));
    const { to: named, body, addressed } = parseAddress(m.content, contacts);
    const to = named ?? (addressed ? null : this.casual.last[from] ?? null);
    if (!to || !body) {
      const hint = addressed ? "(No one by that name in your contacts. Write @ and their name: someone you have met in the story.)" : "(Who is this for? Start the message with @ and their name.)";
      this.post(m.chat_window_id, { content: hint, kind: "narration" }, { count: false }).catch(() => {});
      return undefined;
    }
    this.casual.last[from] = to;
    this.store.addPhone({ seq: m.seq, windowId: m.chat_window_id, from, to, text: body, at: this.now() });
    // A newer message supersedes a reply still on its way from that contact.
    this.casual.pending = this.casual.pending.filter((p) => !(p.from === to && p.to === from));
    this.save();
    if (this.isPc(to)) return this.relayText(from, to, body);
    return this.schedule(m.chat_window_id, { mode: "phone", phone: { fromId: from, toId: to } });
  }

  // Player to player: the message appears at once in the recipient's phone, as the sender's character.
  async relayText(from, to, text) {
    const w = this.casual.phones[to];
    if (!w) { await this.post(this.casual.phones[from], { content: `(${this.nameOf(to)} has no phone yet.)`, kind: "narration" }, { count: false }); return 0; }
    this.casual.last[to] = from;
    this.save();
    return this.post(w, { content: text, kind: "ic", character_id: from }, { count: false });
  }

  // An NPC or a co-player reads a text and answers, after a believable delay, or leaves it unanswered.
  async phoneTurn(windowId, { fromId, toId }) {
    if (!this.casualOn() || !fromId || !toId) return;
    const thread = renderThread(this.store.thread(fromId, toId, 30), (id) => this.nameOf(id));
    const max = this.cfg.casualMaxDelayMinutes ?? 240;
    const cp = this.roster.coplayers.find((c) => c.characterId === toId);
    if (cp) {
      const memories = this.memory.coplayerChapters(cp).map((c) => `[#${c.fromSeq}–#${c.toSeq}] ${c.text}`);
      const today = this.calendarOn() ? describeCalendar(this.calendar, { time: this.timelines.of(toId)?.narrativeTime || this.calendar.time }) : "";
      const known = new Set([...investigatorsFor(this.characters, this.roster).map((c) => c.id), fromId]);
      const card = await this.card(toId);
      const tableInfo = this.pbta
        ? [JSON.stringify(playerRules(this.pbta.pack, card?.pbta?.book))]
        : [today ? `TODAY IN THE STORY: ${today}` : "", today && describeRoutine(this.calendar) ? `${describeRoutine(this.calendar)} (common knowledge)` : "", renderBondsFor(this.bonds, toId, known, (id) => this.nameOf(id)), renderCorrectionsFor(this.planner.table, cp.name)];
      const self = [coplayerSelf({ coplayer: cp, card, world: this.improv.on ? this.improv.world : "", profile: this.profile, attrs: this.attrs.get(toId) ?? {} }), memories.length ? `WHAT YOU REMEMBER:\n${memories.join("\n\n")}` : "", ...tableInfo].filter(Boolean).join("\n\n");
      let r;
      try { r = await coplayerPhoneReply(this.llm, { language: this.language, self: [self, renderImpulse(this.impulseFor(toId))].filter(Boolean).join("\n\n"), name: cp.name, from: this.nameOf(fromId), thread, maxDelay: max, pc: this.profile.vocab.pc }); }
      catch (e) { this.log(`co-player ${cp.name} (phone): ${e.message}`); return; }
      if (r.reply) this.queueText({ windowId, from: toId, to: fromId, text: r.reply, minutes: r.delay });
      else this.log(`casual: ${cp.name} leaves ${this.nameOf(fromId)}'s message on read`);
    } else {
      const ctx = await this.buildGm(windowId);
      const last = this.store.thread(fromId, toId, 1).at(-1);
      let plan;
      try { plan = await directTurn(this.llm, { language: this.language, profile: this.profile, context: ctx.parts, pbta:this.pbta, newest: null, mode: "phone", auto: this.cfg.timelineAuto, improv: this.improv.on, casual: true, phone: { from: this.nameOf(fromId), to: this.nameOf(toId), thread, text: last?.text ?? "" } }); }
      catch (e) { this.log(`phone turn: ${e.message}`); return; }
      // Only messages and the Keeper's own notes: nothing happens in a scene because of a text.
      for (const a of plan.actions.filter((x) => ["text", "note", "truth", "world_change"].includes(x.type))) {
        if (a.type === "note") await this.post(this.mainWindow().id, { content: a.text, kind: "narration", visibility: "gm_only" }, { count: false });
        else await this.act(windowId, a, ctx, { mode: "phone", parent: "phone" });
      }
      if (!plan.actions.some((x) => x.type === "text")) this.log(`casual: ${this.nameOf(toId)} leaves ${this.nameOf(fromId)}'s message unanswered`);
    }
    await this.deliverDue();
  }

  // The GM's text action: a real NPC texts a player character, now or after a delay.
  async sendText(a) {
    const from = this.characterByName(a.from);
    const to = this.characterByName(a.to);
    if (!from || !this.roster.isNpc(from.id)) { this.log(`text from "${a.from}" skipped: the Keeper texts only as a real NPC`); return 0; }
    if (to && this.roster.isCoplayer(to.id)) return this.aiText(from.id, to.id, a.text, a.delay_minutes);   // to a co-player: the phone log
    if (!to || !this.isPc(to.id) || !this.casual.phones[to.id]) { this.log(`text to "${a.to}" skipped: not a player character with a phone`); return 0; }
    this.queueText({ windowId: this.casual.phones[to.id], from: from.id, to: to.id, text: a.text, minutes: a.delay_minutes });
    await this.deliverDue();
    return 0;
  }

  // A text no player character is part of (co-player or NPC to co-player or NPC): it goes to the phone log.
  async aiText(from, to, text, minutes = 0) {
    if (!this.casualOn() || !this.casual.log || !String(text ?? "").trim() || from === to) return 0;
    this.queueText({ windowId: this.casual.log, from, to, text, minutes });
    await this.deliverDue();
    return 0;
  }
  // A text delivered to an AI character in the phone log: it answers, unless the two have gone back and forth
  // CASUAL_AI_CHAIN times since a person last wrote, the hourly cap is reached, or everyone is away.
  answerAiText(p) {
    const key = pairKey(p.from, p.to);
    const chain = (this.casual.chain[key] ?? 0) + 1;
    this.casual.chain[key] = chain;
    const now = this.now();
    this.casual.aiTexts = this.casual.aiTexts.filter((t) => now - t < HOUR);
    const away = now - this.lastHumanAt > this.cfg.autonomyIdleMinutes * 60000;
    const why = chain >= (this.cfg.casualAiChain ?? 4) ? "the exchange is long enough until someone writes" : this.casual.aiTexts.length >= (this.cfg.casualAiTextsPerHour ?? 12) ? "the hourly cap on texts between AI characters" : away ? "everyone is away" : this.overBudget() ? "the daily token budget" : "";
    if (why) { this.log(`casual: ${this.nameOf(p.to)} does not answer ${this.nameOf(p.from)} now (${why})`); return; }
    this.casual.aiTexts.push(now);
    this.enqueuePhone(this.casual.log, { fromId: p.from, toId: p.to });
  }
  // A phone turn on the turn queue without a window timer (the phone log carries several conversations at once).
  enqueuePhone(windowId, phone) {
    if (this.generation.signal.aborted) return;
    this.pending++;
    this.queue = this.queue.then(this.generation.task(() => this.phoneTurn(windowId, phone))).catch((e) => this.log(`phone turn failed: ${e.message}`)).then(() => { this.pending--; });
    return this.queue;
  }

  queueText({ windowId, from, to, text, minutes = 0 }) {
    if (this.generation.signal.aborted) return;
    const at = dueAt(this.now(), minutes, this.cfg.casualMaxDelayMinutes ?? 240);
    this.casual.pending.push({ windowId, from, to, text: String(text).slice(0, 2000), dueAt: at });
    this.save();
    if (at > this.now()) this.log(`casual: ${this.nameOf(from)} → ${this.nameOf(to)} in ${Math.round((at - this.now()) / 60000)} min`);
  }

  // Delivers every text whose time has come: it appears in the recipient's phone as the sender's character.
  async deliverDue() {
    if (!this.casual.on || !this.casual.pending.length) return 0;
    const now = this.now();
    const due = this.casual.pending.filter((p) => p.dueAt <= now);
    if (!due.length) return 0;
    this.casual.pending = this.casual.pending.filter((p) => p.dueAt > now);
    this.save();
    for (const p of due) {
      const logged = p.windowId === this.casual.log;
      const signal = this.generation.signal;
      await this.post(p.windowId, { content: logged ? `→ ${this.nameOf(p.to)}: ${p.text}` : p.text, kind: "ic", character_id: p.from }, { count: false, allowPaused: true });
      this.store.addPhone({ windowId: p.windowId, from: p.from, to: p.to, text: p.text, at: now });
      this.casual.last[p.to] = p.from;   // a reply without @ goes back to whoever texted last
      if (logged && !signal.aborted) this.answerAiText(p);
    }
    this.save();
    return due.length;
  }

  // ---- the platform's living world record
  // Declares a change to the world (off-screen, or a hidden truth) for the platform's observer to record. Best effort:
  // a platform without the world record (404) is noted once and the table carries on with its own notes.
  async declare(text, secret = false) {
    const t = String(text ?? "").trim();
    if (!t || this.worldUnsupported) return false;
    try {
      for (const part of chunk(t, 3900)) await this.api.declareWorld(this.channelId, { text: part, secret });
      this.log(`world ${secret ? "secret " : ""}declared: ${t.slice(0, 100)}`);
      return true;
    } catch (e) {
      if (e.status === 404 || e.status === 405) { this.worldUnsupported = true; this.log("this platform keeps no world record; world changes stay in the Keeper's notes"); }
      else this.log(`world declaration failed: ${e.message}`);
      return false;
    }
  }

  // ---- improvisation mode
  // The posted world setting is left out of every chat context: the GM and the co-players get it as a section of its own.
  hiddenLines() { return new Set([...this.improv.published.ids, ...this.pauseLines]); }

  // `world` command (and `setup` while `run` is up): turns the mode on or off and replaces the setting texts.
  async setWorld({ on, world, secrets }) {
    if (on !== undefined) this.improv.on = Boolean(on);
    if (world !== undefined) this.improv.world = String(world);
    if (secrets !== undefined) this.improv.secrets = String(secrets);
    this.save();
    await this.publishWorld();
    await this.seedWorld();
    this.log(`improvisation ${this.improv.on ? "on" : "off"}: world ${this.improv.world.length} characters, secrets ${this.improv.secrets.length}, hidden truths ${this.improv.truths.length}`);
  }

  // Hands the world setting (public) and the Keeper's secrets (secret) to the platform's world record, once per version
  // of each text, so its observer knows the places, groups and people from the start.
  async seedWorld() {
    const im = this.improv;
    if (!im.on) return;
    im.declared ??= {};
    for (const [key, text, secret] of [["world", im.world, false], ["secrets", im.secrets, true]]) {
      if (!text || im.declared[key] === hashText(text)) continue;
      if (await this.declare(text, secret)) { im.declared[key] = hashText(text); this.save(); }
    }
  }

  // Posts the world setting in the Main Chat for the human players, once per version of the text.
  async publishWorld() {
    const { on, world, published } = this.improv;
    if (!on || !world || published.hash === hashText(world)) return 0;
    const main = this.mainWindow();
    if (!main) return 0;
    const ids = [];
    try {
      for (const content of worldMessages(world)) {
        const m = await this.api.postMessage(this.channelId, main.id, { content, kind: "narration", visibility: "window" });
        this.botMessageIds.add(m.id);
        this.noteLine(m);
        ids.push(m.id);
      }
    } catch (e) {
      this.log(`posting the world setting failed (${e.message}); it is posted again when run starts`);
      this.improv.published.ids.push(...ids);
      this.save();
      return 0;
    }
    this.improv.published = { hash: hashText(world), ids: [...published.ids, ...ids].slice(-100) };
    this.save();
    await this.seedWorld();
    this.log(`world setting posted in "${main.name}" (${ids.length} message${ids.length === 1 ? "" : "s"})`);
    return ids.length;
  }

  // ---- older, model-led timelines (TIMELINE_AUTO=false)
  coplayersNamed(list) { return names(list).map((n) => this.roster.coplayerByName(n)).filter(Boolean); }

  async legacySplit(fromWindowId, a) {
    const proposed = this.coplayersNamed(a.coplayers);
    const checked = await this.checkDestinations(fromWindowId, [{ who: proposed.map(c => c.name), thread: "NEW", place: a.location || a.name, ownScene: true, time: a.narrative_time || "", span: "short", opening: a.opening || "" }], new Set(proposed.map(c => c.characterId)), [], "side");
    const members = this.coplayersNamed(checked.reports[0]?.who || []);
    if (!members.length) { this.log(`split "${a.name}": no co-player named; skipped`); return 0; }
    const result = planWhereabouts({ timelines: this.timelines, scene: { timeline: this.scene(fromWindowId) },
      reports: checked.reports, scopeIds: new Set(members.map(c => c.characterId)), mode: "manual",
      resolve: n => this.investigatorByName(n), isPc: id => this.isPc(id), userOf: id => this.userOf(id), windowUsers: w => this.windowUsers(w),
      guard: this.guard, turn: this.guard.turn, now: this.now(), cfg: this.cfg });
    await this.applyPlan(result, { windowId: fromWindowId, mode: "manual", turn: this.guard.turn });
    return 0;
  }

  async legacyRejoin(a) {
    const t = this.timelines.byName(a.timeline);
    if (!t || t.id === MAIN || t.status !== "active") return 0;
    const targetWindow = a.into ? this.windows.find(w => norm(w.name) === norm(a.into) || w.id === a.into) : null;
    const target = this.scene(targetWindow?.id) ?? this.timelines.main();
    if (target === t) return 0;
    const companions = this.roster.coplayers.filter(c => t.members.includes(c.characterId));
    const checked = await this.checkDestinations(t.windowId, [{ who: companions.map(c => c.name), thread: "T" + target.handle }], new Set(companions.map(c => c.characterId)), [], "side");
    const result = planWhereabouts({ timelines: this.timelines, scene: { timeline: t }, reports: checked.reports,
      scopeIds: new Set(companions.map(c => c.characterId)), mode: "manual", resolve: n => this.investigatorByName(n),
      isPc: id => this.isPc(id), userOf: id => this.userOf(id), windowUsers: w => this.windowUsers(w),
      guard: this.guard, turn: this.guard.turn, now: this.now(), cfg: this.cfg });
    await this.applyPlan(result, { windowId: t.windowId, mode: "manual", turn: this.guard.turn });
    return 0;
  }

  // Time, place, span and notes of a timeline. (With TIMELINE_AUTO, membership changes only through whereabouts.)
  updateTimeline(a) {
    const t = this.timelines.byName(a.timeline) ?? this.timelines.main();
    const r = this.timelines.update(t.id, { narrativeTime: a.narrative_time, location: a.location, notes: a.notes, span: a.span });
    if (r) this.save();
    return 0;
  }

  // ---- autonomy
  startTicker() {
    // Pending phone replies arrive on their own clock, autonomy or not; the same clock notices a session's end.
    if (!this.phoneTimer) {
      this.phoneTimer = setInterval(() => {
        this.deliverDue().catch((e) => this.log(`phones: ${e.message}`));
        try { this.checkSessionEnd(); } catch (e) { this.log(`final review: ${e.message}`); }
        // The platform says nothing when a player creates a character: look again now and then.
        if (this.pending === 0 && this.now() - (this.lastRefreshAt ?? 0) > 60000) this.refresh().catch((e) => this.log(`refresh: ${e.message}`));
      }, 10000);
      if (this.phoneTimer.unref) this.phoneTimer.unref();
    }
    if (!this.cfg.autonomy || this.ticker) return;
    this.ticker = setInterval(() => { this.tick().catch((e) => this.log(`autonomy: ${e.message}`)); }, this.cfg.autonomyTickMs);
    if (this.ticker.unref) this.ticker.unref();
  }
  stopTicker() { clearInterval(this.ticker); this.ticker = null; clearInterval(this.phoneTimer); this.phoneTimer = null; }

  // Picks at most one window that should move on its own, and queues its turn.
  async tick() {
    if (this.generation.paused || !this.cfg.autonomy || this.pending > 0) return null;
    if (this.overBudget()) return null;
    const now = this.now();
    const idle = this.cfg.autonomyIdleMinutes * 60000;
    // Away: nobody at the table. Only co-players-only threads move, every AWAY_SIDE_INTERVAL_MS (0: not at all).
    const away = now - this.lastHumanAt > idle;
    if (away && !this.cfg.awaySideIntervalMs) return null;
    this.autonomousTurns = this.autonomousTurns.filter((t) => now - t < HOUR);
    if (this.autonomousTurns.length >= this.cfg.autonomyMaxTurnsPerHour) return null;
    const candidates = [];
    for (const w of this.windows) {
      if (w.archived_at || this.timelines.retired(w.id) || this.isTableWindow(w.id) || !this.scene(w.id)) continue;
      const st = this.state(w.id);
      const scene = this.scene(w.id);
      const isMain = w.id === this.primaryWindowId();
      const humans = this.presentPlayers(w.id).length > 0;
      const sinceLine = now - Math.max(st.lastLineAt, st.lastTurnAt);
      if (scene && !isMain && !humans && this.roster.coplayersIn(w.id).length) {
        if (sinceLine >= (away ? this.cfg.awaySideIntervalMs : this.cfg.autonomySideIntervalMs)) candidates.push({ w, mode: "side", waited: sinceLine, extra: { timeline: scene } });
      } else if (!away && humans && st.lastHumanAt && now - st.lastHumanAt <= idle && st.quietTurns < this.cfg.autonomyQuietTurns) {
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
    let saved;
    if (this.pbta) {
      saved = await this.api.createCharacter(this.channelId, { kind: "npc", name, description: brief || name });
    } else {
      const generated = await generateNpc(this.llm, { language: this.language, era: this.channel.era, rules: this.rules, name, brief, gmContext: gmContext.slice(-6000), profile: this.profile, pointsMode: Boolean(this.channel.point_buy), log: this.log });
      generated.name = name;
      generated.brief = brief || generated.persona;
      saved = await saveCharacter(this.api, this.channelId, generated, { kind: "npc", rules: this.rules, llm: this.llm, language: this.language, pointsMode: Boolean(this.channel.point_buy), profile: this.profile, level: 1 });
    }
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
  // Investigators only (player characters and co-players): exact name first, then a unique first name.
  investigatorByName(name) {
    const n = norm(name);
    const inv = investigatorsFor(this.characters, this.roster);
    const exact = inv.find((c) => norm(c.name) === n);
    if (exact) return exact.id;
    const first = inv.filter((c) => n && norm(c.name).split(/\s+/)[0] === n.split(/\s+/)[0]);
    return first.length === 1 ? first[0].id : null;
  }

  // A character's role card, and the sheet values the dice keep (`attrs`: live HP, slots), cached until the
  // platform says the character changed.
  async card(characterId) {
    if (!this.cards.has(characterId)) {
      const space = await this.api.characterSpace(this.channelId, characterId).catch(() => null);
      this.cards.set(characterId, space?.character?.role_card ?? null);
      this.attrs.set(characterId, space?.attrs && typeof space.attrs === "object" ? space.attrs : {});
    }
    return this.cards.get(characterId);
  }

  // A co-player's move, from its own witnessed chat (every window it sat in, during its seats) and its companions'
  // profiles. Nothing from the Keeper's side. Lines a player wrote while their character was in another scene are not
  // something this co-player witnessed, even in a window it sits in.
  async coplayerAct(windowId, coplayer, spotlight, { side = false } = {}) {
    const me = coplayer.characterId;
    const hidden = this.hiddenLines();
    // Everything this co-player witnessed (its seats, its timeline), from the local copy of the chat.
    const messages = [];
    for (const w of new Set(coplayer.seats.map((s) => s.windowId))) messages.push(...this.history.lines(w));
    const witnessed = coplayerLog(coplayer, messages.filter((m) => !hidden.has(m.id)), Infinity).filter((m) => !(m.character_id && this.isPc(m.character_id) && this.timelines.timelineAt(m.character_id, m.seq).id !== this.timelines.timelineAt(me, m.seq).id));
    // Since its last memory chapter, within its budget (compaction catches up beside the turn).
    const recallBudget = Math.min(this.cfg.recallTokens ?? 1200, Math.floor(this.memory.coplayerBudget * 0.05));
    let log = this.memory.coplayerRaw(coplayer, witnessed);
    while (log.length > CHUNK_LINES && estimateTokens(log.map((m) => this.renderForCoplayer(m)).join("\n")) > this.memory.coplayerBudget - recallBudget) log = log.slice(CHUNK_LINES);
    const included = new Set(log.map((m) => m.seq));
    const recalled = recall(witnessed.slice(-6).map((m) => m.content).join("\n"),
      witnessed.filter((m) => !included.has(m.seq)).map((m) => ({ match: m.content, text: this.renderForCoplayer(m), source: this.renderForCoplayer({ ...m, content: "", dice: null }) + " " })),
      recallBudget, { heading: "RELEVANT EARLIER LINES YOU WITNESSED" });
    const memories = this.memory.coplayerChapters(coplayer).map((c) => `[#${c.fromSeq}–#${c.toSeq}] ${c.text}`);
    const t = this.timelines.of(me);
    const timeline = t ? { name: t.name, narrativeTime: t.narrativeTime, location: t.location } : null;
    const card = await this.card(me);
    const pbta = this.pbta && playerRules(this.pbta.pack, card?.pbta?.book);
    let move;
    try {
      const companions = investigatorsFor(this.characters, this.roster, { except: me });
      const phone = this.casualOn() ? renderThread(this.store.phoneOf(me, 12), (id) => this.nameOf(id)) : "";
      const known = this.knownTo(me, witnessed);
      move = await coplayerTurn(this.llm, { language: this.language, coplayer, card, pbta, profile: this.profile, attrs: this.attrs.get(me) ?? {}, companions, withYou: this.cfg.timelineAuto ? t.members.filter((id) => id !== me) : null, log, memories, recalled, spotlight, timeline, side, world: this.improv.on ? this.improv.world : "", improv: this.improv.on, casual: this.casualOn(), phone, impulse: renderImpulse(this.impulseFor(me)),
        corrections: renderCorrectionsFor(this.planner.table, coplayer.name),
        ...(this.calendarOn() ? { today: describeCalendar(this.calendar, { time: t?.narrativeTime || this.calendar.time }), routine: describeRoutine(this.calendar), timePassed: this.timePassedFor(me, witnessed) } : {}), met: this.metBy(known.met), bonds: renderBondsFor(this.bonds, me, known.all, (id) => this.nameOf(id)) });
    } catch (e) { this.log(`co-player ${coplayer.name}: ${e.message}`); return 0; }
    this.memory.maintainCoplayer(coplayer, witnessed, (m) => this.renderForCoplayer(m));
    if (move.action === "text") {
      const to = this.characterByName(move.to);
      // To a companion co-player or an NPC: the phone log, where they answer in their own time.
      if (to && to.id !== me && (this.roster.isCoplayer(to.id) || this.roster.isNpc(to.id))) return this.aiText(me, to.id, move.text);
      // To a player character: it arrives in their phone at once.
      if (!to || !this.isPc(to.id) || !this.casual.phones[to.id]) return 0;
      this.store.addPhone({ windowId: this.casual.phones[to.id], from: me, to: to.id, text: move.text, at: this.now() });
      this.casual.last[to.id] = me;
      this.save();
      return this.post(this.casual.phones[to.id], { content: move.text, kind: "ic", character_id: me }, { count: false });
    }
    if (move.action === "speak") return this.post(windowId, { content: move.text, kind: move.kind, character_id: me });
    if (move.action === "roll" && this.pbta) {
      const [, moveId, modifier] = move.command.split(" ");
      if (/^[.。]/.test(move.text.trim())) return 0;
      const cue = witnessed.findLast(m => m.chat_window_id === windowId && m.visibility === "window" && m.character_id !== me);
      if (!cue) return this.post(windowId, { content: move.text, kind: "ic", character_id: me });
      const intent = await this.api.pbtaRuling(this.channelId, windowId, {
        op: "declare", source_id: cue.id, text: move.text, character_id: me,
        move_id: moveId, modifier: Number(modifier ?? 0), revision: this.pbta.revision,
      });
      this.noteLine(intent);
      // A retry must finish the originally declared move, even if the model now suggests another.
      const result = await this.api.pbtaRuling(this.channelId, windowId, {
        op: "move", character_id: me, source_id: intent.id, ...intent.declared_move,
      });
      this.noteLine(result);
      return 2;
    }
    if (move.action === "roll") {
      let n = 0;
      if (move.text) n += await this.post(windowId, { content: move.text, kind: "ic", character_id: me });
      return n + (await this.post(windowId, { content: move.command, kind: "ic", character_id: me }));
    }
    return 0;
  }

  // Who a co-player knows: every investigator, and the real NPCs it has seen speak in its own scenes (newest last).
  knownTo(me, witnessed) {
    const npcs = new Set(this.roster.npcs.map((n) => n.characterId));
    const met = [...new Set(witnessed.filter((m) => m.character_id && npcs.has(m.character_id)).map((m) => m.character_id).reverse())].reverse().slice(-12);
    return { met, all: new Set([...investigatorsFor(this.characters, this.roster).map((c) => c.id), ...met]) };
  }
  // What anyone would notice about the NPCs a co-player has met: gender, age, striking traits; never the Keeper's brief.
  metBy(ids) {
    const lines = ids.map((id) => { const c = this.characters.find((x) => x.id === id); return c ? `- ${c.name}${impression(c.role_card) ? ` ${impression(c.role_card)}` : ""}` : ""; }).filter(Boolean);
    return lines.length ? `PEOPLE YOU HAVE MET (what anyone would notice about them):\n${lines.join("\n")}` : "";
  }
  // The calendar moved on since this co-player last spoke: it lived through that time too.
  timePassedFor(me, witnessed) {
    const own = witnessed.filter((m) => m.character_id === me).at(-1);
    if (!own) return "";
    const changes = this.calendar.log.filter((e) => e.seq >= own.seq && e.days > 0);
    if (!changes.length) return "";
    const days = changes.reduce((n, e) => n + e.days, 0);
    return `TIME HAS PASSED since you last spoke: ${days} day(s), ${changes[0].from || "(no date)"} → ${changes.at(-1).to}.`;
  }

  // `count: false` marks bookkeeping lines (pointers, notes) that do not use up the turn's action budget.
  async post(windowId, body, { count = true, allowPaused = false } = {}) {
    if (!allowPaused && this.generation.signal.aborted) return 0;
    if (this.pbta && /^[.。][a-z]/i.test(String(body.content).trim())) return 0;
    try {
      const m = await this.api.postMessage(this.channelId, windowId, { visibility: "window", ...body });
      this.botMessageIds.add(m.id);
      if (this.botMessageIds.size > 2000) this.botMessageIds.delete(this.botMessageIds.values().next().value);
      this.noteLine(m);
      if (this.cfg.verbose) this.log(`posted ${body.kind}${body.visibility && body.visibility !== "window" ? `/${body.visibility}` : ""} in "${this.windowName(windowId)}": ${body.content.slice(0, 100)}`);
      if (count) await this.sleep(this.cfg.postDelayMs);
      return count ? 1 : 0;
    } catch (e) {
      this.log(`post failed (${e.code || e.status}): ${e.message}`);
      return 0;
    }
  }
}
