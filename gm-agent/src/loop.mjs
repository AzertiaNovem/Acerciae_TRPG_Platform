// The table loop. A line from a real person starts a turn (after a short quiet period): first the GM and the real
// NPCs act with the GM's context, then the co-players seated in that window act, each with only its own chat log,
// and the GM answers their moves at once in a follow-up round. Lines this client posts never start a turn by
// themselves, so it cannot talk to itself without bound.
//
// Proactive timelines (TIMELINE_AUTO): each GM round may report where investigators are (whereabouts.mjs). The
// table then splits them into threads of their own — a window for the place, with the players who went and the GM —
// and reunites them in the Main Chat when they are together again. Every new or changed scene gets an arrival turn
// at once. A player who keeps writing in the old window is answered in their own scene (relay).
//
// The table does not always wait for a human. On its own clock (tick) it also runs:
//   side   – a co-players-only window bound to a side timeline: its thread moves on, turn after turn;
//   quiet  – a window with human players that has been silent for a while: the scene moves on a little without
//            deciding anything for a player character, at most AUTONOMY_QUIET_TURNS times until a human posts again.
//            A human writing in the window (the platform's typing flag) holds its quiet turns: the story does not
//            move on while they compose their line, and their stopping starts the silence over.
// Autonomy pauses when no human has posted in the channel for AUTONOMY_IDLE_MINUTES, and is capped per hour.
//
// The GM may also open the next scenario (campaign-wide), only from the Main Chat, never while a short split is
// active, and not before SCENARIO_MIN_MINUTES and SCENARIO_MIN_LINES.
import { GmContext, duration } from "./context/gmContext.mjs";
import { sceneForks } from "./sceneForks.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { drawable } from "./plotArt.mjs";
import { RECALL_ROLLBACK_LINES } from "./rollback.mjs";
import { Store } from "./store.mjs";
import { History, Memory } from "./memory.mjs";
import { Generation } from "./generation.mjs";
import { metered } from "./llm/parts.mjs";
import { usageSink } from "./usage.mjs";
import { recall } from "./context/recall.mjs";
import { investigatorsFor } from "./context/profiles.mjs";
import { directTurn } from "./director.mjs";
import { awaitingReview } from "./pbta.mjs";
import { Timelines, MAIN, placeKey } from "./timelines.mjs";
import { Guard, planWhereabouts, whereaboutsBrief } from "./whereabouts.mjs";
import { improvState } from "./improv.mjs";
import { casualState } from "./casual.mjs";
import { plannerState } from "./planner.mjs";
import { calendarState } from "./calendar.mjs";
import { bondsState } from "./bonds.mjs";
import { rulesProfile, ruleSystemOf } from "./rules/index.mjs";

// A typing flag the platform never lowered holds a window this long at most. The server lets one fall 10 s after the
// writer's last heartbeat and a reconnect brings a fresh snapshot, so this only matters when that event was lost; it
// is long enough that nobody composing a long paragraph is cut off.
const TYPING_STALE_MS = 10 * 60000;
import * as daily from "./table/daily.mjs";
import * as context from "./table/context.mjs";
import * as recovery from "./table/recovery.mjs";
import * as scheduling from "./table/scheduling.mjs";
import * as windows from "./table/windows.mjs";
import * as actions from "./table/actions.mjs";
import * as art from "./table/art.mjs";
import * as planning from "./table/planning.mjs";
import * as social from "./table/social.mjs";
import * as coplayers from "./table/coplayers.mjs";
import { attentionCandidates, attentionBrief, attentionChoice, noteAttention } from "./table/attention.mjs";
import { languageName, MOVE_MODES, norm, names } from "./table/shared.mjs";
export { languageName } from "./table/shared.mjs";

export class Table {
  // `deferArrivals`: a short-lived CLI process records arrivals in the state file for the `run` process to play.
  constructor({ api, llm, cfg, channelId, roster, timelines, guard, store = null, scenario = null, improv = null, casual = null, planner = null, plannerLlm = null, calendar = null, daily: dailyData = null, bonds = null, journal = null, owedArrivals = [], deferArrivals = false, persist = () => {}, log = () => {}, sleep, now = Date.now, random = Math.random }) {
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
    this.startedAt = now();
    this.random = random;
    this.daily = daily.dailyState(dailyData, 0);
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
    // Recall rollback (rollback.mjs): each turn's checkpoint, the turn a post belongs to, and the copies a player's
    // text left in another player's phone.
    this.checkpoints = [];
    this.turnScope = new AsyncLocalStorage();
    this.phoneCopies = new Map();
    this.recallEmptied = new Set();
    // Illustrations (illustrations.mjs): the GM's in-play requests of the last hour, the scenario pictures waiting
    // their turn (the platform draws one picture at a time per account), and why the platform cannot draw, if it can't.
    this.illustrationTimes = [];
    this.illustrationQueue = [];
    this.illustrationRunning = false;
    this.illustrationOff = null;
    this.draining = null;
    // Small events (the GM's event_done): where the current one began in each window; the pictures chosen this run
    // (each choice is told what the scenario already has); and the choices, made one at a time in that order.
    this.eventMarks = new Map();
    this.pictureLog = [];
    this.pictureChain = Promise.resolve();
    // The platform's two switches (the server's feature, the GM's channel switch), followed live; both start on.
    this.illustrationSwitches = { server: true, channel: true };
    // Pictures of past plots asked for in the planner window (plotArt.mjs): the command lines and the table's replies
    // (kept out of every context), the requests handled, and each player's requests in flight and of the last hour.
    this.artLines = new Set();
    this.artHandled = new Set();
    this.artBusy = new Set();
    this.artTimes = new Map();
    this.artSignal = new AbortController().signal;   // a player's picture is not play: /pause does not cancel it
    this.timers = new Map();
    this.queue = Promise.resolve();
    this.pending = 0;          // turns waiting or running
    this.cards = new Map();
    this.outfitCache = new Map();   // character → their outfits with attire, for pictures (table/art.mjs)
    this.attrs = new Map();
    this.turns = 0;
    this.lastSeq = 0;          // newest line seen in the channel
    this.windowSeq = new Map();      // windowId → newest line seen there (seat cut points)
    this.speakers = new Map();       // windowId → [{id, seq, content}] player lines since that window's last turn
    // Autonomy bookkeeping: when humans last spoke (channel and per window), when each window last got a turn.
    this.lastHumanAt = 0;
    this.windowState = new Map();   // windowId → {lastLineAt, lastHumanAt, lastTurnAt, lastTypingAt, quietTurns}
    // The platform's typing flags (typing.changed / typing.snapshot on the chat socket), by character.
    this.typing = new Map();        // characterId → {windowId, since}
    this.autonomousTurns = [];      // timestamps of the last hour's autonomous turns
    this.lastLineBy = new Map();    // player character id → when its player last wrote
    this.returning = new Map();     // player character id → how long its player had been away (until the next turn)
    this.arrivalTimes = [];         // timestamps of the last hour's arrival turns
    this.ticker = null;
    this.refreshGen = 0;
    this.refreshing = null;
    this.memberCache = null;
  }

  async init({ heal = false, dailyStart = true } = {}) {
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
    this.illustrationSwitches = { server: settings?.features?.illustrations !== false, channel: this.channel.illustrations_enabled !== false };
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
    if (dailyStart) await this.initDaily();
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
      // Without scene forks, the windows it already opened are reused.
      if (!this.forks) for (const c of j.created ?? []) if (c.placeKey !== undefined) this.guard.spare.push(c);
      // One-time recovery of pre-fork agent journals: retain windows already created by that version.
      if (this.forks) for (const op of j.ops) if (op.op === "split" && !op.requestId) {
        const users = op.ids.filter(id => this.isPc(id)).map(id => this.userOf(id)).sort();
        const old = j.created?.find(c => c.placeKey === placeKey(op.place) && JSON.stringify([...(c.users ?? [])].sort()) === JSON.stringify(users));
        if (old && this.windows.some(w => w.id === old.windowId)) op.legacyWindowId = old.windowId;
      }
      await this.applyPlan({ ops: j.ops, changed: j.changed ?? [], ignored: [], guard: {}, prevOf: () => null }, { windowId: j.windowId, mode: ["correction", "presence"].includes(j.mode) ? j.mode : "manual", correctionSeq: j.correctionSeq, turn: this.guard.turn, quiet: true, opId: j.opId });
    } else if (this.journal) {
      await this.applyAudience(this.journal.audience ?? []);
      this.journal = null; changed = true;
    }
    // Scene forks turned off: a primary story still played in its own fork comes back to the Main Chat once nobody
    // is split off (while the party is split it stays where it is, so nobody's scene moves under them).
    const main = this.timelines.main();
    if (!this.forks && main.windowId && !this.timelines.active().some(t => t.id !== MAIN && t.members.length)) {
      this.timelines.bind(MAIN, null);
      this.log("scene forks are off: the main story is played in the Main Chat again");
      this.checkInvariants();                                  // its co-players' seats follow it
      changed = true;
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
    this.illustrationSwitches.channel = channel.illustrations_enabled !== false;
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

  budgetPressure(...args) { return scheduling.budgetPressure(this, ...args); }
  sparkTick(...args) { return daily.sparkTick(this, ...args); }
  sparkCancelled(...args) { return daily.sparkCancelled(this, ...args); }
  sparkNote(...args) { return daily.sparkNote(this, ...args); }
  finishSpark(...args) { return daily.finishSpark(this, ...args); }
  isPassive(...args) { return daily.isPassive(this, ...args); }
  setPassiveMark(...args) { return daily.setPassiveMark(this, ...args); }
  reconcilePassive(...args) { return daily.reconcilePassive(this, ...args); }
  passiveNote(...args) { return daily.passiveNote(this, ...args); }
  onAwayCommand(...args) { return daily.onAwayCommand(this, ...args); }
  standinAct(...args) { return daily.standinAct(this, ...args); }
  standinReplies(...args) { return daily.standinReplies(this, ...args); }
  dayTurn(...args) { return daily.dayTurn(this, ...args); }
  flushDayTurns(...args) { return daily.flushDayTurns(this, ...args); }
  dailyOn(...args) { return daily.dailyOn(this, ...args); }
  dailyMode(...args) { return daily.dailyMode(this, ...args); }
  noteDailyLine(...args) { return daily.noteDailyLine(this, ...args); }
  initDaily(...args) { return daily.initDaily(this, ...args); }
  clockTick(...args) { return daily.clockTick(this, ...args); }
  beforeDailyMessage(...args) { return daily.beforeDailyMessage(this, ...args); }
  readClock(...args) { return daily.readClock(this, ...args); }
  dailyStatus(...args) { return daily.dailyStatus(this, ...args); }

  mainWindow(...args) { return context.mainWindow(this, ...args); }
  windowName(...args) { return context.windowName(this, ...args); }
  nameOf(...args) { return context.nameOf(this, ...args); }
  // A player character, played by a real person (a GM-cast PC is a co-player).
  isPc(...args) { return context.isPc(this, ...args); }
  userOf(...args) { return context.userOf(this, ...args); }
  // After the first split even the primary story has a private window; Main Chat becomes the lobby.
  scene(...args) { return context.scene(this, ...args); }
  // Where a timeline is played.
  windowOf(...args) { return context.windowOf(this, ...args); }
  primaryWindowId(...args) { return context.primaryWindowId(this, ...args); }
  sceneHistory(...args) { return context.sceneHistory(this, ...args); }
  // Scene forks (timelines.scene_forks): after the first split the primary story moves to a restricted fork and the
  // Main Chat becomes a public lobby the GM never narrates in. Off (the default), the main story stays in the Main
  // Chat with the players, and only those who go elsewhere get a window of their own.
  get forks() { return Boolean(this.cfg.sceneForks); }
  partitionPlan(...args) { return windows.partitionPlan(this, ...args); }
  archiveRetired(...args) { return windows.archiveRetired(this, ...args); }
  windowUsers(...args) { return windows.windowUsers(this, ...args); }

  applyAudience(...args) { return windows.applyAudience(this, ...args); }

  state(...args) { return context.state(this, ...args); }
  isHuman(...args) { return context.isHuman(this, ...args); }
  noteSeq(...args) { return context.noteSeq(this, ...args); }

  // On start: when humans last spoke, from the newest lines of every window (so a restart does not wake a dead table).
  // Brings the local copy of every window up to date (a first backfill, or the gap since the table last ran) and notes
  // the newest lines for pacing.
  observeHistory(...args) { return context.observeHistory(this, ...args); }

  // The story keeps a date only in a casual game; a solemn game has none (calendar.mjs).
  calendarOn(...args) { return context.calendarOn(this, ...args); }
  // The GM's pace on the calendar (config `calendar`; 0: no limit).
  calendarPaceCfg(...args) { return context.calendarPaceCfg(this, ...args); }

  // The GM's context for a turn in `windowId` (gmContext.mjs), with the calendar (casual games) and the relationships.
  buildGm(...args) { return context.buildGm(this, ...args); }

  // How the GM reads a line: visibility and the timeline it comes from (see gmContext.mjs).
  renderForGm(...args) { return context.renderForGm(this, ...args); }
  // How a co-player reads a line (its own view, no visibility marks).
  renderForCoplayer(...args) { return context.renderForCoplayer(this, ...args); }

  // D&D: a window's Initiative order from the platform, kept until the next initiative.changed event.
  initiativeOf(...args) { return context.initiativeOf(this, ...args); }

  // How long a player character's player has been away, or null while they are around (AUTONOMY_IDLE_MINUTES).
  awayOf(...args) { return context.awayOf(this, ...args); }

  // Waits for background compaction (tests, shutdown).
  memoryIdle(...args) { return context.memoryIdle(this, ...args); }

  noteLine(...args) { return recovery.noteLine(this, ...args); }

  // A running `run` process reloads its roster and timelines when the state file is changed by a CLI command; it is
  // queued like a turn, so it never lands in the middle of one.
  reload(...args) { return recovery.reload(this, ...args); }

  save(...args) { return recovery.save(this, ...args); }

  // ---- events
  onEvent(...args) { return recovery.onEvent(this, ...args); }

  // The author took a line back: its tombstone replaces it in the history, so no prompt quotes it again. A player's
  // recall that is still recent (fewer than RECALL_ROLLBACK_LINES lines after it in its window) also rolls back what
  // the table did about it (rollback.mjs); an older one only leaves the context.
  onRecalled(...args) { return recovery.onRecalled(this, ...args); }

  // A turn waiting for its quiet moment that is no longer wanted.
  cancelTimer(...args) { return scheduling.cancelTimer(this, ...args); }

  // What a rollback can restore, as JSON (compared to tell whether anything else changed it since).
  slices(...args) { return recovery.slices(this, ...args); }

  openCheckpoint(...args) { return recovery.openCheckpoint(this, ...args); }
  closeCheckpoint(...args) { return recovery.closeCheckpoint(this, ...args); }

  // Rolls back the checkpoints `undo` after a recall of `m`: recalls what they posted (and this client's later lines in
  // that window, and the copies of a recalled text), restores the state they changed, answers the players' other
  // lines again, and leaves the GM a note of what stays.
  rollback(...args) { return recovery.rollback(this, ...args); }

  isTrigger(...args) { return scheduling.isTrigger(this, ...args); }

  playerSpeech(...args) { return scheduling.playerSpeech(this, ...args); }

  pauseCommand(...args) { return scheduling.pauseCommand(this, ...args); }

  updatePause(...args) { return scheduling.updatePause(this, ...args); }

  // Returns the scheduled turn (settled when it ran), or undefined when the line starts no turn.
  onMessage(...args) { return scheduling.onMessage(this, ...args); }

  // Waits for a quiet moment in the window, then queues one turn (turns run one at a time). A line arriving before the
  // turn starts restarts the wait; every caller's promise settles when that one turn has run. A human line outranks
  // an autonomous turn; an arrival rides along with whatever turn is pending and never shortens a human's wait.
  schedule(...args) { return scheduling.schedule(this, ...args); }

  // ---- one turn
  // Every turn keeps a checkpoint (rollback.mjs): the state it started from, the lines it answers and what it posts, so
  // a recall can undo it. It runs under its own abort signal, so a recall can stop it midway.
  async turn(windowId, opts = {}) {
    const parent = this.turnScope.getStore() ?? null;     // the turn that scheduled this one, if any
    const cp = this.openCheckpoint(windowId, opts.mode ?? "human");
    cp.parent = parent;
    cp.standinActed = new Set();
    cp.gentle = Boolean(opts.gentle ?? (!["human", "relay"].includes(opts.mode ?? "human") && parent?.gentle));
    if (cp.gentle) {
      cp.dailyEpoch = opts.dailyEpoch ?? parent?.dailyEpoch ?? this.dailyInterrupt ?? 0;
      const allowance = this.budgetPressure() === "tight" ? Math.max(2, Math.floor(this.cfg.daily.spark_max_lines / 2)) : this.cfg.daily.spark_max_lines;
      cp.dailyBudget = parent?.gentle ? parent.dailyBudget : { limit: Math.min(this.cfg.maxActionsPerTurn, allowance), posted: 0 };
    }
    if (opts.mode === "spark") {
      cp.dailyEpoch = opts.dailyEpoch ?? this.dailyInterrupt ?? 0;
      cp.lineLimit = this.budgetPressure() === "tight" ? Math.max(2, Math.floor(this.cfg.daily.spark_max_lines / 2)) : this.cfg.daily.spark_max_lines;
      cp.dailyPosted = 0;
    }
    const signal = AbortSignal.any([this.generation.signal, cp.abort.signal]);
    try { return await this.turnScope.run(cp, () => this.generation.tasks.run(signal, async () => {
      const result = await this.playTurn(windowId, opts);
      if (opts.mode === "attention" && cp.gentle && !this.sparkCancelled()) await this.finishSpark(windowId, { state: "ended" }, false);
      return result;
    })); }
    finally { await this.flushDayTurns(); this.closeCheckpoint(cp); }
  }

  async playTurn(windowId, { kickoff = false, mode = "human", ...extra } = {}) {
    if (this.generation.signal.aborted || this.sparkCancelled()) return;
    const gentle = Boolean(this.turnScope.getStore()?.gentle);
    if (gentle && (this.overBudget() || this.turnScope.getStore().dailyBudget.posted >= this.turnScope.getStore().dailyBudget.limit)) return;
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
    if (mode === "quiet" || mode === "side" || mode === "attention" || (mode === "arrival" && extra.autonomous)) this.autonomousTurns.push(this.now());
    // Players' lines are taken only by the turns that can act on them; an arrival, quiet or side turn running first
    // leaves them for the human turn that follows.
    const takesLines = mode === "human" || mode === "relay";
    const batch = takesLines ? this.speakers.get(windowId) ?? [] : [];
    if (takesLines) this.speakers.delete(windowId);
    const checkpoint = this.turnScope.getStore();
    if (checkpoint) checkpoint.batch = batch.map((l) => ({ ...l }));
    // Its only line was recalled before it was answered: nothing to answer.
    if (mode === "human" && !kickoff && !batch.length && !extra.arrival && this.recallEmptied.delete(windowId)) return;
    const autonomous = mode === "quiet" || mode === "side" || mode === "attention" || (mode === "arrival" && Boolean(extra.autonomous));
    let scene = this.scene(windowId);
    const sceneThread = scene;
    if (this.forks && extra.arrival?.newcomer && scene) {
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
    // Public conversation remains public; it does not wake the GM or any scene's co-players.
    if (lobby) return;
    const speakerIds = new Set(batch.map((l) => l.id));
    const visitorsIn = scene ? [...speakerIds].filter((id) => !scene.members.includes(id)) : [];

    let budget = mode === "spark" ? this.turnScope.getStore().lineLimit : this.cfg.maxActionsPerTurn;
    if (gentle) budget = Math.min(budget, checkpoint.dailyBudget.limit - checkpoint.dailyBudget.posted);
    let reviewed = null, reviewDecision = null;
    const reviewInvite = () => reviewed && reviewDecision?.decision !== "rest" && this.scene(windowId)?.members.includes(reviewed.id);
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
      if (roundMode === mode && ["human", "relay", "quiet", "side", "attention"].includes(mode) && budget >= 2 && (!autonomous || !this.overBudget())) reviewed = attentionCandidates(this, windowId)[0] ?? null;
      if (roundMode === "attention" && !reviewed) return { actions: [], coplayersMayAct: false, spotlight: [], whereabouts: [] };
      const ctx = await this.buildGm(windowId, { storyPlan: this.storyPlanSection() });
      lastCtx = ctx;
      // Compaction runs beside the turn: this round's prompt is already built.
      if (mode !== "spark") this.memory.maintainGm(windowId, ctx.lines(windowId), ctx.render, { windowName: this.windowName(windowId) });
      const scope = new Set([...(scene?.members ?? []), ...visitorsIn]);
      const mayMove = [...scope].filter(id => this.isPc(id) ? (this.dailyOn() && mode !== "attention" && !gentle && this.isPassive(id)) || (["human", "relay"].includes(roundMode) && speakerIds.has(id)) : MOVE_MODES.has(roundMode));
      const whereabouts = this.cfg.timelineAuto && scene
        ? whereaboutsBrief({ timelines: this.timelines, scene: { timeline: scene }, nameOf: (id) => this.nameOf(id), windowName: (id) => this.windowName(id), isPc: (id) => this.isPc(id), mayMove, capReached: this.timelines.active().length >= this.cfg.timelineMaxActive, forks: this.forks })
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
      const request = { language: this.language, profile: this.profile, context: ctx.parts, pbta, newest, mode: roundMode, kickoff: roundMode === "kickoff", timeline, whereabouts, scenario, auto: this.cfg.timelineAuto, forks: this.forks, illustrate: this.illustrationsOn() && (this.cfg.illustrations?.maxPerHour ?? 0) > 0, improv: this.improv.on, casual: this.casualOn(), planner: this.plannerVerdict(), between, calendar: this.calendarOn(), daily: this.dailyOn(), ...roundExtra, gentle, attentionNote: roundMode === mode ? attentionBrief(reviewed, { gentle }) : '', dailyNote: [this.passiveNote(windowId), roundExtra.dailyNote].filter(Boolean).join("\n") };
      if (this.sparkCancelled() || ((mode === "spark" || gentle) && this.overBudget())) return { actions: [], coplayersMayAct: false, spotlight: [], whereabouts: [] };
      let plan = await directTurn(this.llm, request);
      if (this.sparkCancelled()) return { actions: [], coplayersMayAct: false, spotlight: [], whereabouts: [] };
      const moves = MOVE_MODES.has(roundMode) && !(roundMode === "followup" && (mode === "arrival" || mode === "kickoff"));
      let placements;
      const newActorLine = batch.length || this.history.lines(windowId, { after: checkpoint?.startSeq ?? this.lastSeq }).some(m => m.kind === "ic" && this.roster.isCoplayer(m.character_id));
      if (this.cfg.timelineAuto && scene && moves && (plan.whereabouts.length || newActorLine) && (!autonomous || !this.overBudget())) {
        const checked = await this.checkDestinations(windowId, plan.whereabouts, scope, batch, roundMode);
        placements = planWhereabouts({
          timelines: this.timelines, scene: { timeline: scene, windowId }, reports: checked.reports, scopeIds: scope, speakers: speakerIds, verifiedCompanions: true, decisionSeqs: checked.decisionSeqs, passiveFollowers: new Set(this.dailyOn() && mode !== "attention" && !gentle ? [...scope].filter(id => this.isPassive(id)) : []), mode: roundMode,
          resolve: n => this.investigatorByName(n), isPc: id => this.isPc(id), userOf: id => this.userOf(id), windowUsers: w => this.windowUsers(w),
          guard: this.guard, turn: turnNo, now: this.now(), cfg: this.cfg,
        });
        const blocked = new Set(placements.ignored.map(i => i.id));
        placements.ignored.push(...checked.ignored);
        if ((checked.disputed || blocked.size) && plan.actions.length) {
          // Drafted dialogue/opening may already put the wrong person in the other room.
          const verified = checked.reports.map(r => ({ who: r.who.filter(n => !blocked.has(this.investigatorByName(n))), destination: r.place || r.thread })).filter(r => r.who.length);
          plan = await directTurn(this.llm, { ...request, whereabouts: whereabouts + "\nVerified departures for this round: " + JSON.stringify(verified) + ". Everyone else stays. Redraft actions to respect these placements; do not report new moves." });
        }
      }
      this.generation.signal.throwIfAborted();
      // Resolve the current mechanical decision before spending a turn on an unrelated opportunity.
      if (roundMode === mode && reviewed && plan.actions.some(a => ["request_roll", "move", "ask"].includes(a.type))) reviewed = null;
      if (roundMode === mode && reviewed) reviewDecision = plan.attentionReview;
      if (this.sparkCancelled() || (gentle && this.overBudget())) return { actions: [], coplayersMayAct: false, spotlight: [], whereabouts: [] };
      if (this.forks && placements?.ops.some(o => ["split", "move", "merge", "fork_main"].includes(o.op))) {
        const out = await this.applyPlan(placements, { windowId, mode: roundMode, turn: turnNo, autonomous });
        placements = null;
        if (out?.moved.length) {
          if (reviewed && !this.scene(windowId)?.members.includes(reviewed.id)) noteAttention(this, reviewed, reviewDecision);
          if (out.here) here = out.here;
          // Discard prose written for the old audience. Each new scene gets its own opening/context.
          if (this.scene(windowId) && !here) this.schedule(windowId, { mode: "followup", delay: 0 });
          return { actions: [], coplayersMayAct: false, spotlight: [], whereabouts: [] };
        }
      }
      if (between) { between = null; this.planner.between = null; this.save(); }
      this.log(`turn ${this.turns} (${roundMode}): ${plan.actions.length} GM action(s), co-players ${plan.coplayersMayAct ? "may act" : "wait"}${plan.whereabouts.length ? `, ${plan.whereabouts.length} whereabouts` : ""}`);
      const evidenceThrough = this.lastSeq;
      // A small event ends before a scenario change in the same turn, whatever the order the GM listed them in.
      const change = plan.actions.findIndex((x) => x.type === "advance_scenario" || x.type === "enter_scenario");
      if (change >= 0) plan.actions = [...plan.actions.slice(0, change), ...plan.actions.slice(change).filter((x) => x.type === "event_done"), ...plan.actions.slice(change).filter((x) => x.type !== "event_done")];
      for (const action of plan.actions) {
        this.generation.signal.throwIfAborted();
        const reserve = roundMode === mode && reviewInvite() ? Math.min(2, this.cfg.maxActionsPerTurn - 1) : 0;
        if (budget <= reserve || (gentle && this.overBudget())) break;
        if (this.pbta && action.type === "move" && !intents.some(m => m.id === action.source_id && m.character_id === action.character_id)) continue;
        const newNpc = action.type === "new_npc" && !this.roster.npcByName(action.name);
        budget -= await this.act(windowId, action, ctx, { mode: roundMode, parent: mode, scope, evidenceThrough });
        const kept = { advance_scenario: "a scenario change", enter_scenario: "a scenario change", world_change: "a world change" }[action.type]
          ?? (newNpc && this.roster.npcByName(action.name) ? `a new NPC, ${action.name}, who stays in the cast` : null);
        if (kept) this.turnScope.getStore()?.kept.push(kept);
        if (this.forks && sceneThread && !this.scene(windowId)) break;
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
      if (roundMode === mode && reviewed && (reviewDecision?.decision === "rest" || !this.scene(windowId)?.members.includes(reviewed.id))) noteAttention(this, reviewed, reviewDecision);
      return plan;
    };
    if (mode === "spark") {
      // Repair an already-established separation before selecting this window's speakers.
      // This only updates scene membership; unattended play still cannot invent travel.
      if (this.cfg.timelineAuto) await this.reconcilePresence(windowId, turnNo);
      const note = this.sparkNote(windowId);
      const sparker = extra.sparker;
      if (!sparker || this.sparkCancelled() || this.overBudget()) return;
      if (!this.scene(windowId)?.members.includes(sparker.id)) return;
      const peers = this.roster.coplayersIn(windowId).filter(c => c.characterId !== sparker.id);
      const peer = peers[Math.floor(this.random() * peers.length)];
      const dailyNote = [note.text, `THIS SMALL EXCHANGE: ${this.nameOf(sparker.id)}${peer ? ` and ${peer.name}` : ''}. Follow their own ordinary interests with each other or an already-present NPC; do not invent someone being here. Other characters need not join in. A passive character is not the default listener. Passing or ending the conversation is fine.`].filter(Boolean).join("\n");
      const n = sparker.coplayer ? await this.coplayerAct(windowId, sparker.coplayer, true, { spark: true, dailyNote }) : this.standinAct ? await this.standinAct(windowId, sparker.id, { spark: true }) : 0;
      budget -= n;
      if (!n) {
        if (!this.sparkCancelled()) await this.finishSpark(windowId, { state: "ended", title: "" }, note.urge);
        return;
      }
      if (peer && budget > 1 && !this.sparkCancelled() && !this.overBudget()) budget -= await this.coplayerAct(windowId, peer, false, { whistle: true, dailyNote });
      if (this.standinReplies && budget > 1 && !this.sparkCancelled()) budget -= await this.standinReplies(windowId, [], checkpoint.startSeq, budget - 1, { spark: true, except: sparker.id });
      if (this.sparkCancelled() || this.overBudget()) return;
      const plan = budget > 0 ? await round("spark", { dailyNote }) : null;
      await this.finishSpark(windowId, plan?.topic, note.urge);
      return;
    }
    // Players back after being away are welcomed back in this turn.
    const returning = takesLines ? [...new Set(batch.map((l) => l.id))].filter((id) => this.returning.has(id)).map((id) => ({ name: this.nameOf(id), away: duration(this.returning.get(id)) })) : [];
    if (this.dailyOn() && takesLines) {
      for (const id of new Set(batch.map(l => l.id))) {
        const record = this.dailyReturns?.get(id);
        if (!record) continue;
        const at = returning.findIndex(r => r.name === record.name);
        if (at >= 0) returning.splice(at, 1);
        returning.push(record); this.dailyReturns.delete(id);
      }
    }
    for (const l of batch) this.returning.delete(l.id);
    let plan = await round(kickoff ? "kickoff" : mode, returning.length ? { ...extra, returning } : extra);
    if (!kickoff && mode !== "arrival") this.noteStall(windowId, lastCtx);
    if (here) { const arrival = here; here = null; plan = await round("arrival", { arrival }); }
    if (!this.scene(windowId) && sceneThread) return;                    // this window's scene just ended
    const side = mode === "side" || (mode === "arrival" && !this.presentPlayers(windowId).length);
    const passiveReplies = mode === "attention" || gentle ? 0 : await this.standinReplies(windowId, plan.spotlight, checkpoint.startSeq, Math.max(0, budget - (reviewInvite() ? 2 : 0)), { autonomous });
    budget -= passiveReplies;
    if (!plan.coplayersMayAct && !side && !reviewInvite()) {
      if (passiveReplies && budget > 0) {
        const followup = await round("followup", {});
        if (budget > 0) budget -= await this.standinReplies(windowId, followup.spotlight, checkpoint.startSeq, budget, { autonomous });
      }
      return;
    }
    // Pace: in a quiet turn a co-player acts only if it has not since the last human line, so slow humans are not
    // drowned out by the AI side of the table.
    const st2 = this.state(windowId);
    const lastSpoke = new Map(this.history.lines(windowId).filter(m => m.character_id && m.kind === "ic").map(m => [m.character_id, m.seq]));
    // A small turn budget must not give the first roster entry every available slot.
    const seated = this.roster.coplayersIn(windowId).filter(c =>
      (mode !== "attention" || (reviewInvite() && c.characterId === reviewed.id)) &&
      (plan.coplayersMayAct || side || (reviewInvite() && c.characterId === reviewed.id)) &&
      !(reviewed?.id === c.characterId && reviewDecision?.decision === "rest") &&
      (reviewInvite() && c.characterId === reviewed.id || mode !== "quiet" || !st2.coplayersActed?.has(c.characterId)))
      .sort((a, b) => (lastSpoke.get(a.characterId) ?? 0) - (lastSpoke.get(b.characterId) ?? 0));
    const first = seated.filter(c => reviewed?.id === c.characterId || plan.spotlight.some(n => norm(n) === norm(c.name)))
      .sort((a, b) => Number(b.characterId === reviewed?.id) - Number(a.characterId === reviewed?.id));
    let acted = 0;
    for (const c of [...first, ...seated.filter((x) => !first.includes(x))]) {
      if (budget <= 0 || (reviewed && acted > 0 && budget <= 1) || (autonomous && this.overBudget()) || this.sparkCancelled()) break;
      const n = await this.coplayerAct(windowId, c, first.includes(c), { side, gentle, attentionNote: attentionChoice(c.characterId === reviewed?.id ? reviewed : null) });
      if (c.characterId === reviewed?.id) noteAttention(this, reviewed, reviewDecision);
      if (n) (st2.coplayersActed ??= new Set()).add(c.characterId);
      acted += n; budget -= n;
    }
    // Co-players are players too: their choices get the GM's answer now, not at the next human line.
    if (budget > 0 && mode !== "attention" && !gentle) { const n = await this.standinReplies(windowId, [], checkpoint.startSeq, Math.max(0, budget - (reviewed ? 1 : 0)), { autonomous }); acted += n; budget -= n; }
    acted += passiveReplies;
    if (acted > 0 && budget > 0 && !this.sparkCancelled() && (!autonomous || !this.overBudget())) {
      let followup = await round("followup", {});
      if (here) { const arrival = here; here = null; followup = await round("arrival", { arrival }); }
      if (budget > 0 && mode !== "attention" && !gentle) budget -= await this.standinReplies(windowId, followup.spotlight, checkpoint.startSeq, budget, { autonomous });
    }
  }

  presenceThreads(...args) { return windows.presenceThreads(this, ...args); }

  reconcilePresence(...args) { return windows.reconcilePresence(this, ...args); }

  checkDestinations(...args) { return windows.checkDestinations(this, ...args); }

  correctPlacement(...args) { return windows.correctPlacement(this, ...args); }

  postHandoff(...args) { return windows.postHandoff(this, ...args); }

  presentPlayers(...args) { return windows.presentPlayers(this, ...args); }

  // ---- applying whereabouts: platform calls, then local state, then posts and arrivals
  channelUsers(...args) { return windows.channelUsers(this, ...args); }
  // The channel's members, cached for a minute (a window.changed event, as when someone joins, drops the cache).
  channelMemberRows(...args) { return windows.channelMemberRows(this, ...args); }

  // A, with scene forks: restricted forks for the new scenes. Persist the exact parent and idempotency key BEFORE
  // sending a fork request; recovery also covers a server commit whose response was lost. No scene is played until
  // every audience has its fork.
  forkScenes(...args) { return windows.forkScenes(this, ...args); }

  // A, without scene forks: a fresh window for each new scene (or a spare/retired one for the same people at the same
  // place). Nothing local changes until they exist; a server failure postpones the whole plan (null).
  openSceneWindows(...args) { return windows.openSceneWindows(this, ...args); }

  applyPlan(...args) { return windows.applyPlan(this, ...args); }

  noteIgnored(...args) { return scheduling.noteIgnored(this, ...args); }

  // Arrivals are capped per hour; those that come from autonomous turns also respect the idle pause and the hourly
  // autonomy cap. `force` (roll-forward after a restart, CLI-owed arrivals) skips the caps.
  scheduleArrival(...args) { return scheduling.scheduleArrival(this, ...args); }

  // LLM_DAILY_TOKEN_BUDGET: once today's billable-equivalent tokens reach it, the table stops starting turns of its own
  // (answers to humans still run). Logged once a day.
  overBudget(...args) { return scheduling.overBudget(this, ...args); }

  // After every change: each co-player has one open seat, in its timeline's window; every investigator is in one
  // active timeline; every active thread other than the main one has a window. Violations are logged and repaired.
  checkInvariants(...args) { return scheduling.checkInvariants(this, ...args); }

  // ---- the GM's moves. Returns how many lines were posted.
  act(...args) { return actions.act(this, ...args); }

  requestRoll(...args) { return actions.requestRoll(this, ...args); }

  // The GM's own dice (D&D: a monster's initiative, the order, plain rolls), posted as the GM account's line so the
  // platform rolls it; it has no character, so nothing is rolled against a sheet.
  gmDice(...args) { return actions.gmDice(this, ...args); }

  // ---- scenarios
  // `parent` is the turn's own mode: a followup round inside a quiet, side or arrival turn is still autonomous.
  scenarioVerdict(...args) { return actions.scenarioVerdict(this, ...args); }

  changeScenario(...args) { return actions.changeScenario(this, ...args); }

  // ---- typing flags: who is writing as which character right now (the platform's, per character)
  noteTyping(characterId, windowId, active) {
    if (!characterId) return;
    const was = this.typing.get(characterId);
    if (active) { if (!was || was.windowId !== windowId) this.typing.set(characterId, { windowId, since: this.now() }); return; }
    this.typing.delete(characterId);
    // A person who typed and stopped is present and thinking: the window's silence starts over.
    if (was && this.humanCharacter(characterId)) this.state(was.windowId).lastTypingAt = this.now();
  }
  // A player character of a real person: not one this account casts (a co-player), not an NPC.
  humanCharacter(id) { const user = this.userOf(id); return !!user && user !== this.me?.id && this.isPc(id); }
  // The human players writing in a window right now, by character name. A flag the platform never lowered (a lost
  // event) counts for TYPING_STALE_MS at most.
  humansTyping(windowId) {
    const names = [];
    for (const [cid, t] of this.typing) if (t.windowId === windowId && this.now() - t.since < TYPING_STALE_MS && this.humanCharacter(cid)) names.push(this.nameOf(cid));
    return names;
  }

  // ---- illustrations (illustrations.mjs)
  illustrationsOn(...args) { return art.illustrationsOn(this, ...args); }
  // Whether the platform's switches allow drawing here: the server's maintainers and the GM can each turn it off.
  illustrationsAllowed(...args) { return art.illustrationsAllowed(this, ...args); }
  readIllustrationSwitches(...args) { return art.readIllustrationSwitches(this, ...args); }

  // One request to the platform. Returns {job} or {failure: "disabled" | "unavailable" | "busy" | "rate_limited" | "error"}.
  requestIllustration(...args) { return art.requestIllustration(this, ...args); }

  // The GM's illustrate action: rare by rule, capped per hour here; it posts no line now (the picture arrives later).
  illustrateMoment(...args) { return art.illustrateMoment(this, ...args); }

  // ---- small events (the GM's event_done): each one's most striking moment, drawn where it was played
  // Where the current small event in a window began: after the last one there, the scenario's start, or the start of
  // the scene the window now holds (a reused scene window).
  eventStart(...args) { return art.eventStart(this, ...args); }

  // The event ends here; its picture is chosen after the turn, in order with every other picture's choice, unless no
  // player is here to see it, pictures are off, the event is too short, or the hour's in-play pictures are spent.
  eventDone(...args) { return art.eventDone(this, ...args); }

  drawEvent(...args) { return art.drawEvent(this, ...args); }

  // A picture chosen or asked for, under the scenario it belongs to.
  recordPicture(...args) { return art.recordPicture(this, ...args); }

  // The descriptions of the pictures of a scenario ({id, fromSeq, since}): the picture lines posted since it began in
  // every window, and those chosen this run and not posted yet; the newest twelve.
  drawnIn(...args) { return art.drawnIn(this, ...args); }

  // Before a scenario change: the timelines a player is in, each with its window and the lines of the scenario there.
  endingScenario(...args) { return art.endingScenario(this, ...args); }

  // After a scenario change: always one picture per timeline a player was in, of its most brilliant, beautiful moment,
  // all posted in the Main Chat.
  illustrateScenario(...args) { return art.illustrateScenario(this, ...args); }

  // Waiting pictures, one at a time: each waits for the account's previous picture to be drawn. Every caller gets the
  // same promise, settled when the queue is empty.
  drainIllustrations(...args) { return art.drainIllustrations(this, ...args); }
  drainQueue(...args) { return art.drainQueue(this, ...args); }

  // Until the platform has drawn (or failed) a picture, at most ten minutes, looking every `every` ms (a player waiting
  // for their picture is let go sooner).
  waitIllustration(...args) { return art.waitIllustration(this, ...args); }

  // ---- pictures of past plots, asked for in the planner window (plotArt.mjs)
  // The request in a player's command line in the planner window ("" when it names nothing), or null.
  artCommand(...args) { return art.artCommand(this, ...args); }

  // A command line, the table's reply about a picture, or the picture itself, in the planner window: kept out of the
  // planner's inbox and of every context. True for such a line.
  noteArt(...args) { return art.noteArt(this, ...args); }

  // A player's request: answered in the planner window at once, drawn there as soon as the platform can. One request
  // in flight per player, at most illustrations.requests_per_hour an hour each.
  onArtCommand(...args) { return art.onArtCommand(this, ...args); }

  // Finds the stretch of play the player means and has its moment drawn into the planner window. Returns the reply to
  // post when there is no picture ("notFound", "unavailable", "rateLimited", "failed"), else null.
  drawPastPlot(...args) { return art.drawPastPlot(this, ...args); }

  // ---- manual commands from the CLI (applied by the run process, or by the CLI itself when no run process is up)
  async command(cmd) {
    const turnNo = this.guard.beginTurn();
    await this.refresh();
    const resolveAll = (list) => names(list).map((n) => this.investigatorByName(n)).filter(Boolean);
    if (cmd.cmd === "world") return this.setWorld(cmd);
    if (cmd.cmd === "casual") return this.setCasual(cmd.on);
    if (cmd.cmd === "plan") return this.planCommand(cmd.action);
    if (cmd.cmd === "date" && !this.calendarOn()) throw new Error("date: the story keeps a calendar only in a casual game (casual on)");
    if (cmd.cmd === "date") { const r = this.moveCalendar({ days: cmd.days, date: cmd.date, time: cmd.time, why: cmd.why ?? "by the operator", by: "operator" }); if (r.refused) throw new Error(`date: ${r.refused}`); await this.flushDayTurns(); return r; }
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
  plannerMode(...args) { return planning.plannerMode(this, ...args); }
  storyPlanSection(...args) { return planning.storyPlanSection(this, ...args); }
  plannerVerdict(...args) { return planning.plannerVerdict(this, ...args); }
  impulseFor(...args) { return planning.impulseFor(this, ...args); }

  // After a turn: the same scenario, place, world record, truths and threads as last time means the story stood still.
  noteStall(...args) { return planning.noteStall(this, ...args); }

  // The GM's planner_note action: a signal for the next plan (and "this beat is done").
  plannerNote(...args) { return planning.plannerNote(this, ...args); }
  beatClosed(...args) { return planning.beatClosed(this, ...args); }

  planCommand(...args) { return planning.planCommand(this, ...args); }

  // At a turn boundary: plan now if due (in the background, beside the turns).
  maybePlan(...args) { return planning.maybePlan(this, ...args); }

  // The planning job: the GM's context plus the planner's briefing, three model calls, the result parked for the
  // next turn boundary. One at a time; failures are logged, never thrown. With `session` it is that session's final
  // review: it reads every window's lines of the session and also prepares the next one (`between`).
  runPlanner(...args) { return planning.runPlanner(this, ...args); }

  // Makes a finished plan the current one (idempotent), records it and tells the GM once per version. A plan may
  // set the story's first date and change relationships; a final review also moves the calendar on and records what
  // happened off-screen.
  adoptPlan(...args) { return planning.adoptPlan(this, ...args); }

  // The planner's table notes (the players' standing wishes and corrections), and its answer in the planner window.
  applyTableNotes(...args) { return planning.applyTableNotes(this, ...args); }

  // The planner's routine for the current date (after a final review: for the date the next session resumes). It is
  // common knowledge, so one that quotes a secret or a hidden truth is dropped.
  applyRoutine(...args) { return planning.applyRoutine(this, ...args); }

  // The final review's result: the calendar moves on, off-screen developments go to the world record, and the first
  // turn of the next session is told how to open (betweenNote).
  applyBetween(...args) { return planning.applyBetween(this, ...args); }
  betweenNote(...args) { return planning.betweenNote(this, ...args); }

  // ---- sessions and the final review
  // A player's line: the session goes on, or a new one begins.
  noteSession(...args) { return planning.noteSession(this, ...args); }

  // On the clock (every 10 s, autonomy or not): once nobody has written for the idle time, a session with enough play
  // gets its final review. Waits while a turn or a planner run is in progress.
  checkSessionEnd(...args) { return planning.checkSessionEnd(this, ...args); }

  finalReview(...args) { return planning.finalReview(this, ...args); }

  // When `run` is stopped: the session in progress, if long enough, gets its final review first.
  finishSession(...args) { return planning.finishSession(this, ...args); }

  // ---- the calendar and relationships
  // The GM keeps to the pace (config `calendar`); the final review has its own most days; the operator and the
  // planner's first date have neither.
  moveCalendar(...args) { return planning.moveCalendar(this, ...args); }
  // The GM's date move that the pace held back or cut short: a note only the GM reads, so the story can follow
  // the date that stands.
  calendarHeld(...args) { return planning.calendarHeld(this, ...args); }
  recordBond(...args) { return planning.recordBond(this, ...args); }

  // ---- casual mode: phones (casual.mjs)
  isPhone(...args) { return social.isPhone(this, ...args); }
  phoneOwner(...args) { return social.phoneOwner(this, ...args); }
  // On, and allowed here: a phone is private only on an isolated channel with one player per group.
  casualOn(...args) { return social.casualOn(this, ...args); }

  setCasual(...args) { return social.setCasual(this, ...args); }

  // ---- the table's own windows: the planner window (wishes.mjs), the phones and the GM's phone log (casual.mjs)
  isPlannerWindow(...args) { return social.isPlannerWindow(this, ...args); }
  // Windows that are no scene: no turn is played there and autonomy never moves them.
  isTableWindow(...args) { return social.isTableWindow(this, ...args); }
  plannerWindowWanted(...args) { return social.plannerWindowWanted(this, ...args); }

  ensureTableWindows(...args) { return social.ensureTableWindows(this, ...args); }

  // The planner window: every player of the channel in it (a newcomer is added), the GM reading.
  ensurePlannerWindow(...args) { return social.ensurePlannerWindow(this, ...args); }

  // Casual mode: the GM's phone log, a window with only the GM in it, for texts no player is part of.
  ensurePhoneLog(...args) { return social.ensurePhoneLog(this, ...args); }

  // A line in the planner window: kept for the planner's next run, whatever triggers it (no run of its own).
  onWishLine(...args) { return social.onWishLine(this, ...args); }

  // New players join the current primary scene, which may now be a private fork.
  welcomeNewcomers(...args) { return social.welcomeNewcomers(this, ...args); }

  // Every player character with a player gets a phone: a private window with only that player in it.
  ensurePhones(...args) { return social.ensurePhones(this, ...args); }

  // A player's line in their own phone: a text message to someone.
  onPhoneLine(...args) { return social.onPhoneLine(this, ...args); }

  // Player to player: the message appears at once in the recipient's phone, as the sender's character.
  relayText(...args) { return social.relayText(this, ...args); }

  // An NPC or a co-player reads a text and answers, after a believable delay, or leaves it unanswered.
  phoneTurn(...args) { return social.phoneTurn(this, ...args); }

  // The GM's text action: a real NPC texts a player character, now or after a delay.
  sendText(...args) { return social.sendText(this, ...args); }

  // A text no player character is part of (co-player or NPC to co-player or NPC): it goes to the phone log.
  aiText(...args) { return social.aiText(this, ...args); }
  // A text delivered to an AI character in the phone log: it answers, unless the two have gone back and forth
  // CASUAL_AI_CHAIN times since a person last wrote, the hourly cap is reached, or everyone is away.
  answerAiText(...args) { return social.answerAiText(this, ...args); }
  // A phone turn on the turn queue without a window timer (the phone log carries several conversations at once).
  enqueuePhone(...args) { return social.enqueuePhone(this, ...args); }

  queueText(...args) { return social.queueText(this, ...args); }

  // Delivers every text whose time has come: it appears in the recipient's phone as the sender's character.
  deliverDue(...args) { return social.deliverDue(this, ...args); }

  // ---- the platform's living world record
  // Declares a change to the world (off-screen, or a hidden truth) for the platform's observer to record. Best effort:
  // a platform without the world record (404) is noted once and the table carries on with its own notes.
  declare(...args) { return social.declare(this, ...args); }

  // ---- improvisation mode
  // The posted world setting is left out of every chat context: the GM and the co-players get it as a section of its own.
  hiddenLines(...args) { return social.hiddenLines(this, ...args); }

  // `world` command (and `setup` while `run` is up): turns the mode on or off and replaces the setting texts.
  setWorld(...args) { return social.setWorld(this, ...args); }

  // Hands the world setting (public) and the GM's secrets (secret) to the platform's world record, once per version
  // of each text, so its observer knows the places, groups and people from the start.
  seedWorld(...args) { return social.seedWorld(this, ...args); }

  // Posts the world setting in the Main Chat for the human players, once per version of the text.
  publishWorld(...args) { return social.publishWorld(this, ...args); }

  // ---- older, model-led timelines (TIMELINE_AUTO=false)
  coplayersNamed(...args) { return windows.coplayersNamed(this, ...args); }

  legacySplit(...args) { return windows.legacySplit(this, ...args); }

  legacyRejoin(...args) { return windows.legacyRejoin(this, ...args); }

  // Time, place, span and notes of a timeline. (With TIMELINE_AUTO, membership changes only through whereabouts.)
  updateTimeline(...args) { return windows.updateTimeline(this, ...args); }

  // ---- autonomy
  startTicker(...args) { return scheduling.startTicker(this, ...args); }
  stopTicker(...args) { return scheduling.stopTicker(this, ...args); }

  // Picks at most one window that should move on its own, and queues its turn.
  tick(...args) { return scheduling.tick(this, ...args); }

  createNpc(...args) { return actions.createNpc(this, ...args); }

  characterByName(...args) { return actions.characterByName(this, ...args); }
  // Investigators only (player characters and co-players): exact name first, then a unique first name.
  investigatorByName(...args) { return actions.investigatorByName(this, ...args); }

  // A character's role card, and the sheet values the dice keep (`attrs`: live HP, slots), cached until the
  // platform says the character changed.
  card(...args) { return actions.card(this, ...args); }

  // A co-player's move, from its own witnessed chat (every window it sat in, during its seats) and its companions'
  // profiles. Nothing from the GM's side. Lines a player wrote while their character was in another scene are not
  // something this co-player witnessed, even in a window it sits in.
  coplayerAct(...args) { return coplayers.coplayerAct(this, ...args); }

  // Who a co-player knows: every investigator, and the real NPCs it has seen speak in its own scenes (newest last).
  knownTo(...args) { return coplayers.knownTo(this, ...args); }
  // What anyone would notice about the NPCs a co-player has met: gender, age, striking traits; never the GM's brief.
  metBy(...args) { return coplayers.metBy(this, ...args); }
  // The calendar moved on since this co-player last spoke: it lived through that time too.
  timePassedFor(...args) { return coplayers.timePassedFor(this, ...args); }

  // `count: false` marks bookkeeping lines (pointers, notes) that do not use up the turn's action budget.
  post(...args) { return actions.post(this, ...args); }
}
