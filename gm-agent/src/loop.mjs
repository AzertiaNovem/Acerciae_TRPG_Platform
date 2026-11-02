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
import { coplayerLog, renderLine } from "./context/coplayerContext.mjs";
import { Store, billableTokens } from "./store.mjs";
import { History, Memory, estimateTokens, CHUNK_LINES } from "./memory.mjs";
import { metered } from "./llm/parts.mjs";
import { investigatorsFor } from "./context/profiles.mjs";
import { directTurn } from "./director.mjs";
import { coplayerSelf, coplayerTurn } from "./coplayer.mjs";
import { generateNpc, saveCharacter } from "./roles/cardgen.mjs";
import { isPlayerCharacter, openWindows } from "./roles/roster.mjs";
import { Timelines, MAIN, placeKey } from "./timelines.mjs";
import { Guard, planWhereabouts, whereaboutsBrief } from "./whereabouts.mjs";
import { addTruth, hashText, improvState, worldMessages } from "./improv.mjs";
import { PHONE_PREFIX, casualState, coplayerPhoneReply, dueAt, parseAddress, renderThread } from "./casual.mjs";

const LANGUAGES = { en: "English", zh: "Simplified Chinese", "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French", de: "German", ru: "Russian", pt: "Portuguese", it: "Italian" };
export const languageName = (code) => LANGUAGES[code] ?? LANGUAGES[String(code ?? "").split("-")[0]] ?? (code || "English");

const ROLL = /^\.(ra|rc|r|sc)(\s|$)/i;
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
  constructor({ api, llm, cfg, channelId, roster, timelines, guard, store = null, scenario = null, improv = null, casual = null, journal = null, owedArrivals = [], deferArrivals = false, persist = () => {}, log = () => {}, sleep, now = Date.now }) {
    this.api = api;
    // The client's own store (store.mjs): the chat's local copy, compacted chapters, token usage. In memory when none
    // is given (tests, read-only commands).
    this.store = store ?? new Store();
    this.llm = metered(llm, { sink: (u) => this.store.recordUsage({ ...u, at: this.now() }), channelId });
    this.cfg = cfg;
    this.channelId = channelId;
    this.roster = roster;
    this.now = now;
    this.timelines = timelines ?? new Timelines([], { now });
    this.guard = guard ?? new Guard();
    this.scenario = scenario;            // {id, since}: when the client saw the current scenario begin
    this.improv = improvState(improv);   // improvisation mode: world setting, hidden truths (improv.mjs)
    this.casual = casualState(casual);   // casual mode: phones, pending replies (casual.mjs)
    this.journal = journal;              // an applyPlan in progress, for roll-forward after a crash
    this.owedArrivals = [...owedArrivals];
    this.deferArrivals = deferArrivals;
    this.persist = persist;
    this.log = log;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.history = new History({ api, store: this.store, channelId, pageSize: cfg.contextLines, backfill: cfg.historyBackfillLines ?? 1000, log });
    this.memory = new Memory({ store: this.store, llm: this.llm, gmBudget: cfg.gmContextTokens ?? 60000, coplayerBudget: cfg.coplayerContextTokens ?? 24000, log });
    this.gm = new GmContext(api, channelId, { history: this.history, memory: this.memory, budget: cfg.gmContextTokens ?? 60000, log });
    this.botMessageIds = new Set();
    this.timers = new Map();
    this.queue = Promise.resolve();
    this.pending = 0;          // turns waiting or running
    this.cards = new Map();
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
    this.rules = await this.api.coc7Rules().catch(() => null);
    await this.refresh();
    for (const w of this.windows) if (Number.isFinite(Number(w.last_seq))) this.noteSeq(w.id, Number(w.last_seq));
    await this.observeHistory();
    this.speakers.clear();                 // history never authorises a move
    if (this.channel.current_scene_id && this.scenario?.id !== this.channel.current_scene_id) {
      const scenes = (await this.api.scenes(this.channelId).catch(() => [])) ?? [];
      const cur = scenes.find((s) => s.id === this.channel.current_scene_id);
      this.scenario = { id: this.channel.current_scene_id, since: Date.parse(cur?.created_at) || this.now() };
    }
    if (heal) await this.heal();
    if (heal) await this.publishWorld();
    this.ready = true;
    if (heal) await this.ensurePhones();
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
      for (const c of j.created ?? []) this.guard.spare.push(c);          // reuse the windows it already opened
      await this.applyPlan({ ops: j.ops, changed: j.changed ?? [], ignored: [], guard: {}, prevOf: () => null }, { windowId: j.windowId, mode: "manual", turn: this.guard.turn, quiet: true });
    } else if (this.journal) { this.journal = null; changed = true; }
    for (const t of this.timelines.active()) if (t.id !== MAIN && t.windowId && !t.opened) this.scheduleArrival(t.windowId, { names: t.members.map((id) => this.nameOf(id)), place: t.location, reunion: false }, { force: true });
    const owed = this.owedArrivals.splice(0);
    for (const a of owed) this.scheduleArrival(a.windowId, a.arrival, { force: true });
    if (changed || owed.length) this.save();
  }

  // Single-flight, generation-checked: a stale list never overwrites a newer one.
  async refresh() {
    const gen = ++this.refreshGen;
    const [characters, windows] = await Promise.all([this.api.characters(this.channelId), this.api.windows(this.channelId)]);
    if (gen < this.appliedGen) return;
    this.appliedGen = gen;
    this.characters = characters;
    this.windows = windows;
    const main = this.mainWindow();
    this.roster.reconcile(this.characters, main ? [main.id] : [], { castBy: this.me?.id });
    this.timelines.reconcile(investigatorsFor(this.characters, this.roster).map((c) => c.id));
    if (this.ready && this.casual.on) this.ensurePhones().catch(() => {});   // a player who just joined gets a phone
  }

  mainWindow() { return this.windows.find((w) => w.kind === "main") ?? this.windows[0]; }
  windowName(id) { return this.windows.find((w) => w.id === id)?.name ?? "another window"; }
  nameOf(id) { return this.characters.find((c) => c.id === id)?.name ?? id; }
  // A player character, played by a real person (a GM-cast PC is a co-player).
  isPc(id) { return isPlayerCharacter(this.characters.find((c) => c.id === id), this.roster); }
  userOf(id) { return this.characters.find((c) => c.id === id)?.user_id ?? null; }
  // The active timeline played in a window: the main one in the Main Chat, a thread in its own window, else none.
  scene(windowId) {
    if (windowId === this.mainWindow()?.id) return this.timelines.main();
    return this.timelines.activeOfWindow(windowId);
  }
  // Where a timeline is played.
  windowOf(timeline) { return timeline.id === MAIN ? this.mainWindow()?.id : timeline.windowId; }
  windowUsers(windowId) { return (this.windows.find((w) => w.id === windowId)?.members ?? []).map((m) => m.user_id).filter((u) => u && u !== this.me?.id); }

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
  async observeHistory() {
    for (const w of this.windows) {
      await this.history.sync(w.id).catch((e) => this.log(`history ${w.name}: ${e.message}`));
      for (const m of this.history.lines(w.id).slice(-20)) this.noteLine(m);
    }
  }

  // How the Keeper reads a line: visibility and the timeline it comes from (see gmContext.mjs).
  renderForGm(m) { return renderLine({ ...m, whisper_to_names: (m.whisper_to ?? []).map((id) => this.nameOf(id)) }, { markVisibility: true, timeline: this.timelines.ofLine(m).name }); }

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
    if (ev.type === "window.changed") this.refresh().catch((e) => this.log(`refresh: ${e.message}`));
    if (ev.type === "scene.changed" && ev.scene?.status === "active" && ev.scene.id !== this.scenario?.id) {
      this.scenario = { id: ev.scene.id, since: this.now() };
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

  // Returns the scheduled turn (settled when it ran), or undefined when the line starts no turn.
  onMessage(m) {
    if (m && m.channel_id === this.channelId) this.noteLine(m);
    if (m && this.isPhone(m.chat_window_id)) return this.onPhoneLine(m);   // a phone never starts a scene turn
    if (!this.isTrigger(m)) return undefined;
    return this.schedule(m.chat_window_id);
  }

  // Waits for a quiet moment in the window, then queues one turn (turns run one at a time). A line arriving before the
  // turn starts restarts the wait; every caller's promise settles when that one turn has run. A human line outranks
  // an autonomous turn; an arrival rides along with whatever turn is pending and never shortens a human's wait.
  schedule(windowId, { kickoff = false, mode = "human", delay = this.cfg.debounceMs, ...extra } = {}) {
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
        const done = () => { this.pending--; for (const r of pending.resolvers) r(); };
        this.queue = this.queue.then(() => this.turn(windowId, { kickoff: pending.kickoff, mode: pending.mode, ...pending.extra })).catch((e) => this.log(`turn failed: ${e.message}`)).then(done);
      }, delay);
    });
  }

  // ---- one turn
  async turn(windowId, { kickoff = false, mode = "human", ...extra } = {}) {
    if (mode === "phone") { this.turns++; await this.refresh(); return this.phoneTurn(windowId, extra.phone ?? {}); }
    this.turns++;
    const turnNo = this.guard.beginTurn();
    await this.refresh();
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
    if (mode === "arrival" && sceneThread && sceneThread.id !== MAIN && !sceneThread.opened) { sceneThread.opened = true; this.save(); }

    // Relay: lines here only from players whose character is in another scene with a window of its own (this
    // window's own scene, or a scene that is over).
    if (mode === "human" && this.cfg.timelineAuto && batch.length && (scene || this.timelines.retired(windowId))) {
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
    const speakerIds = new Set(batch.map((l) => l.id));
    const visitorsIn = scene ? [...speakerIds].filter((id) => !scene.members.includes(id)) : [];

    let budget = this.cfg.maxActionsPerTurn;
    const timeline = this.timelines.ofWindow(windowId);
    let here = null;                       // an arrival that lands in this very window
    const round = async (roundMode, roundExtra) => {
      scene = this.scene(windowId);
      const ctx = await this.gm.build({ windowId, roster: this.roster, characters: this.characters, windows: this.windows, timelines: this.timelines, sceneOf: (w) => this.scene(w), improv: this.improv, hide: this.hiddenLines(), awayOf: (id) => this.awayOf(id) });
      // Compaction runs beside the turn: this round's prompt is already built.
      this.memory.maintainGm(windowId, ctx.lines(windowId), ctx.render, { windowName: this.windowName(windowId) });
      const scope = new Set([...(scene?.members ?? []), ...visitorsIn]);
      const mayMove = [...scope].filter((id) => (this.isPc(id) ? ["human", "relay"].includes(roundMode) && speakerIds.has(id) : ["followup", "side"].includes(roundMode)));
      const whereabouts = this.cfg.timelineAuto && scene
        ? whereaboutsBrief({ timelines: this.timelines, scene: { timeline: scene }, nameOf: (id) => this.nameOf(id), windowName: (id) => this.windowName(id), isPc: (id) => this.isPc(id), mayMove, capReached: this.timelines.active().length >= this.cfg.timelineMaxActive })
        : "";
      const verdict = await this.scenarioVerdict(windowId, roundMode, mode);
      const scenario = this.cfg.scenarioAuto ? `Scenario change: ${verdict.ok ? "possible this turn, if the story as a whole has moved on." : `not this turn (${verdict.reason}).`}` : "";
      const plan = await directTurn(this.llm, { language: this.language, context: ctx.parts, newest: ctx.newest, mode: roundMode, kickoff: roundMode === "kickoff", timeline, whereabouts, scenario, auto: this.cfg.timelineAuto, improv: this.improv.on, casual: this.casualOn(), ...roundExtra });
      this.log(`turn ${this.turns} (${roundMode}): ${plan.actions.length} Keeper action(s), co-players ${plan.coplayersMayAct ? "may act" : "wait"}${plan.whereabouts.length ? `, ${plan.whereabouts.length} whereabouts` : ""}`);
      for (const action of plan.actions) {
        if (budget <= 0) break;
        budget -= await this.act(windowId, action, ctx, { mode: roundMode, parent: mode, scope });
      }
      // Whereabouts apply in rounds that may move someone; never inside an arrival or a kickoff (no cascades).
      const moves = MOVE_MODES.has(roundMode) && !(roundMode === "followup" && (mode === "arrival" || mode === "kickoff"));
      if (this.cfg.timelineAuto && scene && plan.whereabouts.length && moves) {
        const result = planWhereabouts({
          timelines: this.timelines, scene: { timeline: scene, windowId }, reports: plan.whereabouts, scopeIds: scope, speakers: speakerIds, mode: roundMode,
          resolve: (n) => this.investigatorByName(n), isPc: (id) => this.isPc(id), userOf: (id) => this.userOf(id), windowUsers: (w) => this.windowUsers(w),
          guard: this.guard, turn: turnNo, now: this.now(), cfg: this.cfg,
        });
        for (const i of result.ignored) this.log(`whereabouts: ${this.nameOf(i.id)} stays (${i.why})`);
        const out = await this.applyPlan(result, { windowId, mode: roundMode, turn: turnNo, autonomous });
        if (out?.here) here = out.here;
      } else if (this.cfg.timelineAuto && scene) {
        this.guard.apply(planWhereabouts({ timelines: this.timelines, scene: { timeline: scene }, reports: [], scopeIds: scope, guard: this.guard, turn: turnNo, now: this.now(), cfg: this.cfg }).guard);
      }
      return plan;
    };
    // Players back after being away are welcomed back in this turn.
    const returning = takesLines ? [...new Set(batch.map((l) => l.id))].filter((id) => this.returning.has(id)).map((id) => ({ name: this.nameOf(id), away: duration(this.returning.get(id)) })) : [];
    for (const l of batch) this.returning.delete(l.id);
    let plan = await round(kickoff ? "kickoff" : mode, returning.length ? { ...extra, returning } : extra);
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

  presentPlayers(windowId) {
    const scene = this.scene(windowId);
    if (scene) return scene.members.filter((id) => this.isPc(id));
    return (this.windows.find((w) => w.id === windowId)?.members ?? []).filter((m) => m.user_id !== this.me?.id).map((m) => m.character_id);
  }

  // ---- applying whereabouts: platform calls, then local state, then posts and arrivals
  async channelUsers() {
    if (!this.memberCache || this.now() - this.memberCache.at > 60000) {
      const rows = (await this.api.channelMembers(this.channelId).catch(() => null)) ?? null;
      this.memberCache = { at: this.now(), users: rows ? new Set(rows.map((r) => r.id ?? r.user_id)) : null };
    }
    return this.memberCache.users;
  }

  async applyPlan(result, { windowId, mode, turn, autonomous = false, quiet = false }) {
    const ops = result.ops.map((o) => ({ ...o }));
    // A split the platform failed three times is given up (the people stay), so it is not retried every turn.
    const factOf = (o) => JSON.stringify([placeKey(o.place), [...o.ids].sort()]);
    const givenUp = [];
    for (const o of ops) if (o.op === "split" && (this.guard.retries[factOf(o)] ?? 0) >= 3) { o.skip = true; givenUp.push(...o.ids.map((id) => ({ id, why: "the platform failed to open this scene three times" }))); }
    if (!ops.some((o) => !o.skip)) { this.guard.apply(result.guard); const ig = [...result.ignored, ...givenUp]; if (ig.length) this.noteIgnored(windowId, ig); return null; }
    const lastSeq = this.lastSeq;
    // A. Platform calls first: windows for the new threads. Nothing local changes until they exist.
    this.journal = { opId: `${turn}-${lastSeq}`, ops, changed: result.changed, windowId, created: [], phase: "A" };
    this.save();
    const users = await this.channelUsers();
    const windowFor = new Map();
    const dropped = [...givenUp];
    const reusedSpares = [];
    for (const s of ops.filter((o) => o.op === "split" && !o.skip)) {
      const pcs = s.ids.filter((id) => this.isPc(id));
      const seatable = pcs.filter((id) => this.userOf(id) && (!users || users.has(this.userOf(id))));
      for (const id of pcs.filter((p) => !seatable.includes(p))) { s.ids = s.ids.filter((x) => x !== id); dropped.push({ id, why: "not a channel member, so no window can seat them" }); }
      if (!s.ids.length) { s.skip = true; continue; }
      const wantUsers = [...new Set(seatable.map((id) => this.userOf(id)))].sort();
      const key = placeKey(s.place);
      const spare = this.guard.spare.find((x) => x.placeKey === key && JSON.stringify([...x.users].sort()) === JSON.stringify(wantUsers));
      const retired = this.windows.find((w) => this.timelines.retired(w.id) && placeKey(this.timelines.ofWindow(w.id)?.location) === key && JSON.stringify(this.windowUsers(w.id).sort()) === JSON.stringify(wantUsers));
      if (spare) { windowFor.set(s, spare.windowId); this.guard.spare = this.guard.spare.filter((x) => x !== spare); reusedSpares.push(spare); continue; }
      if (retired) { windowFor.set(s, retired.id); continue; }
      try {
        const members = [];
        for (const id of seatable) if (!members.some((m) => m.user_id === this.userOf(id))) members.push({ user_id: this.userOf(id), character_id: id });
        const w = await this.api.createWindow(this.channelId, { name: `${pcs.length ? "Scene" : "Side"}: ${String(s.place).slice(0, 60)}`, kind: "group", members });
        windowFor.set(s, w.id);
        this.journal.created.push({ windowId: w.id, placeKey: key, users: wantUsers });
        this.save();
      } catch (e) {
        if (e.status >= 400 && e.status < 500) { s.skip = true; for (const id of s.ids) dropped.push({ id, why: `the platform refused a window (${e.status})` }); continue; }
        // A server or network failure: nothing local changes; created windows are kept for reuse; retried later.
        for (const c of [...this.journal.created, ...reusedSpares]) this.guard.spare.push(c);
        this.guard.retries[factOf(s)] = (this.guard.retries[factOf(s)] ?? 0) + 1;
        this.guard.apply(result.guard);
        this.journal = null;
        this.save();
        this.log(`split postponed (${e.message}); ${this.guard.retries[factOf(s)] >= 3 ? "given up after 3 tries" : "will retry"}`);
        return null;
      }
    }

    // B. Local state, all at once: moves, then splits, then merges (a thread emptied by a departure merges empty).
    for (const o of ops) if (o.op === "split" && !o.skip) delete this.guard.retries[factOf(o)];
    const fromSeq = lastSeq + 1;
    const before = new Map(investigatorsFor(this.characters, this.roster).map((c) => [c.id, this.timelines.of(c.id).id]));
    for (const o of ops) if (o.op === "move") this.timelines.move(o.ids, o.to, fromSeq);
    const created = [];
    for (const o of ops) {
      if (o.op !== "split" || o.skip) continue;
      const t = this.timelines.split({ name: o.place, members: o.ids, windowId: windowFor.get(o), returnTo: [windowId], location: o.place, narrativeTime: o.time ?? "", span: o.span, opened: false, fromSeq });
      if (o.replaces) this.timelines.merge(o.replaces, t.id, fromSeq);
      created.push({ op: o, timeline: t });
    }
    for (const o of ops) if (o.op === "merge") this.timelines.merge(o.from, o.into, fromSeq);
    for (const o of ops) if (o.op === "relocate") this.timelines.relocate(o.timeline, { location: o.location, narrativeTime: o.narrativeTime });
    const after = new Map([...before.keys()].map((id) => [id, this.timelines.of(id).id]));
    const moved = [...before.keys()].filter((id) => before.get(id) !== after.get(id));
    // Co-players' seats follow their timeline's window, cut per window.
    const cut = (w) => this.windowSeq.get(w) ?? lastSeq;
    for (const id of moved) {
      const cp = this.roster.coplayers.find((c) => c.characterId === id);
      const target = this.windowOf(this.timelines.of(id));
      if (cp && target) this.roster.moveSeats([cp], [target], cut, (w) => cut(w) + 1);
    }
    this.guard.apply(result.guard);
    this.guard.commit(moved, { turn, now: this.now(), seq: lastSeq, prevOf: (id) => before.get(id), windowed: created.flatMap((c) => c.op.ids.filter((id) => this.isPc(id))) });
    this.journal = { ...this.journal, phase: "B" };
    this.checkInvariants();
    this.save();

    // C. Refresh (the new windows), then D. posts and E. arrivals. A failed refresh never stops the posts.
    try { await this.refresh(); } catch (e) { this.log(`refresh after a split failed: ${e.message}`); }
    const ignored = [...(result.ignored ?? []), ...dropped];
    const summary = [];
    for (const { op, timeline: t } of created) {
      const w = t.windowId;
      if (op.opening) await this.post(w, { content: op.opening, kind: "narration" }, { count: false });
      const leaving = op.ids.filter((id) => this.isPc(id) && before.get(id) !== t.id);
      const sources = [...new Set(leaving.map((id) => this.windowOf(this.timelines.get(before.get(id)) ?? this.timelines.main())))].filter(Boolean);
      for (const src of sources) {
        const to = leaving.filter((id) => this.windowOf(this.timelines.get(before.get(id)) ?? this.timelines.main()) === src);
        if (to.length) await this.post(src, { content: `→ "${this.windowName(w)}"`, kind: "narration", visibility: "whisper", whisper_to: to }, { count: false });
      }
      summary.push(`${op.ids.map((id) => this.nameOf(id)).join(", ")} → ${t.name} ("${this.windowName(w)}", ${t.span} split)`);
      this.scheduleArrival(w, { names: op.ids.map((id) => this.nameOf(id)), place: t.location, opening: op.opening, reunion: false }, { autonomous, mode });
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
      if (w === windowId) here = arrival;
      else this.scheduleArrival(w, arrival, { autonomous, mode });
    }
    if (!quiet && summary.length) await this.post(windowId, { content: `Timelines: ${summary.join("; ")}`, kind: "narration", visibility: "gm_only" }, { count: false });
    if (ignored.length) this.noteIgnored(windowId, ignored);
    this.journal = null;
    this.save();
    return { here, moved };
  }

  noteIgnored(windowId, ignored) {
    const text = ignored.map((i) => `${this.nameOf(i.id)} stays (${i.why})`).join("; ");
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
  async act(windowId, a, ctx, { mode, parent = mode, scope = null } = {}) {
    switch (a.type) {
      case "narrate": return this.post(windowId, { content: a.text, kind: "narration" });
      case "note": return this.post(windowId, { content: a.text, kind: "narration", visibility: "gm_only" });
      case "truth":
        if (this.improv.on && addTruth(this.improv, a.text)) { this.log(`hidden truth recorded: ${a.text.slice(0, 100)}`); this.save(); this.declare(a.text, true); }
        return 0;
      case "world_change": this.declare(a.text, a.secret === true || a.secret === "true"); return 0;
      case "text": return this.casualOn() ? this.sendText(a) : 0;
      case "npc":
      case "new_npc": {
        const who = this.characterByName(a.name);
        if (this.roster.coplayerByName(a.name) || who?.kind === "pc") { this.log(`the Keeper tried to voice ${a.name}, a ${this.roster.isCoplayer(who?.id) || !who ? "co-player" : "player character"}; skipped`); return 0; }
        const npc = this.roster.npcByName(a.name) ?? (await this.createNpc(a.name, a.brief, ctx.text));
        if (!npc || !a.text) return 0;
        return this.post(windowId, { content: a.text, kind: "ic", character_id: npc.characterId });
      }
      case "whisper": {
        const target = this.characterByName(a.to);
        if (!target) return this.post(windowId, { content: `(whisper for ${a.to}) ${a.text}`, kind: "narration", visibility: "gm_only" });
        return this.post(windowId, { content: a.text, kind: "narration", visibility: "whisper", whisper_to: [target.id] });
      }
      case "request_roll": return this.requestRoll(windowId, a, scope);
      case "split": return this.cfg.timelineAuto ? 0 : this.legacySplit(windowId, a);
      case "rejoin": return this.cfg.timelineAuto ? 0 : this.legacyRejoin(a);
      case "timeline": return this.updateTimeline(a);
      case "advance_scenario":
      case "enter_scenario": return this.changeScenario(windowId, a, mode, parent);
      default: return 0;
    }
  }

  async requestRoll(windowId, a, scope = null) {
    const command = String(a.command ?? "").trim();
    const target = this.characterByName(a.who);
    if (!ROLL.test(command) || !target) return a.text ? this.post(windowId, { content: a.text, kind: "narration" }) : 0;
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

  // ---- scenarios
  // `parent` is the turn's own mode: a followup round inside a quiet, side or arrival turn is still autonomous.
  async scenarioVerdict(windowId, mode, parent = mode) {
    if (mode === "manual") return { ok: true };
    if (!this.cfg.scenarioAuto) return { ok: false, reason: "automatic scenario changes are off" };
    if (windowId !== this.mainWindow()?.id) return { ok: false, reason: "only from the Main Chat" };
    if (!["human", "followup"].includes(mode) || !["human", "relay"].includes(parent)) return { ok: false, reason: "only right after a player's or co-player's line, never in an autonomous turn" };
    const short = this.timelines.active().find((t) => t.id !== MAIN && t.span !== "long");
    if (short) return { ok: false, reason: `the party is briefly split ("${short.name}"): bring them together first` };
    const minutes = (this.now() - (this.scenario?.since ?? 0)) / 60000;
    if (minutes < this.cfg.scenarioMinMinutes) return { ok: false, reason: `the current scenario began ${Math.floor(minutes)} min ago (at least ${this.cfg.scenarioMinMinutes})` };
    const scenes = (await this.api.scenes(this.channelId).catch(() => [])) ?? [];
    const cur = scenes.find((s) => s.id === this.channel.current_scene_id || s.id === this.scenario?.id);
    const events = Number(cur?.event_count ?? 0);
    if (cur && events < this.cfg.scenarioMinLines) return { ok: false, reason: `only ${events} lines in the current scenario (at least ${this.cfg.scenarioMinLines})` };
    return { ok: true, scenes };
  }

  async changeScenario(windowId, a, mode, parent = mode) {
    const v = await this.scenarioVerdict(windowId, mode, parent);
    if (!v.ok) return this.post(windowId, { content: `Scenario change refused: ${v.reason}.`, kind: "narration", visibility: "gm_only" });
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
      this.timelines.relocate(MAIN, { location: scene?.location || a.location, narrativeTime: scene?.narrative_time || a.narrative_time });
      this.save();
      this.log(`scenario: ${scene?.title ?? a.title ?? a.scenario} (${a.reason ?? "the story moved on"})`);
      return 0;
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
    if (cmd.cmd === "advance") return this.changeScenario(this.mainWindow().id, { type: "advance_scenario", title: cmd.title, location: cmd.location, narrative_time: cmd.time, reason: "by the operator" }, "manual");
    let reports;
    let windowId = this.mainWindow().id;
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

  // ---- casual mode: phones (casual.mjs)
  isPhone(windowId) { return Boolean(windowId) && Object.values(this.casual.phones).includes(windowId); }
  phoneOwner(windowId) { return Object.keys(this.casual.phones).find((id) => this.casual.phones[id] === windowId) ?? null; }
  // On, and allowed here: a phone is private only on an isolated channel with one player per group.
  casualOn() { return this.casual.on && !this.splitWarning; }

  async setCasual(on) {
    this.casual.on = Boolean(on);
    this.save();
    this.log(`casual mode ${this.casual.on ? "on" : "off"}${this.casual.on && this.splitWarning ? `, but not here: phones would not be private (${this.splitWarning})` : ""}`);
    if (this.casual.on) await this.ensurePhones();
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
        this.save();
        this.log(`casual: opened "${w.name}"`);
        await this.post(w.id, { content: `📱 ${c.name}'s phone. Text anyone in the story: start with @ and their name ("@Name …"). Without @, your message goes to whoever you texted last.`, kind: "narration" }, { count: false });
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
      const self = [coplayerSelf({ coplayer: cp, card: await this.card(toId), world: this.improv.on ? this.improv.world : "" }), memories.length ? `WHAT YOU REMEMBER:\n${memories.join("\n\n")}` : ""].filter(Boolean).join("\n\n");
      let r;
      try { r = await coplayerPhoneReply(this.llm, { language: this.language, self, name: cp.name, from: this.nameOf(fromId), thread, maxDelay: max }); }
      catch (e) { this.log(`co-player ${cp.name} (phone): ${e.message}`); return; }
      if (r.reply) this.queueText({ windowId, from: toId, to: fromId, text: r.reply, minutes: r.delay });
      else this.log(`casual: ${cp.name} leaves ${this.nameOf(fromId)}'s message on read`);
    } else {
      const ctx = await this.gm.build({ windowId, roster: this.roster, characters: this.characters, windows: this.windows, timelines: this.timelines, sceneOf: (w) => this.scene(w), improv: this.improv, hide: this.hiddenLines(), awayOf: (id) => this.awayOf(id) });
      const last = this.store.thread(fromId, toId, 1).at(-1);
      let plan;
      try { plan = await directTurn(this.llm, { language: this.language, context: ctx.parts, newest: null, mode: "phone", auto: this.cfg.timelineAuto, improv: this.improv.on, casual: true, phone: { from: this.nameOf(fromId), to: this.nameOf(toId), thread, text: last?.text ?? "" } }); }
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
    if (!to || !this.isPc(to.id) || !this.casual.phones[to.id]) { this.log(`text to "${a.to}" skipped: not a player character with a phone`); return 0; }
    this.queueText({ windowId: this.casual.phones[to.id], from: from.id, to: to.id, text: a.text, minutes: a.delay_minutes });
    await this.deliverDue();
    return 0;
  }

  queueText({ windowId, from, to, text, minutes = 0 }) {
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
      await this.post(p.windowId, { content: p.text, kind: "ic", character_id: p.from }, { count: false });
      this.store.addPhone({ windowId: p.windowId, from: p.from, to: p.to, text: p.text, at: now });
      this.casual.last[p.to] = p.from;   // a reply without @ goes back to whoever texted last
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
  hiddenLines() { return new Set(this.improv.published.ids); }

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
    const members = this.coplayersNamed(a.coplayers);
    if (!members.length) { this.log(`split "${a.name}": no co-player named; skipped`); return 0; }
    const name = String(a.name || "Side thread").trim().slice(0, 60);
    let window;
    try { window = await this.api.createWindow(this.channelId, { name: `Side: ${name}`, kind: "group", members: [] }); }
    catch (e) { this.log(`split "${name}": could not create the window: ${e.message}`); return 0; }
    this.roster.moveSeats(members, [window.id], this.lastSeq);
    this.timelines.split({ name, members: members.map((c) => c.characterId), windowId: window.id, returnTo: [fromWindowId], narrativeTime: a.narrative_time ?? "", location: a.location ?? "", fromSeq: this.lastSeq + 1 });
    this.save();
    await this.refresh();
    this.log(`split: ${members.map((c) => c.name).join(", ")} → "${name}"`);
    const opening = String(a.opening ?? a.text ?? "").trim();
    return opening ? this.post(window.id, { content: opening, kind: "narration" }) : 0;
  }

  async legacyRejoin(a) {
    const t = this.timelines.byName(a.timeline);
    if (!t || t.id === MAIN || t.status !== "active") { this.log(`rejoin "${a.timeline}": no such active timeline; skipped`); return 0; }
    const into = a.into ? this.windows.find((w) => norm(w.name) === norm(a.into) || w.id === a.into) : null;
    const targets = into ? [into.id] : (t.returnTo?.length ? t.returnTo : [this.mainWindow()?.id].filter(Boolean));
    const members = this.roster.coplayers.filter((c) => t.members.includes(c.characterId));
    this.roster.moveSeats(members, targets, this.lastSeq, this.lastSeq);   // they hear the line that called them back
    const dest = this.timelines.ofWindow(targets[0]) ?? (targets[0] === this.mainWindow()?.id ? this.timelines.main() : null);
    this.timelines.merge(t.id, dest?.status === "active" ? dest.id : MAIN, this.lastSeq);
    this.save();
    this.log(`rejoin: ${members.map((c) => c.name).join(", ")} ← "${t.name}"`);
    let n = 0;
    if (t.windowId) n += await this.post(t.windowId, { content: `Thread "${t.name}" rejoined the main party.`, kind: "narration", visibility: "gm_only" });
    if (a.text) n += await this.post(targets[0], { content: a.text, kind: "narration" });
    return n;
  }

  // Time, place, span and notes of a timeline. (With TIMELINE_AUTO, membership changes only through whereabouts.)
  updateTimeline(a) {
    const t = this.timelines.byName(a.timeline) ?? this.timelines.main();
    const ids = (list) => names(list).map((n) => this.investigatorByName(n)).filter(Boolean);
    const membership = this.cfg.timelineAuto ? {} : { add: ids(a.add), remove: ids(a.remove), fromSeq: this.lastSeq + 1 };
    const r = this.timelines.update(t.id, { narrativeTime: a.narrative_time, location: a.location, notes: a.notes, span: a.span, ...membership });
    if (r) this.save();
    return 0;
  }

  // ---- autonomy
  startTicker() {
    // Pending phone replies arrive on their own clock, autonomy or not.
    if (!this.phoneTimer) {
      this.phoneTimer = setInterval(() => { this.deliverDue().catch((e) => this.log(`phones: ${e.message}`)); }, 10000);
      if (this.phoneTimer.unref) this.phoneTimer.unref();
    }
    if (!this.cfg.autonomy || this.ticker) return;
    this.ticker = setInterval(() => { this.tick().catch((e) => this.log(`autonomy: ${e.message}`)); }, this.cfg.autonomyTickMs);
    if (this.ticker.unref) this.ticker.unref();
  }
  stopTicker() { clearInterval(this.ticker); this.ticker = null; clearInterval(this.phoneTimer); this.phoneTimer = null; }

  // Picks at most one window that should move on its own, and queues its turn.
  async tick() {
    if (!this.cfg.autonomy || this.pending > 0) return null;
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
      if (this.timelines.retired(w.id) || this.isPhone(w.id)) continue;   // that scene is over; a phone is no scene
      const st = this.state(w.id);
      const scene = this.scene(w.id);
      const isMain = w.id === this.mainWindow()?.id;
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
  // Investigators only (player characters and co-players): exact name first, then a unique first name.
  investigatorByName(name) {
    const n = norm(name);
    const inv = investigatorsFor(this.characters, this.roster);
    const exact = inv.find((c) => norm(c.name) === n);
    if (exact) return exact.id;
    const first = inv.filter((c) => n && norm(c.name).split(/\s+/)[0] === n.split(/\s+/)[0]);
    return first.length === 1 ? first[0].id : null;
  }

  async card(characterId) {
    if (!this.cards.has(characterId)) {
      const space = await this.api.characterSpace(this.channelId, characterId).catch(() => null);
      this.cards.set(characterId, space?.character?.role_card ?? null);
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
    let log = this.memory.coplayerRaw(coplayer, witnessed);
    while (log.length > CHUNK_LINES && estimateTokens(log.map((m) => renderLine(m)).join("\n")) > this.memory.coplayerBudget) log = log.slice(CHUNK_LINES);
    const memories = this.memory.coplayerChapters(coplayer).map((c) => `[#${c.fromSeq}–#${c.toSeq}] ${c.text}`);
    const t = this.timelines.of(me);
    const timeline = t ? { name: t.name, narrativeTime: t.narrativeTime, location: t.location } : null;
    let move;
    try {
      const companions = investigatorsFor(this.characters, this.roster, { except: me });
      const phone = this.casualOn() ? renderThread(this.store.phoneOf(me, 12), (id) => this.nameOf(id)) : "";
      move = await coplayerTurn(this.llm, { language: this.language, coplayer, card: await this.card(me), companions, withYou: this.cfg.timelineAuto ? t.members.filter((id) => id !== me) : null, log, memories, spotlight, timeline, side, world: this.improv.on ? this.improv.world : "", improv: this.improv.on, casual: this.casualOn(), phone });
    } catch (e) { this.log(`co-player ${coplayer.name}: ${e.message}`); return 0; }
    this.memory.maintainCoplayer(coplayer, witnessed, (m) => renderLine(m));
    if (move.action === "text") {
      // A co-player texts a player character first: it arrives in their phone at once.
      const to = this.characterByName(move.to);
      if (!to || !this.isPc(to.id) || !this.casual.phones[to.id]) return 0;
      this.store.addPhone({ windowId: this.casual.phones[to.id], from: me, to: to.id, text: move.text, at: this.now() });
      this.casual.last[to.id] = me;
      this.save();
      return this.post(this.casual.phones[to.id], { content: move.text, kind: "ic", character_id: me }, { count: false });
    }
    if (move.action === "speak") return this.post(windowId, { content: move.text, kind: move.kind, character_id: me });
    if (move.action === "roll") {
      let n = 0;
      if (move.text) n += await this.post(windowId, { content: move.text, kind: "ic", character_id: me });
      return n + (await this.post(windowId, { content: move.command, kind: "ic", character_id: me }));
    }
    return 0;
  }

  // `count: false` marks bookkeeping lines (pointers, notes) that do not use up the turn's action budget.
  async post(windowId, body, { count = true } = {}) {
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
