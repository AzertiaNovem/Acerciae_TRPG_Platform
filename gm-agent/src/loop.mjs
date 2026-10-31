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
import { GmContext } from "./context/gmContext.mjs";
import { coplayerLog } from "./context/coplayerContext.mjs";
import { investigatorsFor } from "./context/profiles.mjs";
import { directTurn } from "./director.mjs";
import { coplayerTurn } from "./coplayer.mjs";
import { generateNpc, saveCharacter } from "./roles/cardgen.mjs";
import { openWindows } from "./roles/roster.mjs";
import { Timelines, MAIN, placeKey } from "./timelines.mjs";
import { Guard, planWhereabouts, whereaboutsBrief } from "./whereabouts.mjs";

const LANGUAGES = { en: "English", zh: "Simplified Chinese", "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French", de: "German", ru: "Russian", pt: "Portuguese", it: "Italian" };
export const languageName = (code) => LANGUAGES[code] ?? LANGUAGES[String(code ?? "").split("-")[0]] ?? (code || "English");

const ROLL = /^\.(ra|rc|r|sc)(\s|$)/i;
const TRIGGER_KINDS = new Set(["ic", "ooc", "roll", "narration"]);
const SPEAKER_KINDS = new Set(["ic", "roll", "narration"]);       // lines that let a player's character move (not OOC)
const MOVE_MODES = new Set(["human", "followup", "side", "relay", "manual"]);
const norm = (s) => String(s ?? "").trim().toLowerCase();
const names = (v) => (Array.isArray(v) ? v : [v]).map((x) => String(x ?? "").trim()).filter(Boolean);
const HOUR = 3600000;

export class Table {
  // `deferArrivals`: a short-lived CLI process records arrivals in the state file for the `run` process to play.
  constructor({ api, llm, cfg, channelId, roster, timelines, guard, scenario = null, journal = null, owedArrivals = [], deferArrivals = false, persist = () => {}, log = () => {}, sleep, now = Date.now }) {
    this.api = api;
    this.llm = llm;
    this.cfg = cfg;
    this.channelId = channelId;
    this.roster = roster;
    this.now = now;
    this.timelines = timelines ?? new Timelines([], { now });
    this.guard = guard ?? new Guard();
    this.scenario = scenario;            // {id, since}: when the client saw the current scenario begin
    this.journal = journal;              // an applyPlan in progress, for roll-forward after a crash
    this.owedArrivals = [...owedArrivals];
    this.deferArrivals = deferArrivals;
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
    this.windowSeq = new Map();      // windowId → newest line seen there (seat cut points)
    this.speakers = new Map();       // windowId → [{id, seq, content}] player lines since that window's last turn
    // Autonomy bookkeeping: when humans last spoke (channel and per window), when each window last got a turn.
    this.lastHumanAt = 0;
    this.windowState = new Map();   // windowId → {lastLineAt, lastHumanAt, lastTurnAt, quietTurns}
    this.autonomousTurns = [];      // timestamps of the last hour's autonomous turns
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
    this.roster.reconcile(this.characters, main ? [main.id] : []);
    this.timelines.reconcile(investigatorsFor(this.characters, this.roster).map((c) => c.id));
  }

  mainWindow() { return this.windows.find((w) => w.kind === "main") ?? this.windows[0]; }
  windowName(id) { return this.windows.find((w) => w.id === id)?.name ?? "another window"; }
  nameOf(id) { return this.characters.find((c) => c.id === id)?.name ?? id; }
  isPc(id) { return this.characters.find((c) => c.id === id)?.kind === "pc"; }
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
    this.noteSeq(m.chat_window_id, m.seq ?? 0);
    if (this.isHuman(m)) {
      st.lastHumanAt = Math.max(st.lastHumanAt, at);
      st.quietTurns = 0;
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
    else if (!existing || mode === "arrival" || mode === "relay") { pending.mode = mode; pending.extra = { ...(existing?.extra ?? {}), ...extra }; }
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
      const ctx = await this.gm.build({ windowId, roster: this.roster, characters: this.characters, windows: this.windows, timelines: this.timelines, sceneOf: (w) => this.scene(w) });
      const scope = new Set([...(scene?.members ?? []), ...visitorsIn]);
      const mayMove = [...scope].filter((id) => (this.isPc(id) ? ["human", "relay"].includes(roundMode) && speakerIds.has(id) : ["followup", "side"].includes(roundMode)));
      const whereabouts = this.cfg.timelineAuto && scene
        ? whereaboutsBrief({ timelines: this.timelines, scene: { timeline: scene }, nameOf: (id) => this.nameOf(id), windowName: (id) => this.windowName(id), isPc: (id) => this.isPc(id), mayMove, capReached: this.timelines.active().length >= this.cfg.timelineMaxActive })
        : "";
      const verdict = await this.scenarioVerdict(windowId, roundMode, mode);
      const scenario = this.cfg.scenarioAuto ? `Scenario change: ${verdict.ok ? "possible this turn, if the story as a whole has moved on." : `not this turn (${verdict.reason}).`}` : "";
      const plan = await directTurn(this.llm, { language: this.language, contextText: ctx.text, newest: ctx.newest, mode: roundMode, kickoff: roundMode === "kickoff", timeline, whereabouts, scenario, auto: this.cfg.timelineAuto, ...roundExtra });
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
    let plan = await round(kickoff ? "kickoff" : mode, extra);
    if (here) { const arrival = here; here = null; plan = await round("arrival", { arrival }); }
    if (!this.scene(windowId) && sceneThread) return;                    // this window's scene just ended
    const side = mode === "side" || (mode === "arrival" && !this.presentPlayers(windowId).length);
    if (!plan.coplayersMayAct && !side) return;
    const seated = this.roster.coplayersIn(windowId);
    const first = seated.filter((c) => plan.spotlight.some((n) => norm(n) === norm(c.name)));
    let acted = 0;
    for (const c of [...first, ...seated.filter((x) => !first.includes(x))]) {
      if (budget <= 0) break;
      const n = await this.coplayerAct(windowId, c, first.includes(c), { side });
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
        if (now - this.lastHumanAt > this.cfg.autonomyIdleMinutes * 60000 || this.autonomousTurns.length >= this.cfg.autonomyMaxTurnsPerHour) { this.log("arrival skipped: autonomy paused"); return null; }
      }
    }
    this.arrivalTimes.push(now);
    return this.schedule(windowId, { mode: "arrival", delay: 0, arrival, autonomous });
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
    this.autonomousTurns = this.autonomousTurns.filter((t) => now - t < HOUR);
    if (this.autonomousTurns.length >= this.cfg.autonomyMaxTurnsPerHour) return null;
    const candidates = [];
    for (const w of this.windows) {
      if (this.timelines.retired(w.id)) continue;           // that scene is over
      const st = this.state(w.id);
      const scene = this.scene(w.id);
      const isMain = w.id === this.mainWindow()?.id;
      const humans = this.presentPlayers(w.id).length > 0;
      const sinceLine = now - Math.max(st.lastLineAt, st.lastTurnAt);
      if (scene && !isMain && !humans && this.roster.coplayersIn(w.id).length) {
        if (sinceLine >= this.cfg.autonomySideIntervalMs) candidates.push({ w, mode: "side", waited: sinceLine, extra: { timeline: scene } });
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
    const messages = [];
    for (const w of new Set(coplayer.seats.map((s) => s.windowId))) messages.push(...((await this.api.messages(this.channelId, w, this.cfg.contextLines).catch(() => [])) ?? []));
    const me = coplayer.characterId;
    const log = coplayerLog(coplayer, messages, this.cfg.contextLines).filter((m) => !(m.character_id && this.isPc(m.character_id) && this.timelines.timelineAt(m.character_id, m.seq).id !== this.timelines.timelineAt(me, m.seq).id));
    const t = this.timelines.of(me);
    const timeline = t ? { name: t.name, narrativeTime: t.narrativeTime, location: t.location } : null;
    let move;
    try {
      const companions = investigatorsFor(this.characters, this.roster, { except: me });
      move = await coplayerTurn(this.llm, { language: this.language, coplayer, card: await this.card(me), companions, withYou: this.cfg.timelineAuto ? t.members.filter((id) => id !== me) : null, log, spotlight, timeline, side });
    } catch (e) { this.log(`co-player ${coplayer.name}: ${e.message}`); return 0; }
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
