// The table loop. A line from a real person starts a turn (after a short quiet period): first the GM and the real
// NPCs act with the Keeper's context, then the co-players seated in that window act, each with only its own chat log.
// Lines this client posts never start a turn, so it cannot talk to itself.
import { GmContext } from "./context/gmContext.mjs";
import { coplayerLog } from "./context/coplayerContext.mjs";
import { directTurn } from "./director.mjs";
import { coplayerTurn } from "./coplayer.mjs";
import { generateNpc, saveCharacter } from "./roles/cardgen.mjs";

const LANGUAGES = { en: "English", zh: "Simplified Chinese", "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French", de: "German", ru: "Russian", pt: "Portuguese", it: "Italian" };
export const languageName = (code) => LANGUAGES[code] ?? LANGUAGES[String(code ?? "").split("-")[0]] ?? (code || "English");

const ROLL = /^\.(ra|rc|r|sc)(\s|$)/i;
const TRIGGER_KINDS = new Set(["ic", "ooc", "roll", "narration"]);
const norm = (s) => String(s ?? "").trim().toLowerCase();

export class Table {
  constructor({ api, llm, cfg, channelId, roster, persist = () => {}, log = () => {}, sleep }) {
    this.api = api;
    this.llm = llm;
    this.cfg = cfg;
    this.channelId = channelId;
    this.roster = roster;
    this.persist = persist;
    this.log = log;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.gm = new GmContext(api, channelId, { contextLines: cfg.contextLines, log });
    this.botMessageIds = new Set();
    this.timers = new Map();
    this.queue = Promise.resolve();
    this.cards = new Map();
    this.turns = 0;
  }

  async init() {
    this.me = this.api.user ?? (await this.api.me());
    this.channel = await this.api.channel(this.channelId);
    if (this.channel.my_role !== "gm") throw new Error(`the client's account is not the GM of channel ${this.channelId}`);
    const settings = await this.api.serverSettings(this.channel.server_id).catch(() => null);
    this.language = languageName(this.cfg.language || settings?.language || "en");
    this.rules = await this.api.coc7Rules().catch(() => null);
    await this.refresh();
    return this;
  }

  async refresh() {
    [this.characters, this.windows] = await Promise.all([this.api.characters(this.channelId), this.api.windows(this.channelId)]);
    const main = this.windows.find((w) => w.kind === "main") ?? this.windows[0];
    this.roster.reconcile(this.characters, main ? [main.id] : []);
  }

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
    if (this.botMessageIds.has(m.id) || m.author_id === this.me?.id) return false;
    return m.visibility === "window" && TRIGGER_KINDS.has(m.kind);
  }

  // Returns the scheduled turn (settled when it ran), or undefined when the line starts no turn.
  onMessage(m) {
    if (!this.isTrigger(m)) return undefined;
    return this.schedule(m.chat_window_id);
  }

  // Waits for a quiet moment in the window, then queues one turn (turns run one at a time). A line arriving before the
  // turn starts restarts the wait; every caller's promise settles when that one turn has run.
  schedule(windowId, { kickoff = false, delay = this.cfg.debounceMs } = {}) {
    const pending = this.timers.get(windowId) ?? { resolvers: [], kickoff: false };
    clearTimeout(pending.timer);
    pending.kickoff ||= kickoff;
    this.timers.set(windowId, pending);
    return new Promise((resolve) => {
      pending.resolvers.push(resolve);
      pending.timer = setTimeout(() => {
        this.timers.delete(windowId);
        const done = () => { for (const r of pending.resolvers) r(); };
        this.queue = this.queue.then(() => this.turn(windowId, { kickoff: pending.kickoff })).catch((e) => this.log(`turn failed: ${e.message}`)).then(done);
      }, delay);
    });
  }

  // ---- one turn
  async turn(windowId, { kickoff = false } = {}) {
    this.turns++;
    await this.refresh();
    let budget = this.cfg.maxActionsPerTurn;
    const ctx = await this.gm.build({ windowId, roster: this.roster, characters: this.characters, windows: this.windows });
    const plan = await directTurn(this.llm, { language: this.language, contextText: ctx.text, newest: ctx.newest, kickoff });
    this.log(`turn ${this.turns}: ${plan.actions.length} Keeper action(s), co-players ${plan.coplayersMayAct ? "may act" : "wait"}`);
    for (const action of plan.actions) {
      if (budget <= 0) break;
      budget -= await this.act(windowId, action, ctx);
    }
    if (!plan.coplayersMayAct) return;
    const seated = this.roster.coplayersIn(windowId);
    const first = seated.filter((c) => plan.spotlight.some((n) => norm(n) === norm(c.name)));
    for (const c of [...first, ...seated.filter((x) => !first.includes(x))]) {
      if (budget <= 0) break;
      budget -= await this.coplayerAct(windowId, c, first.includes(c));
    }
  }

  // The Keeper's moves. Returns how many lines were posted.
  async act(windowId, a, ctx) {
    switch (a.type) {
      case "narrate": return this.post(windowId, { content: a.text, kind: "narration" });
      case "note": return this.post(windowId, { content: a.text, kind: "narration", visibility: "gm_only" });
      case "npc":
      case "new_npc": {
        if (this.roster.coplayerByName(a.name)) { this.log(`the Keeper tried to voice co-player ${a.name}; skipped`); return 0; }
        const npc = this.roster.npcByName(a.name) ?? (await this.createNpc(a.name, a.brief, ctx.text));
        if (!npc || !a.text) return 0;
        return this.post(windowId, { content: a.text, kind: "ic", character_id: npc.characterId });
      }
      case "whisper": {
        const target = this.characterByName(a.to);
        if (!target) return this.post(windowId, { content: `(whisper for ${a.to}) ${a.text}`, kind: "narration", visibility: "gm_only" });
        return this.post(windowId, { content: a.text, kind: "narration", visibility: "whisper", whisper_to: [target.id] });
      }
      case "request_roll": return this.requestRoll(windowId, a);
      default: return 0;
    }
  }

  async requestRoll(windowId, a) {
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
    return this.post(windowId, { content: `${a.text ? `${a.text}\n` : ""}→ ${target.name}: ${command}`, kind: "narration" });
  }

  async createNpc(name, brief, gmContext) {
    if (!String(name ?? "").trim()) return null;
    const generated = await generateNpc(this.llm, { language: this.language, era: this.channel.era, rules: this.rules, name, brief, gmContext: gmContext.slice(-6000) });
    generated.name = name;
    generated.brief = brief || generated.persona;
    const saved = await saveCharacter(this.api, this.channelId, generated, { kind: "npc", rules: this.rules });
    const entry = { characterId: saved.id, name: saved.name, brief: brief || saved.persona };
    this.roster.npcs.push(entry);
    this.persist(this.roster);
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

  // A co-player's move, from its own witnessed chat only.
  async coplayerAct(windowId, coplayer, spotlight) {
    const messages = [];
    for (const w of coplayer.windows) messages.push(...((await this.api.messages(this.channelId, w, this.cfg.contextLines).catch(() => [])) ?? []));
    const log = coplayerLog(coplayer, messages, this.cfg.contextLines);
    let move;
    try {
      move = await coplayerTurn(this.llm, { language: this.language, coplayer, card: await this.card(coplayer.characterId), log, spotlight });
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
      if (this.cfg.verbose) this.log(`posted ${body.kind}${body.visibility && body.visibility !== "window" ? `/${body.visibility}` : ""}: ${body.content.slice(0, 100)}`);
      await this.sleep(this.cfg.postDelayMs);
      return 1;
    } catch (e) {
      this.log(`post failed (${e.code || e.status}): ${e.message}`);
      return 0;
    }
  }
}
