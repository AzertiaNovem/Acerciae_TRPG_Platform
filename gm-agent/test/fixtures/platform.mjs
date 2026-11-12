import { MockLlm } from "../../src/llm/mock.mjs";
import { DND_RULES } from "./dndRules.mjs";
import { PBTA_RULES } from "./pbtaRules.mjs";
export class FakeApi {
  constructor() {
    this.user = { id: "u-bot", display_name: "AI GM" };
    this.channelUsers = ["u-bot", "u-alice"];
    this.membershipWrites = 0;
    this.createdWindows = [];
    this.knowledgeMode = "public";
    this.ruleSystem = "coc7e";       // "dnd2024": the channel plays D&D
    this.initiative_ = null;         // the Main Chat's Initiative order, when set
    this.initiativeReads = 0;
    this.currentScene = "sc1";
    this.scenes_ = [{ id: "sc1", title: "The study", status: "active", event_count: 5, created_at: "2023-11-14T21:00:00Z" }];
    this.advanced = [];
    this.seq = 0;
    this.lines = [];
    this.posts = [];
    this.created = [];
    this.characters_ = [
      { id: "c-alice", name: "Alice Hale", kind: "pc", user_id: "u-alice", player_name: "alice", bio: "ALICE-BIO: raised above a print shop",
        role_card: { basic: { occupation: "ALICE-JOB journalist", age: "31" }, background: { significant_people: "ALICE-TIES: her editor, Mr. Byrne" } } },
      { id: "c-harriet", name: "Harriet Vance", kind: "pc", user_id: "u-bot", player_name: "AI GM", speaking_style: "dry wit", bio: "A sharp antiquarian.",
        role_card: { basic: { occupation: "HARRIET-JOB antiquarian" }, background: { ideology: "HARRIET-IDEOLOGY: the past teaches" } } },
      { id: "c-butler", name: "Mr. Grimsby", kind: "npc", user_id: null, speaking_style: "", bio: "The butler; knows where the key is.",
        role_card: { background: { arcane: "SECRET-NPC: serves the Society" } } },
    ];
    this.windows_ = [
      { id: "w-main", name: "Main Chat", kind: "main", members: [{ user_id: "u-bot" }, { user_id: "u-alice", character_id: "c-alice", character_name: "Alice Hale" }] },
      { id: "w-priv", name: "Alice alone", kind: "private", members: [{ user_id: "u-bot" }, { user_id: "u-alice", character_id: "c-alice" }] },
    ];
  }
  add(m) {
    const c = this.characters_.find((x) => x.id === m.character_id);
    // A character with outfits writes each line in the one they wear (the platform records it).
    const msg = { id: `m${++this.seq}`, seq: this.seq, channel_id: "ch", scene_id: this.currentScene, visibility: "window", kind: "ic", whisper_to: [], character_name: c?.name ?? null, ...(c?.outfits ? { outfit_id: c.outfit_id ?? null } : {}), ...m };
    this.lines.push(msg);
    return msg;
  }
  async me() { return this.user; }
  async channel() { return { id: "ch", server_id: "s", name: "Hale house", my_role: "gm", era: "1920s", current_scene_id: this.currentScene, knowledge_mode: this.knowledgeMode, rule_system: this.ruleSystem, point_buy: this.pointBuy ?? false, illustrations_enabled: this.channelIllustrations ?? true }; }
  async dndRules() { return DND_RULES; }
  async pbtaRules() { return PBTA_RULES; }
  async pbtaRulings() { return []; }
  async initiative(_ch, w) { this.initiativeReads++; return w === "w-main" && this.initiative_ ? structuredClone(this.initiative_) : { round: 0, turn: 0, entries: [] }; }
  async initiativeAction(_ch, w, body) { (this.initiativeActions ??= []).push({ window: w, ...body }); return this.initiative(_ch, w); }
  async channelMembers() { return this.channelUsers.map((id) => ({ id, role: id === "u-bot" ? "gm" : "player", display_name: id.slice(2) })); }
  async addWindowMember(_ch, w, body) {
    this.membershipWrites++;
    (this.addedMembers ??= []).push({ window: w, ...body });
    const win = this.windows_.find((x) => x.id === w);
    if (win && body?.user_id && !win.members.some((m) => m.user_id === body.user_id)) win.members.push({ user_id: body.user_id, character_id: this.characters_.find((c) => c.user_id === body.user_id && c.kind === "pc")?.id ?? null });
    return [];
  }
  async serverSettings() { return { language: "en", features: this.serverIllustrations === false ? { illustrations: false } : {} }; }
  async coc7Rules() { return { skills: [{ name: "Spot Hidden", base: 25, names: {} }], families: [] }; }
  async characters() { return structuredClone(this.characters_); }
  async windows() { return structuredClone(this.windows_.map((w) => ({ ...w, last_seq: Math.max(0, ...this.lines.filter((m) => m.chat_window_id === w.id).map((m) => m.seq)) }))); }
  async messages(_ch, w, limit, beforeSeq = 0) { return this.lines.filter((m) => m.chat_window_id === w && (!beforeSeq || m.seq < beforeSeq)).slice(-limit); }
  // Illustrations: one picture in flight per account; `holdIllustrations` keeps the next ones drawing, `noImages` is a
  // server without an image provider. A finished picture is posted as the account's ooc line in the window.
  async illustrate(_ch, w, body) {
    if (this.releaseIllustrations) for (const j of this.illustrations_ ?? []) if (j.status === "pending") this.finishIllustration(j);
    if (this.noImages) throw Object.assign(new Error("POST illustrations: 400 bad_request image generation disabled or not configured by the server maintainer"), { status: 400 });
    // `serverIllustrations` / `channelIllustrations` false: the server's maintainers or the GM turned drawing off.
    if (this.serverIllustrations === false || this.channelIllustrations === false) throw Object.assign(new Error("POST illustrations: 403 feature_disabled turned off"), { status: 403, code: "feature_disabled" });
    this.illustrations_ ??= [];
    if (this.illustrations_.some((j) => ["pending", "running"].includes(j.status))) throw Object.assign(new Error("POST illustrations: 409 conflict your previous illustration is still being drawn"), { status: 409 });
    const job = { id: `ill${this.illustrations_.length + 1}`, status: "pending", window_id: w, prompt: body.prompt, character_ids: body.character_ids, orientation: body.orientation, allow_cloud: body.allow_cloud, outfits: body.outfits, message_id: null };
    this.illustrations_.push(job);
    if (!(this.holdIllustrations > 0)) this.finishIllustration(job);
    else this.holdIllustrations--;
    return { id: job.id, status: job.status, kind: "illustration" };
  }
  finishIllustration(job) {
    job.status = "completed";
    job.message_id = this.add({ chat_window_id: job.window_id, author_id: "u-bot", author_role: "gm", kind: "ooc", content: `🖼️ ${job.prompt}`, media_asset_id: `asset-${job.id}` }).id;
  }
  async illustrations() {
    for (const j of this.illustrations_ ?? []) if (j.status === "pending" && this.releaseIllustrations) this.finishIllustration(j);
    return [...(this.illustrations_ ?? [])].reverse();
  }
  async cancelIllustration(_ch, id) {
    const j = this.illustrations_.find((x) => x.id === id);
    if (!["pending", "running"].includes(j.status)) throw Object.assign(new Error("409 not cancellable"), { status: 409 });
    j.status = "cancelled";
  }
  // The platform's recall: the author's line becomes a tombstone; rolls stay on the record.
  async recallMessage(_ch, id) {
    const i = this.lines.findIndex((m) => m.id === id);
    if (i < 0) throw Object.assign(new Error("message not found"), { status: 404, code: "not_found" });
    const m = this.lines[i];
    if (m.kind === "roll") throw Object.assign(new Error("Dice rolls cannot be recalled"), { status: 409, code: "not_recallable" });
    const tombstone = { ...m, content: "", dice: null, recalled_at: "2026-11-07T00:00:00Z", recall_seconds_left: null };
    this.lines[i] = tombstone; (this.recalled ??= []).push(id);
    return { message: tombstone, content: m.content };
  }
  async postMessage(_ch, w, body) {
    this.posts.push({ window: w, ...body });
    const roll = body.content.startsWith(".");
    return this.add({ chat_window_id: w, author_id: "u-bot", author_role: "gm", ...body, kind: roll ? "roll" : body.kind, ...(roll ? { dice: { text: `[fake dice] ${body.content}` } } : {}) });
  }
  async characterSpace(_ch, cid) {
    if (this.ruleSystem === "dnd2024") return { character: { id: cid, role_card: { basic: { age: "24", sex: "female" }, dnd: { ...new MockLlm().dndBuild(), level: 3, saves: ["DEX", "INT"], ac: 14, hp_max: 24, speed: 30, hit_dice: "3d8", slots: {} } } }, attrs: { HP: 20 }, rule_system: "dnd2024" };
    return { character: { id: cid, role_card: { characteristics: { INT: 70 }, skills: { "Spot Hidden": 60 } } } };
  }
  async playerGroups() { return this.groups ?? []; }
  async world() { if (this.noWorld) throw Object.assign(new Error("not found"), { status: 404 }); return this.world_ ?? { version: 0, entities: [], recent_changes: [] }; }
  async declareWorld(_ch, body) { if (this.noWorld) throw Object.assign(new Error("not found"), { status: 404 }); (this.declared ??= []).push(body); return { event_id: `ev${this.declared.length}`, seq: 0 }; }
  async createWindow(_ch, body) {
    for (const m of body.members ?? []) if (!this.channelUsers.includes(m.user_id)) throw Object.assign(new Error("user is not a channel member"), { status: 400 });
    this.createAttempts = (this.createAttempts ?? 0) + 1;
    if (this.failAfter !== undefined && this.createAttempts > this.failAfter) throw Object.assign(new Error("upstream down"), { status: 502 });
    if (this.failCreate) throw Object.assign(new Error("upstream down"), { status: 502 });
    if ((body.members ?? []).length) this.membershipWrites++;
    const w = { id: `w-new${this.windows_.length}`, kind: body.kind, name: body.name, members: [{ user_id: "u-bot" }, ...(body.members ?? []).map((m) => ({ ...m, character_name: this.characters_.find((c) => c.id === m.character_id)?.name }))] };
    this.windows_.push(w); this.createdWindows.push(w); return structuredClone(w);
  }
  async forkWindow(ch, parent, body) {
    const existing = this.windows_.find(w => w.fork_request_id === body.request_id);
    if (existing) return structuredClone(existing);
    const w = await this.createWindow(ch, body);
    const saved = this.windows_.find(x => x.id === w.id);
    Object.assign(saved, { fork_parent_id: parent, fork_seq: this.seq, fork_request_id: body.request_id });
    if (this.loseForkResponse) { this.loseForkResponse = false; throw Error('fork response lost'); }
    return structuredClone(saved);
  }
  async setWindowVisibility(_ch, id, user, paused) {
    const win = this.windows_.find(w => w.id === id);
    const member = win?.members.find(m => m.user_id === user);
    if (!member) throw Error("not a member");
    member.visibility_paused = paused;
    (this.visibilityChanges ??= []).push({ id, user, paused });
    return win.members;
  }
  async updateWindow(_ch, id, body) {
    const w = this.windows_.find(w => w.id === id);
    if (!w) throw Error('unknown window');
    if ('archived' in body) w.archived_at = body.archived ? '2026-11-05T00:00:00Z' : null;
    if (body.name) w.name = body.name;
    return structuredClone(w);
  }
  async advanceScenario(_ch, body) { const scene = { id: `sc${this.scenes_.length + 1}`, title: body.title, status: "active", location: body.location, narrative_time: body.narrative_time, event_count: 0, created_at: new Date().toISOString() }; for (const x of this.scenes_) if (x.id === this.currentScene) x.status = "closed"; this.scenes_.push(scene); this.currentScene = scene.id; this.advanced.push(body); return { scene }; }
  async enterScenario(_ch, id) { for (const x of this.scenes_) if (x.id === this.currentScene) x.status = "closed"; this.currentScene = id; this.advanced.push({ entered: id }); return { scene: this.scenes_.find((x) => x.id === id) }; }
  async createCharacter(_ch, body) { const c = { id: `c-new${this.created.length}`, user_id: body.kind === "pc" ? this.user.id : null, ...body }; this.created.push(c); this.characters_.push(c); return c; }
  async putCard() { return {}; }
  async putAppearance() { return {}; }
  async scenes() { return structuredClone(this.scenes_); }
  async kpBoard() { return { next: { current: "SECRET-BOARD: the key is under the clock" }, notes: {} }; }
  async reminders() { return [{ kind: "forgotten", title: "SECRET-REMINDER", why: "the badge from the docks" }]; }
  async scriptKnowledge() { return [{ kind: "flow", position: 1, status: "active", title: "Hale house", body: "SECRET-SCRIPT stage body" }]; }
  async documents() { return [{ id: "d1", doc_type: "clue_journal", title: "Clue Journal", version: 3, entry_count: 1 }]; }
  async document() { return { markdown: "- SECRET-DOC: lantern sigil" }; }
  async highlights() { return []; }
  async moduleHints() { return []; }
  async proposals() { return []; }
}
