import { test } from "node:test";
import assert from "node:assert/strict";
import { Table } from "../src/loop.mjs";
import { Roster, markStyle } from "../src/roles/roster.mjs";
import { MockLlm } from "../src/llm/mock.mjs";
import { buildConfig } from "../src/config.mjs";

// An in-memory stand-in for the platform, as the Keeper account sees it (every line, every AI tip).
class FakeApi {
  constructor() {
    this.user = { id: "u-bot", display_name: "AI Keeper" };
    this.channelUsers = ["u-bot", "u-alice"];
    this.membershipWrites = 0;
    this.createdWindows = [];
    this.knowledgeMode = "public";
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
      { id: "c-harriet", name: "Harriet Vance", kind: "pc", user_id: "u-bot", player_name: "AI Keeper", speaking_style: "dry wit", bio: "A sharp antiquarian.",
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
    const msg = { id: `m${++this.seq}`, seq: this.seq, channel_id: "ch", visibility: "window", kind: "ic", whisper_to: [], character_name: c?.name ?? null, ...m };
    this.lines.push(msg);
    return msg;
  }
  async me() { return this.user; }
  async channel() { return { id: "ch", server_id: "s", name: "Hale house", my_role: "gm", era: "1920s", current_scene_id: this.currentScene, knowledge_mode: this.knowledgeMode }; }
  async channelMembers() { return this.channelUsers.map((id) => ({ id, role: id === "u-bot" ? "gm" : "player", display_name: id.slice(2) })); }
  async addWindowMember(_ch, w, body) {
    this.membershipWrites++;
    (this.addedMembers ??= []).push({ window: w, ...body });
    const win = this.windows_.find((x) => x.id === w);
    if (win && body?.user_id && !win.members.some((m) => m.user_id === body.user_id)) win.members.push({ user_id: body.user_id, character_id: this.characters_.find((c) => c.user_id === body.user_id && c.kind === "pc")?.id ?? null });
    return [];
  }
  async serverSettings() { return { language: "en", features: {} }; }
  async coc7Rules() { return { skills: [{ name: "Spot Hidden", base: 25, names: {} }], families: [] }; }
  async characters() { return structuredClone(this.characters_); }
  async windows() { return structuredClone(this.windows_.map((w) => ({ ...w, last_seq: Math.max(0, ...this.lines.filter((m) => m.chat_window_id === w.id).map((m) => m.seq)) }))); }
  async messages(_ch, w, limit, beforeSeq = 0) { return this.lines.filter((m) => m.chat_window_id === w && (!beforeSeq || m.seq < beforeSeq)).slice(-limit); }
  async postMessage(_ch, w, body) {
    this.posts.push({ window: w, ...body });
    return this.add({ chat_window_id: w, author_id: "u-bot", author_role: "gm", ...body, kind: body.content.startsWith(".") ? "roll" : body.kind });
  }
  async characterSpace(_ch, cid) { return { character: { id: cid, role_card: { characteristics: { INT: 70 }, skills: { "Spot Hidden": 60 } } } }; }
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

const SECRETS = ["SECRET-ONE", "SECRET-TWO", "SECRET-THREE", "SECRET-BOARD", "SECRET-REMINDER", "SECRET-SCRIPT", "SECRET-DOC"];

async function table({ llm = new MockLlm(), cfg: over = {}, extraCharacters = [], clock = { t: 1_700_000_000_000 }, bob = false, improv = null, casual = null, heal = false } = {}) {
  const api = new FakeApi();
  api.characters_.push(...extraCharacters);
  if (bob) {
    // A second player who stays in the Main Chat.
    api.characters_.push({ id: "c-bob", name: "Bob Price", kind: "pc", user_id: "u-bob", player_name: "bob", role_card: {} });
    api.windows_[0].members.push({ user_id: "u-bob", character_id: "c-bob", character_name: "Bob Price" });
    api.channelUsers.push("u-bob");
  }
  // The seeded lines are an hour old: a window nobody has spoken in for a while must not be revived by autonomy.
  const old = (m) => api.add({ created_at: new Date(clock.t - 60 * 60000).toISOString(), ...m });
  old({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "KEEPER NOTE SECRET-ONE: the clock hides the key", visibility: "gm_only" });
  old({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "SECRET-TWO: you alone hear a whisper", visibility: "whisper", whisper_to: ["c-alice"] });
  old({ chat_window_id: "w-priv", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: "SECRET-THREE in Alice's own window" });
  old({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "The study is cold and smells of pipe smoke." });
  // The story planner is off unless a test turns it on (pcfg): with no date set, it would plan after the first line.
  const base = buildConfig({}, {});
  const cfg = { ...base, debounceMs: 0, postDelayMs: 0, planner: { ...base.planner, enabled: false }, ...over };
  const t = await new Table({ api, llm, cfg, channelId: "ch", roster: new Roster(), improv, casual, sleep: async () => {}, now: () => clock.t, log: process.env.TEST_LOG ? console.log : () => {} }).init({ heal });
  return { t, api, llm, clock };
}
const playerSays = (t, api, content, w = "w-main") => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: w, author_id: "u-alice", author_role: "player", character_id: "c-alice", content }) });

test("co-players and real NPCs are told apart from the platform's characters", async () => {
  const { t } = await table();
  assert.deepEqual(t.roster.coplayers.map((c) => [c.name, c.seats]), [["Harriet Vance", [{ windowId: "w-main", fromSeq: 0, toSeq: null }]]]);
  assert.deepEqual(t.timelines.main().members.sort(), ["c-alice", "c-harriet"], "every investigator starts in the main timeline");
  assert.deepEqual(t.roster.npcs.map((c) => c.name), ["Mr. Grimsby"]);
});

test("a player's line starts one turn: the Keeper answers with the whole Keeper context, the co-player only with its chat log", async () => {
  const { t, api, llm } = await table();
  await playerSays(t, api, "I open the desk drawer.");
  const director = llm.calls.find((c) => c.purpose === "director");
  const gmPrompt = director.messages[0].content;
  for (const s of SECRETS) assert.ok(gmPrompt.includes(s), `the Keeper sees ${s}`);
  const coplayer = llm.calls.filter((c) => c.purpose === "coplayer_turn");
  assert.equal(coplayer.length, 1);
  const cpPrompt = coplayer[0].system + coplayer[0].messages.map((m) => m.content).join("\n");
  assert.ok(cpPrompt.includes("I open the desk drawer."), "the co-player reads the table");
  assert.ok(cpPrompt.includes("The study is cold"), "and the Keeper's public narration");
  for (const s of SECRETS) assert.ok(!cpPrompt.includes(s), `the co-player never sees ${s}`);
  assert.deepEqual(api.posts.map((p) => [p.kind, p.character_id ?? null]), [["narration", null], ["ic", "c-harriet"], ["narration", null]], "GM, co-player, then the GM's immediate answer to the co-player");
  const followup = llm.calls.filter((c) => c.purpose === "director")[1].messages[0].content;
  assert.ok(followup.includes("MODE: followup"), "the follow-up round is told the co-players just acted");
  assert.ok(followup.includes("NEWEST LINE: Harriet Vance"), "and sees their lines as the newest");
});

test("lines the client posts never start a turn", async () => {
  const { t, api } = await table();
  await playerSays(t, api, "Hello?");
  const turns = t.turns;
  for (const m of api.lines.filter((x) => x.author_id === "u-bot")) assert.equal(t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: m }), undefined);
  assert.equal(t.turns, turns);
});

test("the Keeper voices and creates real NPCs, never co-players; rolls for its own characters go to the platform's dice", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => user.includes("NEWEST LINE") ? {
    actions: [
      { type: "new_npc", name: "Mrs. Pell", brief: "the landlady", text: "Wipe your feet." },
      { type: "npc", name: "Harriet Vance", text: "I, the Keeper, speak for Harriet." },
      { type: "npc", name: "Mr. Grimsby", text: "Sir rang?" },
      { type: "request_roll", who: "Harriet Vance", command: ".ra Spot Hidden", text: "Harriet, look around." },
      { type: "request_roll", who: "Alice Hale", command: ".ra Library Use", text: "Alice, the shelves." },
      { type: "whisper", to: "Alice Hale", text: "You feel watched." },
    ],
    coplayers_may_act: false,
  } : base(user);
  const { t, api } = await table({ llm });
  await playerSays(t, api, "I ring the bell.");
  assert.equal(api.created.length, 1);
  assert.equal(api.created[0].kind, "npc");
  assert.ok(t.roster.npcByName("Mrs. Pell"));
  assert.ok(llm.calls.some((c) => c.purpose === "npc_card"));
  const lines = api.posts.map((p) => `${p.character_id ?? "keeper"}|${p.visibility ?? "window"}|${p.content}`);
  assert.deepEqual(lines, [
    "c-new0|window|Wipe your feet.",
    "c-butler|window|Sir rang?",
    "keeper|window|Harriet, look around.",
    "c-harriet|window|.ra Spot Hidden",
    "keeper|window|Alice, the shelves.\n→ Alice Hale: .ra Library Use",
    "keeper|whisper|You feel watched.",
  ]);
  assert.deepEqual(api.posts.at(-1).whisper_to, ["c-alice"]);
  assert.ok(!lines.some((l) => l.includes("I, the Keeper, speak for Harriet")));
  assert.equal(llm.calls.filter((c) => c.purpose === "coplayer_turn").length, 0, "co-players wait when the Keeper says so");
});

test("a turn posts at most MAX_ACTIONS_PER_TURN lines", async () => {
  const llm = new MockLlm();
  llm.director = () => ({ actions: Array.from({ length: 10 }, (_, i) => ({ type: "narrate", text: `line ${i}` })), coplayers_may_act: true });
  const { t, api } = await table({ llm, cfg: { maxActionsPerTurn: 3 } });
  await playerSays(t, api, "Go on.");
  assert.equal(api.posts.length, 3);
});

test("a co-player seated elsewhere does not act in this window", async () => {
  const { t, api, llm } = await table();
  await playerSays(t, api, "Alone, I search the room.", "w-priv");
  assert.equal(llm.calls.filter((c) => c.purpose === "coplayer_turn").length, 0);
  assert.equal(api.posts.length, 1);
});

test("--kickoff opens the session without waiting for a player", async () => {
  const { t, api, llm } = await table();
  await t.schedule("w-main", { kickoff: true, delay: 0 });
  assert.ok(llm.calls.find((c) => c.purpose === "director").messages[0].content.includes("KICKOFF: yes"));
  assert.equal(api.posts[0].kind, "narration");
});

test("lines in quick succession make one turn, and every caller learns when it ran", async () => {
  const { t, api, llm } = await table({ cfg: { debounceMs: 30 } });
  const a = playerSays(t, api, "First thought.");
  const b = playerSays(t, api, "Second thought.");
  await Promise.all([a, b]);
  assert.equal(t.turns, 1);
  assert.ok(llm.calls.find((c) => c.purpose === "director").messages[0].content.includes("NEWEST LINE: Alice Hale: Second thought."));
});

test("the investigators' basic details and backgrounds reach the Keeper and the co-players, real NPCs' details only the Keeper", async () => {
  const tomas = { id: "c-tomas", name: "Tomas Leclerc", kind: "pc", user_id: "u-bot", speaking_style: "eager", bio: "TOMAS-BIO: a reporter who owes Alice",
    role_card: { basic: { occupation: "TOMAS-JOB photographer" }, background: { traits: "TOMAS-TRAITS: never sits still" } } };
  const { t, api, llm } = await table({ extraCharacters: [tomas] });
  await playerSays(t, api, "Who here has been to the docks?");
  const gm = llm.calls.find((c) => c.purpose === "director").messages[0].content;
  for (const s of ["ALICE-BIO", "ALICE-JOB", "ALICE-TIES", "HARRIET-JOB", "HARRIET-IDEOLOGY", "TOMAS-BIO", "TOMAS-JOB", "TOMAS-TRAITS"]) assert.ok(gm.includes(s), `the Keeper reads ${s}`);
  const turns = llm.calls.filter((c) => c.purpose === "coplayer_turn");
  assert.equal(turns.length, 2);
  const prompt = (name) => turns.map((c) => c.messages[0].content).find((u) => u.startsWith(`YOU ARE: ${name}`));
  const harriet = prompt("Harriet Vance");
  const companions = (u) => u.slice(u.indexOf("THE OTHER INVESTIGATORS"), u.indexOf("CHAT LOG"));
  for (const s of ["ALICE-BIO", "ALICE-JOB", "ALICE-TIES", "TOMAS-BIO", "TOMAS-JOB", "TOMAS-TRAITS"]) assert.ok(companions(harriet).includes(s), `Harriet knows ${s}`);
  assert.ok(!companions(harriet).includes("HARRIET-"), "a co-player is not listed among its own companions");
  const tomasPrompt = prompt("Tomas Leclerc");
  for (const s of ["ALICE-TIES", "HARRIET-JOB", "HARRIET-IDEOLOGY"]) assert.ok(companions(tomasPrompt).includes(s), `Tomas knows ${s}`);
  for (const c of turns) {
    const text = c.system + c.messages.map((m) => m.content).join("\n");
    for (const s of [...SECRETS, "SECRET-NPC", "Mr. Grimsby", "knows where the key is"]) assert.ok(!text.includes(s), `no co-player reads ${s}`);
  }
});

// ---- timelines and autonomy
const MIN = 60000;
const splitPlan = { actions: [{ type: "split", name: "The docks", coplayers: ["Harriet Vance"], location: "Old Harbour", narrative_time: "Tuesday night", opening: "Fog hangs over the harbour." }], coplayers_may_act: false };
const quietDirector = (plan) => (user) => (user.includes("NEWEST LINE") || user.includes("MODE:") ? plan : { actions: [], coplayers_may_act: false });

test("TIMELINE_AUTO=false: split moves co-players into a window of their own on a new timeline; rejoin brings them back", async () => {
  const llm = new MockLlm();
  llm.director = quietDirector(splitPlan);
  const { t, api } = await table({ llm, cfg: { timelineAuto: false } });
  await playerSays(t, api, "Harriet, go and watch the harbour tonight.");
  const side = api.windows_.find((w) => w.name === "Side: The docks");
  assert.ok(side, "a side window was created"); assert.deepEqual(side.members.map((m) => m.user_id), ["u-bot"], "no human sits in it");
  const harriet = t.roster.coplayerByName("Harriet Vance");
  assert.deepEqual(harriet.seats.map((s) => [s.windowId, s.toSeq === null]), [["w-main", false], [side.id, true]], "the Main Chat seat closed, the side seat is open");
  const tl = t.timelines.byName("The docks");
  assert.equal(tl.windowId, side.id); assert.deepEqual(tl.members, ["c-harriet"]); assert.equal(tl.location, "Old Harbour");
  assert.deepEqual(t.timelines.main().members, ["c-alice"]);
  assert.equal(api.posts.at(-1).window, side.id); assert.equal(api.posts.at(-1).content, "Fog hangs over the harbour.");
  // Harriet no longer hears the Main Chat.
  api.add({ chat_window_id: "w-main", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: "MAIN-WHILE-AWAY" });
  llm.director = quietDirector({ actions: [{ type: "rejoin", timeline: "The docks", text: "Harriet comes back soaked." }], coplayers_may_act: true });
  await playerSays(t, api, "Any news from the harbour?");
  assert.equal(t.timelines.byName("The docks").status, "merged");
  assert.deepEqual(t.timelines.main().members.sort(), ["c-alice", "c-harriet"]);
  assert.deepEqual(harriet.seats.at(-1), { windowId: "w-main", fromSeq: harriet.seats.at(-1).fromSeq, toSeq: null });
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.ok(cp.includes("Fog hangs over the harbour."), "Harriet remembers her side trip");
  assert.ok(!cp.includes("MAIN-WHILE-AWAY"), "and not what the Main Chat said while she was away");
  assert.ok(cp.includes("Any news from the harbour?"), "but hears the Main Chat again now");
  assert.ok(cp.includes("YOUR TIMELINE: Main story"));
  const gm = llm.calls.filter((c) => c.purpose === "director").at(-1).messages[0].content;
  assert.ok(gm.includes("## Timelines") && gm.includes("The docks [merged into Main story]"), "the Keeper sees the timelines");
  assert.ok(/Fog hangs over the harbour\./.test(gm) && gm.includes("[timeline: The docks]"), "side lines are tagged with their timeline");
});

test("a side timeline moves on its own clock, with no human line, and the GM answers the co-players at once", async () => {
  const llm = new MockLlm();
  llm.director = quietDirector(splitPlan);
  const { t, api, clock } = await table({ llm, cfg: { timelineAuto: false, autonomySideIntervalMs: 90000, autonomyQuietMs: 10 * MIN } });
  await playerSays(t, api, "Harriet, go and watch the harbour tonight.");
  const side = api.windows_.find((w) => w.name === "Side: The docks");
  llm.director = (user) => ({ actions: user.includes("MODE: side") ? [{ type: "narrate", text: "A boat creaks at the quay." }] : user.includes("MODE: followup") ? [{ type: "narrate", text: "The sailor turns to you." }] : [], coplayers_may_act: true });
  assert.equal(await t.tick(), null, "too soon after the opening line");
  clock.t += 91000;
  const before = api.posts.length;
  await t.tick();
  const posted = api.posts.slice(before);
  assert.deepEqual(posted.map((p) => [p.window, p.kind, p.character_id ?? null]), [[side.id, "narration", null], [side.id, "ic", "c-harriet"], [side.id, "narration", null]], "Keeper, co-player, Keeper's answer — all in the side window");
  const sideCall = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.ok(sideCall.includes("No human player is with you here"), "the co-player knows it leads this thread");
  assert.ok(sideCall.includes("YOUR TIMELINE: The docks; time: Tuesday night; place: Old Harbour"));
  assert.equal(await t.tick(), null, "the side interval has not passed again");
  clock.t += 91000;
  assert.notEqual(await t.tick(), null);
  assert.equal(t.autonomousTurns.length, 2);
});

test("a quiet shared window moves on a little, at most AUTONOMY_QUIET_TURNS times, and a human line resets it", async () => {
  const llm = new MockLlm();
  llm.director = (user) => ({ actions: user.includes("MODE: quiet") ? [{ type: "narrate", text: "The clock strikes." }] : [], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: 3 * MIN, autonomyQuietTurns: 2 } });
  await playerSays(t, api, "I wait.");
  assert.equal(await t.tick(), null, "humans have not been quiet long enough");
  clock.t += 3 * MIN + 1;
  await t.tick();
  assert.equal(api.posts.at(-1).content, "The clock strikes.");
  const quiet = llm.calls.filter((c) => c.purpose === "director").at(-1).messages[0].content;
  assert.ok(quiet.includes("MODE: quiet") && quiet.includes("silent for 3 minutes"));
  clock.t += 3 * MIN + 1;
  await t.tick();
  assert.equal(t.state("w-main").quietTurns, 2);
  clock.t += 3 * MIN + 1;
  assert.equal(await t.tick(), null, "after two quiet turns the table waits for a human");
  await playerSays(t, api, "Sorry, I was away.");
  assert.equal(t.state("w-main").quietTurns, 0, "a human line resets the count");
});

test("autonomy pauses when nobody has posted for AUTONOMY_IDLE_MINUTES, and stops at the hourly cap", async () => {
  const llm = new MockLlm();
  llm.director = () => ({ actions: [{ type: "narrate", text: "Wind." }], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: MIN, autonomyQuietTurns: 99, autonomyIdleMinutes: 30, autonomyMaxTurnsPerHour: 2 } });
  await playerSays(t, api, "Hello?");
  clock.t += 31 * MIN;
  assert.equal(await t.tick(), null, "the table is idle");
  await playerSays(t, api, "Back.");
  clock.t += MIN + 1; assert.notEqual(await t.tick(), null);
  clock.t += MIN + 1; assert.notEqual(await t.tick(), null);
  clock.t += MIN + 1; assert.equal(await t.tick(), null, "two autonomous turns this hour is the cap");
  clock.t += 61 * MIN; await playerSays(t, api, "Still here."); clock.t += MIN + 1;
  assert.notEqual(await t.tick(), null, "the cap rolls over after an hour");
});

test("a human line outranks a queued autonomous turn, and autonomy never runs while a turn is pending", async () => {
  const llm = new MockLlm();
  llm.director = (user) => ({ actions: [{ type: "narrate", text: user.includes("MODE: quiet") ? "QUIET" : "HUMAN" }], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: MIN, debounceMs: 20 } });
  await playerSays(t, api, "Hi.");
  clock.t += MIN + 1;
  const pending = playerSays(t, api, "One more thing.");       // waiting for its debounce
  assert.equal(await t.tick(), null, "a turn is pending");
  await pending;
  assert.equal(api.posts.at(-1).content, "HUMAN");
});

test("in a quiet turn the Keeper cannot speak or roll for a player character", async () => {
  const llm = new MockLlm();
  llm.director = (user) => ({ actions: user.includes("MODE: quiet") ? [
    { type: "npc", name: "Alice Hale", text: "I, the Keeper, decide for Alice." },
    { type: "request_roll", who: "Alice Hale", command: ".ra Listen", text: "Alice, something stirs." },
  ] : [], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: MIN } });
  await playerSays(t, api, "…");
  clock.t += MIN + 1;
  await t.tick();
  assert.ok(!api.posts.some((p) => p.character_id === "c-alice"), "nothing is posted as Alice");
  assert.equal(api.created.length, 0, "no NPC named after a player character is created");
  assert.equal(api.posts.at(-1).kind, "narration"); assert.ok(api.posts.at(-1).content.includes("→ Alice Hale: .ra Listen"), "the roll is asked for, not made");
});

test("the timeline action keeps a thread's time, place and private notes; co-players never see the notes", async () => {
  const llm = new MockLlm();
  llm.director = quietDirector({ actions: [{ type: "timeline", timeline: "Main story", narrative_time: "Wednesday dawn", location: "Hale house", notes: "NOTES-SECRET: the butler lies" }], coplayers_may_act: true });
  const { t, api } = await table({ llm });
  await playerSays(t, api, "We rest until dawn.");
  const main = t.timelines.main();
  assert.equal(main.narrativeTime, "Wednesday dawn"); assert.equal(main.notes, "NOTES-SECRET: the butler lies");
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1);
  assert.ok((cp.system + cp.messages[0].content).includes("YOUR TIMELINE: Main story; time: Wednesday dawn; place: Hale house"));
  assert.ok(!(cp.system + cp.messages[0].content).includes("NOTES-SECRET"));
  const gm = llm.calls.filter((c) => c.purpose === "director").at(-1).messages[0].content;
  assert.ok(gm.includes("notes: NOTES-SECRET"));
});

// ---- proactive timelines and scenarios
const settle = async (t) => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 2)); await t.queue; } };
const directorCalls = (llm) => llm.calls.filter((c) => c.purpose === "director").map((c) => c.messages[0].content);
const alicePosts = (t, api, content, w) => playerSays(t, api, content, w);

test("a player who says they go elsewhere gets a window of their own with the GM, and its scene opens at once", async () => {
  const { t, api, llm } = await table({ bob: true });
  await alicePosts(t, api, "I go to the docks to look for the sailor.");
  await settle(t);
  const w = api.createdWindows[0];
  assert.ok(w, "a window was created"); assert.equal(w.name, "Scene: docks to look for the sailor");
  assert.deepEqual(w.members.map((m) => m.user_id), ["u-bot", "u-alice"], "exactly Alice (and the Keeper account)");
  assert.equal(api.membershipWrites, 1, "members are written once, at creation, and never added later");
  const tl = t.timelines.of("c-alice");
  assert.equal(tl.windowId, w.id); assert.deepEqual(tl.members, ["c-alice"]); assert.equal(tl.span, "short");
  assert.deepEqual(t.timelines.main().members.sort(), ["c-bob", "c-harriet"], "Bob and Harriet stay where they are");
  assert.ok(api.posts.some((p) => p.window === "w-main" && p.visibility === "whisper" && p.whisper_to?.[0] === "c-alice" && p.content.includes(w.name)), "Alice is pointed to her window");
  assert.ok(api.posts.some((p) => p.window === w.id && p.content.startsWith("[mock Keeper] docks")), "the opening is posted there");
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: arrival") && u.includes("Alice Hale just arrived")), "an arrival turn opened the scene");
  assert.ok(api.posts.some((p) => p.window === w.id && p.kind === "narration" && /You consider/.test(p.content)), "the Keeper narrated in her window");
  assert.ok(tl.opened, "the thread is marked opened");
  assert.match(t.splitWarning, /knowledge mode is public/, "public knowledge mode is noticed (the CLI warns about it)");
});

test("only the player's own line moves them; a co-player follows after its own line, and its memory follows its seat", async () => {
  const llm = new MockLlm();
  const baseDirector = llm.director.bind(llm);
  llm.director = (user) => {
    if (user.includes("MODE: followup") && user.includes("I follow Alice")) return { actions: [{ type: "narrate", text: "Harriet hurries after her." }], coplayers_may_act: false, whereabouts: [{ who: ["Harriet Vance"], thread: "T1" }] };
    return baseDirector(user);
  };
  llm.coplayer = (user) => (user.includes("YOU ARE: Harriet") && user.includes("I go to the docks") && !user.includes("Harriet hurries") ? { action: "speak", kind: "ic", text: "I follow Alice." } : { action: "speak", kind: "ic", text: "[mock] I look around." });
  const { t, api } = await table({ llm, bob: true });
  await alicePosts(t, api, "Harriet, wait here. I go to the docks.");
  await settle(t);
  const alice = t.timelines.of("c-alice");
  assert.deepEqual(alice.members.sort(), ["c-alice", "c-harriet"], "Harriet followed, after her own line");
  const harriet = t.roster.coplayerByName("Harriet Vance");
  assert.deepEqual(harriet.seats.filter((x) => x.toSeq === null).map((x) => x.windowId), [alice.windowId], "her one open seat is Alice's window");
  api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "MAIN-AFTER-SHE-LEFT" });
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn" && c.messages[0].content.startsWith("YOU ARE: Harriet")).at(-1).messages[0].content;
  assert.ok(cp.includes("I go to the docks"), "she remembers the departure");
  assert.ok(cp.includes("WITH YOU HERE") && cp.indexOf("Alice Hale") > cp.indexOf("WITH YOU HERE"), "she knows Alice is with her");
  assert.equal(api.membershipWrites, 1, "a co-player joining needs no membership write");
});

test("coming back: the player's thread merges into the main story, the old window points to the Main Chat, the reunion is narrated", async () => {
  const { t, api, llm } = await table({ bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  const side = t.timelines.of("c-alice");
  await alicePosts(t, api, "Nothing here. I go back to the others.", side.windowId);
  await settle(t);
  assert.equal(t.timelines.of("c-alice").id, "main");
  assert.equal(t.timelines.get(side.id).status, "merged"); assert.ok(t.timelines.retired(side.windowId));
  assert.ok(api.posts.some((p) => p.window === side.windowId && p.visibility === "window" && p.content === '→ "Main Chat"'), "the old window points back");
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: arrival") && u.includes("rejoined the others")), "the reunion gets its own scene opening");
  assert.equal(api.membershipWrites, 1, "no membership write for a reunion");
  assert.equal(await t.tick(), null, "a retired window never gets autonomous turns");
});

test("a split-off player who writes in the Main Chat is answered in their own scene, with a pointer", async () => {
  const { t, api, llm } = await table({ bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  const home = t.timelines.of("c-alice").windowId;
  const before = api.posts.length;
  await alicePosts(t, api, "I search the crates for the badge.", "w-main");
  await settle(t);
  const after = api.posts.slice(before);
  assert.ok(after.some((p) => p.window === "w-main" && p.visibility === "whisper" && p.whisper_to?.[0] === "c-alice"), "pointer in the Main Chat");
  assert.ok(!after.some((p) => p.window === "w-main" && p.visibility === "window"), "nothing about the docks is narrated in the Main Chat");
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: relay") && u.includes("I search the crates")), "the relay turn quotes her line");
  assert.ok(after.some((p) => p.window === home && p.kind === "narration"), "the answer lands in her window");
});

test("a reported move that is not allowed is noted for the Keeper and changes nothing", async () => {
  // Alice speaks; the Keeper also reports Bob leaving, but only Bob's own player can move Bob.
  const llm = new MockLlm();
  llm.director = (user) => (!/^MODE: /m.test(user) ? { actions: [{ type: "narrate", text: "ok" }], coplayers_may_act: false, whereabouts: [{ who: ["Bob Price"], thread: "new", place: "Attic", own_scene: true }] } : { actions: [], coplayers_may_act: false });
  const { t, api } = await table({ llm, bob: true });
  await alicePosts(t, api, "Bob, go and look upstairs.");
  await settle(t);
  assert.equal(api.createAttempts ?? 0, 0, "no window");
  assert.equal(t.timelines.of("c-bob").id, "main");
  const note = api.posts.find((p) => p.visibility === "gm_only" && p.content.startsWith("Whereabouts not applied"));
  assert.ok(note && /Bob Price/.test(note.content), note?.content);
});

const bobSays = (t, api, content, w = "w-main") => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: w, author_id: "u-bob", author_role: "player", character_id: "c-bob", content }) });
const twoWays = () => {
  const llm = new MockLlm();
  llm.director = (user) => (!/^MODE: /m.test(user) && user.includes("Mill")
    ? { actions: [{ type: "narrate", text: "They part." }], coplayers_may_act: false, whereabouts: [{ who: ["Alice Hale"], thread: "new", place: "Docks", own_scene: true }, { who: ["Bob Price"], thread: "new", place: "Mill", own_scene: true }] }
    : { actions: [], coplayers_may_act: false });
  return llm;
};

test("a platform failure creating the window changes nothing locally and the window is reused on retry", async () => {
  const { t, api } = await table({ llm: twoWays(), bob: true, cfg: { debounceMs: 20 } });
  api.failAfter = 1;                                   // Alice's window is created, Bob's fails
  await Promise.all([alicePosts(t, api, "I go to the docks."), bobSays(t, api, "And I go to the Mill.")]);
  await settle(t);
  assert.equal(api.createdWindows.length, 1);
  assert.equal(t.timelines.active().length, 1, "no thread without its window");
  assert.equal(t.journal, null);
  assert.deepEqual(t.guard.spare.map((x) => x.windowId), [api.createdWindows[0].id], "the window already made is kept");
  api.failAfter = undefined;
  await Promise.all([alicePosts(t, api, "I go to the docks."), bobSays(t, api, "And I go to the Mill.")]);
  await settle(t);
  assert.equal(api.createdWindows.length, 2, "only Bob's window is made the second time");
  assert.equal(t.timelines.of("c-alice").windowId, api.createdWindows[0].id, "Alice's earlier window is reused");
  assert.deepEqual(t.guard.spare, []);
});

test("a split the platform fails three times is given up and noted, not retried every turn", async () => {
  const { t, api } = await table({ bob: true });
  api.failCreate = true;
  for (let i = 0; i < 4; i++) { await alicePosts(t, api, "I go to the docks."); await settle(t); }
  assert.equal(api.createAttempts, 3);
  assert.ok(api.posts.some((p) => p.visibility === "gm_only" && /failed to open this scene three times/.test(p.content)));
  assert.equal(t.timelines.of("c-alice").id, "main");
});

test("an interrupted split is finished on restart with the window it had already made, and its scene still gets an opening turn", async () => {
  const { t, api, llm } = await table({ bob: true });
  const made = await api.createWindow("ch", { name: "Scene: Docks", kind: "group", members: [{ user_id: "u-alice", character_id: "c-alice" }] });
  const ops = [{ op: "split", ids: ["c-alice"], place: "Docks", time: "", span: "short", opening: "Fog.", fromTimeline: "main", replaces: null }];
  const journal = { opId: "x", ops, changed: ["c-alice"], windowId: "w-main", created: [{ windowId: made.id, placeKey: "docks", users: ["u-alice"] }], phase: "A" };
  const t2 = new Table({ api, llm, cfg: t.cfg, channelId: "ch", roster: new Roster(), journal, sleep: async () => {} });
  await t2.init({ heal: true });
  await settle(t2);
  assert.equal(api.createdWindows.length, 1, "no second window");
  assert.equal(t2.timelines.of("c-alice").windowId, made.id);
  assert.equal(t2.timelines.of("c-alice").location, "Docks");
  assert.equal(t2.journal, null);
  assert.ok(directorCalls(llm).some((u) => u.includes("MODE: arrival")), "the opening turn ran");
});

test("a CLI command applied without a run process leaves its arrival for run", async () => {
  const { t, api } = await table();
  t.deferArrivals = true;
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Lighthouse", span: "long" });
  assert.equal(t.owedArrivals.length, 1);
  assert.equal(t.timelines.of("c-harriet").span, "long");
  assert.equal(api.createdWindows[0].name, "Side: Lighthouse");
  await t.command({ cmd: "rejoin", timeline: "Lighthouse" });
  assert.equal(t.timelines.of("c-harriet").id, "main");
});

test("an arrival riding on a pending human turn keeps its note and never shortens the human's wait", async () => {
  const { t, api, llm } = await table({ cfg: { debounceMs: 30 } });
  const human = alicePosts(t, api, "Anyone?");
  t.schedule("w-main", { mode: "arrival", delay: 0, arrival: { names: ["Harriet Vance"], reunion: true } });
  await human; await settle(t);
  const u = directorCalls(llm).at(-1) ?? "";
  assert.ok(directorCalls(llm).some((x) => x.includes("Harriet Vance just rejoined")), "the arrival note rode along");
  assert.equal(t.turns, 1, "one turn, not two");
  void u;
});

test("arrivals are capped per hour", async () => {
  const { t } = await table({ cfg: { timelineMaxArrivalsPerHour: 1 } });
  assert.notEqual(t.scheduleArrival("w-main", { names: ["x"] }), null);
  assert.equal(t.scheduleArrival("w-main", { names: ["y"] }), null);
  await settle(t);
});

test("stale refreshes never overwrite newer ones", async () => {
  const { t, api } = await table();
  const realWindows = api.windows.bind(api);
  let first = true;
  api.windows = async () => { const snapshot = await realWindows(); if (first) { first = false; await new Promise((r) => setTimeout(r, 20)); } return snapshot; };
  const slow = t.refresh();
  api.windows_.push({ id: "w-late", name: "Late", kind: "group", members: [{ user_id: "u-bot" }] });
  await t.refresh();
  await slow;
  assert.ok(t.windows.some((w) => w.id === "w-late"), "the newer list stays");
});

test("scenarios: the GM may advance only from the Main Chat, after the minimums, never during a short split or an autonomous turn", async () => {
  const { t, api, clock } = await table({ cfg: { scenarioMinMinutes: 20, scenarioMinLines: 30, autonomyQuietMs: MIN } });
  const note = () => api.posts.filter((p) => p.visibility === "gm_only" && p.content.startsWith("Scenario change refused")).at(-1)?.content ?? "";
  t.scenario = { id: "sc1", since: clock.t };
  await alicePosts(t, api, "We sleep. The next morning we go out.");
  await settle(t);
  assert.equal(api.advanced.length, 0); assert.match(note(), /began 0 min ago/);
  clock.t += 21 * MIN;
  await alicePosts(t, api, "The next morning, then.");
  await settle(t);
  assert.equal(api.advanced.length, 0); assert.match(note(), /only 5 lines/);
  api.scenes_[0].event_count = 40;
  // A short split blocks it.
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Cellar" });
  await settle(t);
  await alicePosts(t, api, "Next morning.");
  await settle(t);
  assert.equal(api.advanced.length, 0); assert.match(note(), /briefly split/);
  // A long split does not.
  t.timelines.update(t.timelines.of("c-harriet").id, { span: "long" });
  await alicePosts(t, api, "Next morning at last.");
  await settle(t);
  assert.equal(api.advanced.length, 1, "advanced"); assert.equal(api.currentScene, "sc2");
  assert.equal(t.scenario.id, "sc2"); assert.equal(t.timelines.main().narrativeTime, "next morning");
  // Never from another window, never in an autonomous turn.
  assert.equal((await t.scenarioVerdict(t.timelines.of("c-harriet").windowId, "human")).ok, false);
  assert.equal((await t.scenarioVerdict("w-main", "quiet")).ok, false);
  assert.equal((await t.scenarioVerdict("w-main", "arrival")).ok, false);
});

test("enter_scenario picks a prepared scenario by title", async () => {
  const llm = new MockLlm();
  llm.director = (user) => (user.includes("NEWEST LINE") && !user.includes("MODE:") ? { actions: [{ type: "enter_scenario", scenario: "The lighthouse", reason: "they sail out" }], coplayers_may_act: false } : { actions: [], coplayers_may_act: false });
  const { t, api, clock } = await table({ llm, cfg: { scenarioMinMinutes: 0, scenarioMinLines: 0 } });
  api.scenes_.push({ id: "sc-light", title: "The lighthouse", status: "active", event_count: 0 });
  t.scenario = { id: "sc1", since: clock.t - 1 };
  await alicePosts(t, api, "We sail out.");
  await settle(t);
  assert.deepEqual(api.advanced, [{ entered: "sc-light" }]);
});

test("a lone player who leaves keeps the Main Chat (it moves with them); the co-player left behind gets a side window", async () => {
  const { t, api } = await table();
  t.timelines.relocate("main", { location: "Hale House" });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  assert.equal(t.timelines.of("c-alice").id, "main", "Alice never has to change windows");
  assert.equal(t.timelines.main().location, "docks");
  const side = t.timelines.of("c-harriet");
  assert.notEqual(side.id, "main"); assert.equal(side.location, "Hale House");
  assert.equal(api.createdWindows[0].name, "Side: Hale House"); assert.equal(api.membershipWrites, 0, "a co-players-only window has no members to write");
});

test("an autonomous turn's followup never changes the scenario", async () => {
  const llm = new MockLlm();
  llm.director = (user) => {
    const mode = (user.match(/^MODE: (\w+)/m) ?? [])[1] ?? "human";
    if (mode === "quiet") return { actions: [{ type: "narrate", text: "Time passes." }], coplayers_may_act: true };
    if (mode === "followup") return { actions: [{ type: "advance_scenario", title: "Dawn", narrative_time: "dawn", reason: "x" }], coplayers_may_act: false };
    return { actions: [{ type: "narrate", text: "ok" }], coplayers_may_act: false };
  };
  const { t, api, clock } = await table({ llm, cfg: { scenarioMinMinutes: 0, scenarioMinLines: 0, autonomyQuietMs: MIN } });
  await alicePosts(t, api, "Hm.");
  await settle(t);
  clock.t += MIN + 1;
  assert.notEqual(await t.tick(), null, "a quiet turn runs");
  await settle(t);
  assert.ok(directorCalls(llm).some((u) => u.startsWith("MODE: followup") || u.includes("\nMODE: followup")), "the co-players acted and the Keeper followed up");
  assert.deepEqual(api.advanced, []);
  assert.ok(api.posts.some((p) => p.visibility === "gm_only" && p.content.startsWith("Scenario change refused") && /autonomous/.test(p.content)));
});

test("a player's lines wait for the human turn even when an arrival turn runs first", async () => {
  // The Keeper reads Alice's line from the context (the arrival's narration is newer); the move counts only if her line
  // is still in the human turn's batch.
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (!/^MODE: /m.test(user) && user.includes("Alice Hale: I go to the docks.") ? { actions: [{ type: "narrate", text: "She leaves." }], coplayers_may_act: false, whereabouts: [{ who: ["Alice Hale"], thread: "new", place: "Docks", own_scene: true }] } : base(user));
  const { t, api } = await table({ llm, bob: true, cfg: { debounceMs: 30 } });
  const human = alicePosts(t, api, "I go to the docks.");
  await t.turn("w-main", { mode: "arrival", arrival: { names: ["Harriet Vance"], reunion: true } });
  await human; await settle(t);
  assert.ok(directorCalls(llm).some((u) => u.includes("Harriet Vance just rejoined")));
  assert.equal(api.createdWindows.length, 1, "her own line still moved her");
  assert.equal(t.timelines.of("c-alice").location, "Docks");
});

test("a player leaving a shared scene: the co-player who stays continues in a fresh window, and only the leaver is welcomed back", async () => {
  const { t, api, llm } = await table({ bob: true });
  await t.command({ cmd: "split", who: ["Alice Hale", "Harriet Vance"], place: "Docks" });
  await settle(t);
  const docks = t.timelines.of("c-alice");
  const callsBefore = directorCalls(llm).length;
  await alicePosts(t, api, "Nothing here. I go back to the others.", docks.windowId);
  await settle(t);
  assert.equal(t.timelines.of("c-alice").id, "main");
  const harriet = t.timelines.of("c-harriet");
  assert.notEqual(harriet.id, "main"); assert.notEqual(harriet.windowId, docks.windowId, "Harriet's scene moved to a fresh window");
  assert.deepEqual(t.windowUsers(harriet.windowId), [], "Alice cannot read where Harriet stayed");
  const later = directorCalls(llm).slice(callsBefore);
  assert.ok(later.some((u) => u.includes("Alice Hale just rejoined")), "Alice's reunion is narrated");
  assert.ok(!later.some((u) => u.includes("Harriet Vance just rejoined")), "Harriet never 'rejoins' anyone");
});

test("a roll for someone in another scene is not requested here", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (user.includes("listen for her") ? { actions: [{ type: "request_roll", who: "Alice Hale", command: ".ra Listen", text: "Alice, something stirs." }], coplayers_may_act: false } : base(user));
  const { t, api } = await table({ llm, bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  await bobSays(t, api, "I listen for her.");
  await settle(t);
  assert.ok(!api.posts.some((p) => p.content.includes("→ Alice Hale: .ra Listen")), "no roll request for Alice");
  assert.ok(api.posts.some((p) => p.visibility === "gm_only" && p.content.startsWith("Roll request for Alice Hale not posted")));
});

test("relay never widens who reads a line: a scene with other readers gets only the pointer", async () => {
  const { t, api, llm } = await table({ bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  const home = t.timelines.of("c-alice").windowId;
  api.channelUsers.push("u-carol");
  api.windows_.find((w) => w.id === home).members.push({ user_id: "u-carol" });
  await t.refresh();
  const before = api.posts.length;
  await alicePosts(t, api, "I search the crates.", "w-main");
  await settle(t);
  assert.ok(!directorCalls(llm).some((u) => u.includes("MODE: relay") && u.includes("I search the crates")), "no relay into a window Carol reads");
  assert.ok(api.posts.slice(before).some((p) => p.window === "w-main" && p.visibility === "whisper"), "the pointer is still posted");
});

test("isolated channels warn only when players share a player group", async () => {
  const api = new FakeApi();
  api.knowledgeMode = "isolated";
  const t = await new Table({ api, llm: new MockLlm(), cfg: { ...buildConfig({}, {}), debounceMs: 0 }, channelId: "ch", roster: new Roster(), sleep: async () => {} }).init();
  assert.equal(t.splitWarning, null);
  api.groups = [{ id: "g1", name: "Party", members: [{ user_id: "u-alice" }, { user_id: "u-bob" }] }];
  const t2 = await new Table({ api, llm: new MockLlm(), cfg: { ...buildConfig({}, {}), debounceMs: 0 }, channelId: "ch", roster: new Roster(), sleep: async () => {} }).init();
  assert.match(t2.splitWarning, /share a player group \(Party\)/);
});

test("co-players are GM-cast PCs: every PC the Keeper account owns is one, older marked NPCs still are, and none is taken for a player", async () => {
  const legacy = { id: "c-old", name: "Old Ned", kind: "npc", user_id: null, speaking_style: markStyle("gruff"), bio: "An older co-player." };
  const { t } = await table({ extraCharacters: [legacy] });
  assert.ok(t.roster.isCoplayer("c-harriet"), "a PC the Keeper owns is a co-player");
  assert.ok(t.roster.isCoplayer("c-old"), "a marked NPC from an older version still is");
  assert.ok(t.roster.isNpc("c-butler"), "an unmarked NPC is a real NPC");
  assert.equal(t.isPc("c-harriet"), false, "a GM-cast PC is not a player character");
  assert.equal(t.isPc("c-alice"), true);
  const ctx = await t.gm.build({ windowId: "w-main", roster: t.roster, characters: t.characters, windows: t.windows, timelines: t.timelines, sceneOf: (w) => t.scene(w) });
  const cast = ctx.text.slice(ctx.text.indexOf("## Cast"));
  assert.ok(cast.indexOf("Harriet Vance") > cast.indexOf("Co-players"), "listed with the co-players, not the player characters");
});

// ---- improvisation mode
const IMPROV = { on: true, world: "WORLD-PUBLIC: Kingsport, 1923. A fog-bound port; the Harbour Guild runs the docks.", secrets: "WORLD-SECRET: the Guild master drowned the lighthouse keeper." };

test("improvisation: the world is posted once for the players, and the GM and co-players get it as a section of its own", async () => {
  const { t, api, llm } = await table({ improv: IMPROV, heal: true });
  const posted = api.posts.filter((p) => p.window === "w-main" && p.content.includes("WORLD-PUBLIC"));
  assert.equal(posted.length, 1, "posted in the Main Chat"); assert.equal(posted[0].visibility, "window"); assert.match(posted[0].content, /^World setting/);
  await t.publishWorld();
  assert.equal(api.posts.filter((p) => p.content.includes("WORLD-PUBLIC")).length, 1, "never posted twice for the same text");
  await alicePosts(t, api, "I look out over the harbour.");
  await settle(t);
  const director = llm.calls.find((c) => c.purpose === "director");
  const ctx = director.messages[0].content;
  assert.ok(ctx.includes("## World setting") && ctx.includes("WORLD-PUBLIC"));
  assert.ok(ctx.includes("## Hidden truths") && ctx.includes("WORLD-SECRET"), "the GM keeps the secrets");
  assert.equal(ctx.split("WORLD-PUBLIC").length - 1, 1, "the posted copy is left out of the chat");
  assert.ok(!ctx.includes("SECRET-SCRIPT"), "no module script knowledge");
  assert.match(director.system, /there is no module/); assert.match(director.system, /"type": "truth"/);
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.ok(cp.includes("THE WORLD") && cp.includes("WORLD-PUBLIC"), "the co-player knows the world");
  assert.equal(cp.split("WORLD-PUBLIC").length - 1, 1, "once, not again from the chat");
  assert.ok(!cp.includes("WORLD-SECRET"), "never the Keeper's secrets");
  assert.ok(cp.includes("PERSONA: A sharp antiquarian."), "and its own personality and background");
});

test("improvisation: a hidden truth the GM decides is kept for the GM and never reaches a co-player", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (user.includes("Who did it") ? { actions: [{ type: "truth", text: "TRUTH-X: the harbour master forged the manifest." }, { type: "narrate", text: "The clerk looks away." }], coplayers_may_act: true } : base(user));
  const { t, api } = await table({ llm, improv: IMPROV });
  await alicePosts(t, api, "Who did it?");
  await settle(t);
  assert.deepEqual(t.improv.truths.map((x) => x.text), ["TRUTH-X: the harbour master forged the manifest."]);
  assert.ok(!api.posts.some((p) => p.content.includes("TRUTH-X")), "nothing is posted");
  await alicePosts(t, api, "Anything else?");
  await settle(t);
  assert.ok(llm.calls.filter((c) => c.purpose === "director").at(-1).messages[0].content.includes("TRUTH-X"), "the GM keeps to it");
  assert.ok(!llm.calls.filter((c) => c.purpose === "coplayer_turn").some((c) => c.messages[0].content.includes("TRUTH-X")));
});

test("improvisation off: the module guides the GM, no world, and truth is not an action", async () => {
  const { t, api, llm } = await table();
  await alicePosts(t, api, "Hello.");
  await settle(t);
  const director = llm.calls.find((c) => c.purpose === "director");
  assert.ok(director.messages[0].content.includes("SECRET-SCRIPT")); assert.ok(!director.messages[0].content.includes("## World setting"));
  assert.ok(!/"type": "truth"/.test(director.system));
  assert.equal(t.improv.on, false);
});

test("the world command turns the mode on, posts a long setting in parts, and posts it again only when it changes", async () => {
  const { t, api } = await table();
  const long = Array.from({ length: 6 }, (_, i) => `PART-${i} ${"x".repeat(1500)}`).join("\n\n");
  await t.command({ cmd: "world", on: true, world: long, secrets: "S" });
  const parts = api.posts.filter((p) => p.content.startsWith("World setting ("));
  assert.ok(parts.length >= 3 && parts.every((p) => p.content.length <= 4100), `${parts.length} parts`);
  assert.ok(parts.at(-1).content.includes("PART-5"));
  await t.command({ cmd: "world", on: true, world: long });
  assert.equal(api.posts.filter((p) => p.content.startsWith("World setting (")).length, parts.length, "unchanged: not posted again");
  await t.command({ cmd: "world", world: "A new world." });
  assert.ok(api.posts.some((p) => p.content === "World setting\n\nA new world."));
  assert.equal(t.improv.secrets, "S", "secrets kept when not given");
});

// ---- long context: local history, compaction, co-player memory, cache layout, usage
const many = (api, n, { w = "w-main", text = (i) => `Line ${i}: the rain keeps falling over the harbour while we argue about the lighthouse keeper and his debts.` } = {}) => {
  for (let i = 0; i < n; i++) api.add({ chat_window_id: w, author_id: "u-alice", author_role: "player", character_id: "c-alice", content: text(i) });
};

test("history: a long window is copied once into the store, paging back past the first page", async () => {
  const api0 = new FakeApi();
  many(api0, 250);
  const { History } = await import("../src/memory.mjs");
  const { Store } = await import("../src/store.mjs");
  const store = new Store();
  const h = new History({ api: api0, store, channelId: "ch", pageSize: 100, backfill: 1000 });
  await h.sync("w-main");
  assert.equal(h.lines("w-main").length, 250);
  many(api0, 120);
  await h.sync("w-main");
  assert.equal(h.lines("w-main").length, 370, "the gap since the last sync is filled");
});

test("long context: old lines become a Keeper chapter, the newest stay word for word, and the GM keeps reading both", async () => {
  const { t, api, llm } = await table({ cfg: { gmContextTokens: 4000 } });
  many(api, 300);
  await alicePosts(t, api, "Where were we?");
  await settle(t); await t.memoryIdle();
  const chapters = t.store.chapters("gm", "w-main");
  assert.ok(chapters.length >= 1, "a chapter was written");
  const compact = llm.calls.find((c) => c.purpose === "compact");
  assert.ok(compact.messages[0].content.includes("LINES:") && compact.messages[0].content.includes("Line 0:"), "the oldest lines were summarised");
  await alicePosts(t, api, "And now?");
  await settle(t);
  const ctx = directorCalls(llm).at(-1);
  assert.ok(ctx.includes("## The story so far") && ctx.includes("[mock compact]"), "the chapter is in the GM's context");
  assert.ok(ctx.includes("And now?"), "the newest lines are word for word");
  assert.ok(!ctx.includes("Line 0: the rain"), "the compacted lines are not repeated");
});

test("co-player memory: its chapters come only from lines it witnessed, and it reads them in its turn", async () => {
  const { t, api, llm } = await table({ cfg: { coplayerContextTokens: 2500 } });
  for (let i = 0; i < 150; i++) {
    api.add({ chat_window_id: "w-main", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: `Witnessed ${i}: we search the study for the ledger and find dust, letters and old receipts.` });
    if (i % 30 === 0) api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: `KEEPER-ONLY-${i}: the ledger is in the clock`, visibility: "gm_only" });
  }
  await alicePosts(t, api, "Harriet, what do you think?");
  await settle(t); await t.memoryIdle();
  const mem = llm.calls.filter((c) => c.purpose === "coplayer_memory");
  assert.ok(mem.length >= 1, "a memory chapter was written");
  assert.ok(mem.every((c) => !c.messages[0].content.includes("KEEPER-ONLY")), "never from Keeper-only lines");
  assert.match(mem[0].system, /You are Harriet Vance/);
  await alicePosts(t, api, "Harriet?");
  await settle(t);
  const turn = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.ok(turn.includes("WHAT YOU REMEMBER") && turn.includes("[mock coplayer_memory]"));
  assert.ok(!turn.includes("KEEPER-ONLY"));
});

test("cache layout: the GM's prompt is stable-first, its cached parts unchanged between turns, the turn's details last", async () => {
  const { t, api, llm } = await table();
  await alicePosts(t, api, "Hello.");
  await settle(t);
  await alicePosts(t, api, "Hello again.");
  await settle(t);
  const calls = llm.calls.filter((c) => c.purpose === "director");
  const [first, second] = [calls.at(-2).parts[0], calls.at(-1).parts[0]];
  assert.ok(first[0].cache && first[0].text.includes("## Campaign") && first[0].text.includes("## Cast"));
  assert.ok(!first[0].text.includes("events so far"), "the per-turn event count is not in the cached prefix");
  assert.equal(first[0].text, second[0].text, "the campaign part is byte-identical across turns");
  assert.ok(!first.at(-1).cache && first.at(-1).text.includes("NEWEST LINE"), "the turn's details are last and uncached");
  assert.ok(first.filter((p) => p.cache).length <= 3, "at most three cache marks besides the system prompt");
  const cp = llm.calls.find((c) => c.purpose === "coplayer_turn").parts[0];
  assert.ok(cp[0].cache && cp[0].text.startsWith("YOU ARE: Harriet Vance"));
  assert.ok(cp.at(-1).text.includes("Your move?") && !cp.at(-1).cache);
});

test("usage is recorded per call, and the daily budget stops autonomous turns", async () => {
  const { t, api, clock } = await table({ cfg: { autonomyQuietMs: MIN } });
  await alicePosts(t, api, "Hm.");
  await settle(t);
  const u = t.store.usageSince(0);
  assert.ok(u.calls >= 2 && u.input > 0 && u.output > 0);
  t.cfg.dailyTokenBudget = 1;
  clock.t += MIN + 1;
  assert.equal(await t.tick(), null, "no quiet turn once the budget is spent");
  t.cfg.dailyTokenBudget = 0;
  assert.notEqual(await t.tick(), null);
  await settle(t);
});

test("Keeper documents keep their newest entries when they are too long", async () => {
  const { t, api } = await table({ cfg: { gmContextTokens: 16000 } });
  const entries = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, section: "Clues", content_md: `CLUE-${i}: ${"a long clue about the harbour ".repeat(6)}`, updated_version: i + 1 }));
  api.document = async () => ({ entries });
  await alicePosts(t, api, "Clues?");
  await settle(t);
  const docs = await t.gm.documents();
  assert.ok(docs[0].includes("CLUE-59") && !docs[0].includes("CLUE-0:"), "newest kept, oldest dropped");
  assert.match(docs[0], /\(\d+ older entries not shown\)/);
});

test("a scene that ends becomes a chapter of the Keeper's memory", async () => {
  const { t, api } = await table({ bob: true });
  await alicePosts(t, api, "I go to the docks.");
  await settle(t);
  const side = t.timelines.of("c-alice");
  await alicePosts(t, api, "Nothing here. I go back to the others.", side.windowId);
  await settle(t); await t.memoryIdle();
  assert.equal(t.store.chapters("gm", side.windowId).length, 1);
});

// ---- fragmented play: away mode, pace, returning players
test("away mode: with nobody around, a co-players-only thread still moves, rarely; shared windows wait", async () => {
  const { t, api, clock } = await table({ cfg: { autonomyIdleMinutes: 30, awaySideIntervalMs: 6 * 3600000, autonomySideIntervalMs: MIN, autonomyQuietMs: MIN } });
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Lighthouse", span: "long" });
  await settle(t);
  await alicePosts(t, api, "Back soon.");
  await settle(t);
  clock.t += 2 * 3600000;                                   // two hours: away
  assert.equal(await t.tick(), null, "away: the side thread waits for AWAY_SIDE_INTERVAL_MS");
  clock.t += 5 * 3600000;                                   // seven hours since anyone posted
  const before = t.turns;
  assert.notEqual(await t.tick(), null, "the side thread moves after the away interval");
  await settle(t);
  assert.equal(t.turns, before + 1);
  assert.equal(t.scene(api.createdWindows[0].id).members[0], "c-harriet");
  t.cfg.awaySideIntervalMs = 0;
  clock.t += 7 * 3600000;
  assert.equal(await t.tick(), null, "AWAY_SIDE_INTERVAL_MS=0: nothing moves while everyone is away");
});

test("pace: in a quiet turn a co-player who already answered the last human line stays quiet", async () => {
  const llm = new MockLlm();
  const { t, api, clock } = await table({ llm, cfg: { autonomyQuietMs: MIN, autonomyQuietTurns: 2 } });
  await alicePosts(t, api, "Harriet, the clock?");
  await settle(t);
  const turnsOf = () => llm.calls.filter((c) => c.purpose === "coplayer_turn").length;
  const afterHuman = turnsOf();
  assert.equal(afterHuman, 1, "she answers the human line");
  clock.t += MIN + 1;
  await t.tick(); await settle(t);
  assert.equal(turnsOf(), afterHuman, "not again in the quiet turn that follows");
  await alicePosts(t, api, "Well?");
  await settle(t);
  assert.equal(turnsOf(), afterHuman + 1, "a new human line gives her another go");
});

test("a player back after being away is welcomed back, and away players are marked for the Keeper", async () => {
  const llm = new MockLlm();
  const { t, api, clock } = await table({ llm, bob: true, cfg: { autonomyIdleMinutes: 30 } });
  await alicePosts(t, api, "I sit by the fire.");
  t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: "w-main", author_id: "u-bob", author_role: "player", character_id: "c-bob", content: "I read the paper." }) });
  await settle(t);
  clock.t += 9 * 3600000;
  await alicePosts(t, api, "Morning. Anything new?");
  await settle(t);
  const u = directorCalls(llm).find((x) => x.includes("Morning. Anything new?") && !/^MODE: /m.test(x));
  assert.match(u, /RETURNING: Alice Hale's player is back after 9 h away/);
  assert.match(u, /Bob Price \(player away 9 h\)/, "Bob, who has not posted, is marked away");
  assert.match(llm.calls.find((c) => c.purpose === "director").system, /player away/);
  const n = directorCalls(llm).length;
  await alicePosts(t, api, "Let's go.");
  await settle(t);
  assert.ok(!directorCalls(llm).slice(n).some((x) => x.includes("RETURNING")), "only once");
});

// ---- the platform's living world record
test("the world record is in the GM's context, never a co-player's, and world_change declares to the platform", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (user.includes("Meanwhile?") && !/^MODE: /m.test(user) ? { actions: [{ type: "world_change", text: "WORLD-CHANGE: the Guild closes the docks at night.", secret: true }, { type: "narrate", text: "Night falls." }], coplayers_may_act: true } : base(user));
  const { t, api } = await table({ llm });
  api.world_ = { version: 3, entities: [
    { id: "e1", kind: "npc", name: "Silas Mott", status: "dead", state: "RECORD-SILAS found drowned under the pier", location: null, state_by: "gm", state_updated_at: "2026-11-01T10:00:00Z" },
    { id: "e2", kind: "location", name: "Old Mill", status: "unknown", state: "", location: null },
  ], recent_changes: [{ entity_id: "e1", name: "Silas Mott", status: "dead", state: "RECORD-SILAS found drowned", actor: "gm" }] };
  await alicePosts(t, api, "Meanwhile?");
  await settle(t);
  const director = llm.calls.find((c) => c.purpose === "director");
  const ctx = director.messages[0].content;
  assert.match(ctx, /## The world now/); assert.match(ctx, /\[npc\] Silas Mott — dead: RECORD-SILAS found drowned under the pier \[set by you\]/);
  assert.ok(!ctx.includes("Old Mill"), "entities with nothing known are left out");
  assert.match(director.system, /"type": "world_change"/);
  assert.ok(!llm.calls.filter((c) => c.purpose === "coplayer_turn").some((c) => c.messages[0].content.includes("RECORD-SILAS")), "co-players never read the Keeper's record");
  assert.deepEqual(api.declared, [{ text: "WORLD-CHANGE: the Guild closes the docks at night.", secret: true }]);
  assert.ok(!api.posts.some((p) => p.content.includes("WORLD-CHANGE")), "a declaration is never a chat line");
});

test("improvisation: the world and secrets are handed to the platform's world record once per version, truths as secrets", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (user.includes("Who did it") ? { actions: [{ type: "truth", text: "TRUTH-Y: the clerk forged it." }], coplayers_may_act: false } : base(user));
  const { t, api } = await table({ llm, improv: IMPROV, heal: true });
  assert.deepEqual(api.declared.map((d) => [d.text.slice(0, 12), d.secret]), [["WORLD-PUBLIC", false], ["WORLD-SECRET", true]]);
  await t.publishWorld(); await t.seedWorld();
  assert.equal(api.declared.length, 2, "not again for the same texts");
  await t.command({ cmd: "world", secrets: "WORLD-SECRET-2: the keeper lives." });
  assert.equal(api.declared.at(-1).text, "WORLD-SECRET-2: the keeper lives."); assert.equal(api.declared.at(-1).secret, true);
  await alicePosts(t, api, "Who did it?");
  await settle(t);
  assert.deepEqual(api.declared.at(-1), { text: "TRUTH-Y: the clerk forged it.", secret: true });
});

test("a platform without the world record: declarations are dropped once, the table carries on", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (user.includes("Meanwhile?") ? { actions: [{ type: "world_change", text: "X" }, { type: "narrate", text: "Ok." }], coplayers_may_act: false } : base(user));
  const { t, api } = await table({ llm });
  api.noWorld = true;
  await alicePosts(t, api, "Meanwhile?");
  await settle(t);
  assert.equal(t.worldUnsupported, true);
  assert.ok(api.posts.some((p) => p.content === "Ok."), "the turn went on");
  assert.equal(await t.declare("Y"), false);
});

// ---- casual mode: phones
const isolated = async (opts = {}) => {
  const r = await table({ ...opts, bob: true, heal: false });
  r.api.knowledgeMode = "isolated";
  r.t.channel.knowledge_mode = "isolated"; r.t.publicSplits = false; r.t.splitWarning = null;
  await r.t.setCasual(true); await settle(r.t);
  await r.t.refresh();
  return r;
};
const phoneOf = (t, id) => t.casual.phones[id];
const texts = (t, api, id) => api.posts.filter((p) => p.window === phoneOf(t, id) && p.kind === "ic");
const textFrom = (t, api, who, content) => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: phoneOf(t, who), author_id: who === "c-bob" ? "u-bob" : "u-alice", author_role: "player", character_id: who, content }) });

test("casual mode is refused on a public channel: phones would not be private", async () => {
  const { t, api } = await table({ bob: true });
  await t.setCasual(true);
  assert.deepEqual(t.casual.phones, {}); assert.equal(api.createdWindows.length, 0);
  assert.equal(t.casualOn(), false);
});

test("casual: each player character gets a private phone; a phone line never starts a scene turn", async () => {
  const { t, api, llm } = await isolated();
  assert.deepEqual(Object.keys(t.casual.phones).sort(), ["c-alice", "c-bob"]);
  const alicePhone = api.createdWindows.find((w) => w.id === phoneOf(t, "c-alice"));
  assert.equal(alicePhone.name, "Phone: Alice Hale"); assert.equal(alicePhone.kind, "private");
  assert.deepEqual(alicePhone.members.map((m) => m.user_id), ["u-bot", "u-alice"], "only her player");
  const log = api.createdWindows.find((w) => w.id === t.casual.log);
  assert.equal(log.name, "Phone log (Keeper only)"); assert.deepEqual(log.members.map((m) => m.user_id), ["u-bot"], "the Keeper alone");
  await t.setCasual(true);
  assert.equal(api.createdWindows.length, 3, "two phones and the log, opened once");
  const before = directorCalls(llm).length;
  await textFrom(t, api, "c-alice", "@Bob Price meet me at the pier");
  await settle(t);
  assert.equal(directorCalls(llm).length, before, "no scene turn");
  assert.deepEqual(texts(t, api, "c-bob").map((p) => [p.content, p.character_id]), [["meet me at the pier", "c-alice"]], "relayed to Bob's phone at once, as Alice");
  await textFrom(t, api, "c-bob", "On my way.");
  await settle(t);
  assert.deepEqual(texts(t, api, "c-alice").map((p) => [p.content, p.character_id]), [["On my way.", "c-bob"]], "a reply without @ goes back to the sender");
  assert.equal(await t.tick(), null, "phones never get autonomous turns");
});

test("casual: an NPC answers a text through the GM after a believable delay, and nothing happens in any scene", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (user) => (/^MODE: phone/m.test(user) ? { actions: [{ type: "text", from: "Mr. Grimsby", to: "Alice Hale", text: "Under the clock, miss.", delay_minutes: 30 }, { type: "narrate", text: "NOT-IN-A-SCENE" }], coplayers_may_act: true } : base(user));
  const { t, api, clock } = await isolated({ llm });
  await textFrom(t, api, "c-alice", "@Mr. Grimsby where is the key?");
  await settle(t);
  const call = llm.calls.filter((c) => c.purpose === "director").at(-1);
  assert.match(call.messages[0].content, /MODE: phone — Alice Hale texted Mr\. Grimsby/);
  assert.match(call.system, /"type": "text"/); assert.match(call.system, /Casual mode/);
  assert.equal(texts(t, api, "c-alice").length, 0, "not yet");
  assert.ok(!api.posts.some((p) => p.content === "NOT-IN-A-SCENE"), "a phone turn narrates nothing");
  clock.t += 31 * MIN;
  assert.equal(await t.deliverDue(), 1);
  assert.deepEqual(texts(t, api, "c-alice").map((p) => [p.content, p.character_id]), [["Under the clock, miss.", "c-butler"]]);
  assert.deepEqual(t.store.thread("c-alice", "c-butler").map((r) => r.text), ["where is the key?", "Under the clock, miss."]);
});

test("casual: a co-player answers a text in character, knowing only its own messages", async () => {
  const { t, api, llm, clock } = await isolated();
  await textFrom(t, api, "c-alice", "@Harriet are you coming?");
  await settle(t);
  const call = llm.calls.find((c) => c.purpose === "coplayer_phone");
  assert.ok(call.messages[0].content.includes("are you coming?") && call.messages[0].content.startsWith("YOU ARE: Harriet Vance"));
  assert.ok(!SECRETS.some((s) => call.messages[0].content.includes(s)), "no Keeper secrets");
  clock.t += 6 * MIN;
  await t.deliverDue();
  assert.deepEqual(texts(t, api, "c-alice").map((p) => p.character_id), ["c-harriet"]);
});

test("casual: a co-player may text a player first; without casual mode the GM has no text action", async () => {
  const llm = new MockLlm();
  llm.coplayer = (user) => (user.includes("YOUR PHONE") || /casual/i.test(user) ? { action: "text", to: "Alice Hale", text: "psst, look at the clock" } : { action: "text", to: "Alice Hale", text: "psst, look at the clock" });
  const { t, api } = await isolated({ llm });
  await alicePosts(t, api, "Hm.");
  await settle(t);
  assert.ok(texts(t, api, "c-alice").some((p) => p.character_id === "c-harriet" && p.content === "psst, look at the clock"));
  const plain = await table();
  await alicePosts(plain.t, plain.api, "Hm.");
  await settle(plain.t);
  assert.ok(!/"type": "text"/.test(plain.llm.calls.find((c) => c.purpose === "director").system));
});

test("casual: a line naming no known contact gets a hint, and nobody is texted", async () => {
  const { t, api } = await isolated();
  await textFrom(t, api, "c-alice", "@Nobody Atall hello?");
  await settle(t);
  assert.ok(api.posts.some((p) => p.window === phoneOf(t, "c-alice") && p.content.startsWith("(No one by that name")));
  assert.equal(t.store.phoneOf("c-alice").length, 0);
});

test("casual: addressing picks the longest name, prefers a full name, and needs no separator after a CJK name", async () => {
  const { parseAddress } = await import("../src/casual.mjs");
  const c = [{ id: "a", name: "Silas Mott" }, { id: "b", name: "Silas" }, { id: "z", name: "张三" }, { id: "m", name: "Mr. Grimsby" }];
  assert.deepEqual(parseAddress("@Silas Mott where?", c), { to: "a", body: "where?", addressed: true });
  assert.equal(parseAddress("@Silas hi", c).to, "b");
  assert.deepEqual(parseAddress("@张三在吗", c), { to: "z", body: "在吗", addressed: true });
  assert.equal(parseAddress("@Mr. Grimsby key?", c).to, "m");
  assert.equal(parseAddress("@Silasx hi", c).to, null);
  assert.deepEqual(parseAddress("no at", c), { to: null, body: "no at", addressed: false });
});

test("a co-player in another timeline never learns what happens in the Main Chat meanwhile, nor after it returns", async () => {
  // A Keeper that does not quote the chat back (the mock's placeholder narration repeats the newest line, which would
  // put an old Main Chat line in front of her as something said after her return).
  const llm = new MockLlm();
  llm.director = () => ({ actions: [{ type: "narrate", text: "Time passes." }], coplayers_may_act: true });
  const { t, api, clock } = await table({ llm, bob: true, cfg: { autonomySideIntervalMs: MIN } });
  await alicePosts(t, api, "We search the study together.");
  await settle(t);
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Lighthouse", span: "long" });
  await settle(t);
  const side = t.timelines.of("c-harriet").windowId;
  // While she is away, Alice plays on in the Main Chat and the Keeper answers there.
  await alicePosts(t, api, "MAIN-WHILE-AWAY: I open the safe and find the ledger.");
  await settle(t);
  clock.t += MIN + 1;
  await t.tick(); await settle(t);                         // her side thread moves on its own
  const harriet = () => llm.calls.filter((c) => c.purpose === "coplayer_turn" && c.messages[0].content.startsWith("YOU ARE: Harriet")).at(-1).messages[0].content;
  const away = harriet();
  assert.ok(away.includes("We search the study together."), "she remembers what she saw before leaving");
  assert.ok(!away.includes("MAIN-WHILE-AWAY"), "she never sees the Main Chat while she is away");
  assert.ok(!llm.calls.some((c) => c.purpose === "coplayer_memory" && c.messages[0].content.includes("MAIN-WHILE-AWAY")));
  // She comes back: only what is said from then on reaches her.
  await t.command({ cmd: "rejoin", timeline: "Lighthouse" });
  await settle(t);
  await alicePosts(t, api, "Harriet, you're back! What did you find?");
  await settle(t);
  const back = harriet();
  assert.ok(back.includes("you're back"), "she hears the Main Chat again");
  assert.ok(!back.includes("MAIN-WHILE-AWAY"), "but not what happened there while she was away");
  assert.ok(side && t.timelines.retired(side));
});

// ---- the story planner
const pcfg = (over = {}) => ({ planner: { ...buildConfig({}, {}).planner, cooldownMs: 0, stallTurns: 1000, ...over } });
const plannerCalls = (llm) => llm.calls.filter((c) => c.purpose === "planner");
const stepOf = (c) => (c.messages.at(-1).content.match(/^STEP: (\w+)/m) ?? [])[1];
const planned = async (t, api, n = 10) => { for (let i = 0; i < n; i++) { await alicePosts(t, api, `Line ${i}: we ask around the harbour about the keeper.`); await settle(t); } await t.memoryIdle(); await settle(t); };

test("the first story plan: drafted, critiqued and revised in one cached conversation, adopted at the turn boundary, noted once", async () => {
  const { t, api, llm } = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  await planned(t, api);
  const arc = t.planner.arc;
  assert.ok(arc, "a plan was adopted"); assert.equal(arc.version, 1); assert.equal(arc.trigger, "first"); assert.equal(arc.mode, "full");
  assert.equal(arc.beat.title, "[mock beat] The present trouble"); assert.equal(arc.threads[0].id, "P1");
  const calls = plannerCalls(llm);
  assert.deepEqual(calls.map(stepOf), ["draft", "critique", "revise"], "three steps, in order");
  assert.ok(calls[1].messages[0].content === calls[0].messages[0].content && calls[1].messages[1].role === "assistant", "the critique continues the draft's conversation");
  assert.ok(calls[0].parts[0][0].cache && calls[0].parts[0][0].text.includes("## Campaign") && calls[0].parts[0][0].text.includes("## Previous story plan"), "the context is one cached part");
  assert.ok(calls[2].parts.flat().filter((p) => p.cache).length <= 3, "at most three cache marks");
  assert.match(calls[0].system, /story planner/); assert.match(calls[0].system, /Be bold/);
  const notes = api.posts.filter((p) => p.visibility === "gm_only" && p.content.startsWith("Story plan v1"));
  assert.equal(notes.length, 1); assert.match(notes[0].content, /beat "\[mock beat\] The present trouble"/); assert.match(notes[0].content, /Impulse for Harriet Vance/);
  await t.adoptPlan();
  assert.equal(api.posts.filter((p) => p.content.startsWith("Story plan v1")).length, 1, "adoption is idempotent");
  assert.ok(t.store.latestPlan().record.draft && t.store.latestPlan().record.critique && t.store.latestPlan().record.final);
  // The GM reads the plan in part C only; a co-player reads its impulse, never the plan; the GM never reads the impulse.
  await alicePosts(t, api, "Harriet, what do you think?");
  await settle(t);
  const director = llm.calls.filter((c) => c.purpose === "director").at(-1);
  const parts = director.parts[0];
  assert.ok(!parts[0].text.includes("## Story plan"), "not in A");
  assert.ok(parts.slice(1, -1).some((p) => p.cache && p.text.includes("## Story plan") && p.text.includes("[mock twist]")), "in a cached middle part");
  assert.match(director.system, /Story plan: your private plan/); assert.match(director.system, /"type": "planner_note"/);
  assert.ok(!director.messages[0].content.includes("[mock impulse]"), "the GM never reads an impulse");
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn" && c.messages[0].content.startsWith("YOU ARE: Harriet")).at(-1).messages[0].content;
  assert.ok(cp.includes("SOMETHING ON YOUR MIND") && cp.includes("[mock impulse]"), "Harriet has her impulse");
  assert.ok(!cp.includes("[mock twist]") && !cp.includes("Story plan"), "and nothing of the plan");
  assert.deepEqual(require_(plannerStateRoundTrip(t)), require_(t.planner), "the state survives a save and reload");
});
import { plannerState as _plannerState } from "../src/planner.mjs";
const plannerStateRoundTrip = (t) => _plannerState(JSON.parse(JSON.stringify(t.planner)));
const require_ = (x) => JSON.parse(JSON.stringify(x));

test("the planner's MOVE ON lifts the scenario pace guard; the change closes the beat and spends the verdict", async () => {
  const llm = new MockLlm();
  const base = llm.planner.bind(llm);
  // Only the first plan says move on; the replan after the scenario change (trigger "scenario") goes back to "continue".
  llm.planner = (u) => { const r = base(u); if (r.verdict && u.includes("(none yet: this is the first plan)")) r.verdict = { move_on: true, why: "they have searched the same office for six turns" }; return r; };
  const { t, api, clock } = await table({ llm, improv: IMPROV, heal: true, cfg: { ...pcfg(), scenarioMinMinutes: 20, scenarioMinLines: 30 } });
  t.scenario = { id: "sc1", since: clock.t };
  await planned(t, api);
  assert.equal(t.planner.arc.verdict.moveOn, true);
  const v = await t.scenarioVerdict("w-main", "human");
  assert.equal(v.planner, true, JSON.stringify(v));
  assert.equal((await t.scenarioVerdict("w-main", "quiet")).ok, false, "still never in an autonomous turn");
  const before = api.advanced.length;
  await alicePosts(t, api, "We sleep. The next morning we set out.");
  await settle(t);
  assert.equal(api.advanced.length, before + 1, "advanced before the 20 minutes and 30 lines");
  assert.match(directorCalls(llm).find((u) => u.includes("The next morning we set out.") && !/^MODE: /m.test(u)), /PLANNER: the story planner judges the current event/);
  await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.version, 2); assert.equal(t.planner.arc.trigger, "scenario", "the change asked for a new plan");
  assert.equal(t.planner.arc.verdict.moveOn, false, "spent");
  assert.equal((await t.scenarioVerdict("w-main", "human")).ok, false, "the guard is back");
});

test("module-led campaign: the planner judges pace only", async () => {
  const { t, api, llm } = await table({ cfg: pcfg() });
  await planned(t, api);
  assert.equal(t.planner.arc.mode, "pace");
  assert.match(plannerCalls(llm)[0].system, /the module has the plots/); assert.doesNotMatch(plannerCalls(llm)[0].system, /Be bold/);
  assert.deepEqual([t.planner.arc.threads, t.planner.arc.next, t.planner.impulses], [[], [], []]);
  assert.match(t.storyPlanSection(), /^## Story plan \(pace only/);
  await alicePosts(t, api, "Harriet?"); await settle(t);
  assert.ok(!llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content.includes("SOMETHING ON YOUR MIND"));
});

test("a stalled story asks the planner again; a planner_note from the GM does too, and closes the beat", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (u) => (u.includes("I give up") && !/^MODE: /m.test(u) ? { actions: [{ type: "planner_note", text: "They skipped the warehouse entirely.", beat_done: true }, { type: "narrate", text: "Noted." }], coplayers_may_act: false } : base(u));
  const { t, api } = await table({ llm, improv: IMPROV, heal: true, cfg: pcfg({ intervalMs: 10 * 3600000, minLines: 100000 }) });
  await planned(t, api);
  assert.equal(t.planner.arc.version, 1);
  t.cfg.planner.stallTurns = 3;
  for (let i = 0; i < 4; i++) { await alicePosts(t, api, `Still here ${i}.`); await settle(t); }
  await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.version, 2); assert.equal(t.planner.arc.trigger, "stall");
  await alicePosts(t, api, "I give up on the office."); await settle(t);
  assert.ok(api.posts.some((p) => p.visibility === "gm_only" && p.content === "Planner note: They skipped the warehouse entirely."));
  await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.trigger, "asked"); assert.equal(t.planner.arc.version, 3);
  const briefing = plannerCalls(llm).at(-3).messages[0].content;
  assert.ok(briefing.includes('"They skipped the warehouse entirely." (beat done)'), "the note, and that the beat is done, reached the planner");
});

test("the planner stays quiet when off, over budget, or with the interval at 0; plan now still works", async () => {
  const off = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  await off.t.command({ cmd: "plan", action: "off" });
  await planned(off.t, off.api);
  assert.equal(off.t.planner.arc, null); assert.equal(plannerCalls(off.llm).length, 0); assert.equal(off.t.storyPlanSection(), "");
  const budget = await table({ improv: IMPROV, heal: true, cfg: { ...pcfg(), dailyTokenBudget: 1 } });
  await alicePosts(budget.t, budget.api, "Hm."); await settle(budget.t);
  await planned(budget.t, budget.api);
  assert.equal(budget.t.planner.arc, null);
  await assert.rejects(budget.t.command({ cmd: "plan", action: "now" }), /budget/);
  const manual = await table({ improv: IMPROV, heal: true, cfg: pcfg({ intervalMs: 0 }) });
  await planned(manual.t, manual.api);
  assert.equal(manual.t.planner.arc.version, 1, "a first plan still happens");
  await planned(manual.t, manual.api, 50);
  assert.equal(manual.t.planner.arc.version, 1, "then nothing automatic");
  await manual.t.command({ cmd: "plan", action: "now" });
  assert.equal(manual.t.planner.arc.version, 2); assert.equal(manual.t.planner.arc.trigger, "manual");
});

// ---- sessions, the final review, the calendar, and what everyone knows about each other
test("nobody online: an away side turn never starts the planner, even when a plan is due", async () => {
  const { t, api, llm, clock } = await table({ improv: IMPROV, heal: true, cfg: { ...pcfg(), autonomyIdleMinutes: 30, awaySideIntervalMs: 6 * 3600000, autonomySideIntervalMs: MIN } });
  await planned(t, api);
  const calls = plannerCalls(llm).length;
  await t.command({ cmd: "split", who: ["Harriet Vance"], place: "Lighthouse", span: "long" });
  await settle(t);
  t.planner.asked = { why: "the Keeper asked", at: clock.t };   // due, if anyone were here
  t.planner.session = null;
  clock.t += 7 * 3600000;
  const before = t.turns;
  assert.notEqual(await t.tick(), null); await settle(t); await t.memoryIdle(); await settle(t);
  assert.equal(t.turns, before + 1, "the side thread moved on its own");
  assert.equal(plannerCalls(llm).length, calls, "but the planner did not run");
  await alicePosts(t, api, "I'm back."); await settle(t); await t.memoryIdle(); await settle(t);
  assert.equal(plannerCalls(llm).length, calls + 3, "a player's line, and it runs");
});

test("the final review: when the players leave, one review moves the calendar on, acts off-screen and prepares the next session", async () => {
  const { t, api, llm, clock } = await table({ improv: IMPROV, casual: { on: true }, heal: true, cfg: { ...pcfg(), autonomyIdleMinutes: 30 } });
  await planned(t, api);                                   // ten player lines; the first plan sets the first date
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-02", "early morning"]); assert.equal(t.calendar.log.at(-1).by, "planner");
  assert.equal(t.planner.session.lines, 10);
  const calls = plannerCalls(llm).length;
  clock.t += 29 * 60000;
  assert.equal(t.checkSessionEnd(), null, "not yet: the players may still be thinking");
  clock.t += 2 * 60000;
  const job = t.checkSessionEnd();
  assert.ok(job, "the session is over"); await job; await t.memoryIdle(); await settle(t);
  const review = plannerCalls(llm).slice(calls);
  assert.equal(review.length, 3, "draft, critique, revise");
  assert.match(review[0].system, /FINAL REVIEW/); assert.match(review[0].messages[0].content, /This is the FINAL REVIEW/);
  assert.match(review[0].messages[0].content, /The session that just ended: 10 player lines/);
  assert.match(review[1].messages.at(-1).content, /final review of a session/);
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-04", "morning"]);
  assert.equal(t.calendar.log.at(-1).by, "final review");
  assert.deepEqual(api.declared.at(-1), { text: "[mock offscreen] The Guild doubled the night watch at the docks.", secret: true });
  const note = api.posts.find((p) => p.visibility === "gm_only" && p.content.startsWith("Final review of the session"));
  assert.ok(note, "a Keeper-only note");
  assert.match(note.content, /Calendar: 1923-10-02 \(Tuesday\), early morning → 1923-10-04 \(Thursday\), morning/); assert.match(note.content, /1 secret/); assert.match(note.content, /Next session opens: \[mock opening\]/);
  assert.equal(t.planner.session, null); assert.equal(t.planner.arc.trigger, "final");
  clock.t += 3600000;
  assert.equal(t.checkSessionEnd(), null, "once per session");
  // The next session opens from what the review prepared, once.
  await alicePosts(t, api, "Good morning, everyone."); await settle(t);
  const first = directorCalls(llm).find((u) => u.includes("Good morning, everyone.") && !/^MODE: /m.test(u));
  assert.match(first, /BETWEEN SESSIONS: this is the first turn of a new session\. Since the last one, 2 day\(s\) passed in the story \(now: 1923-10-04 \(Thursday\), morning\)/);
  assert.match(first, /\[mock offscreen\] The Guild doubled the night watch at the docks\. \[secret/); assert.match(first, /\[mock opening\] A knock at the door at dawn\./);
  assert.match(first, /Today in the story: 1923-10-04 \(Thursday\), morning/);
  assert.equal(t.planner.between, null);
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.match(cp, /TODAY IN THE STORY: 1923-10-04 \(Thursday\), morning/);
  assert.match(cp, /TIME HAS PASSED since you last spoke: 2 day\(s\)/);
  assert.ok(!cp.includes("[mock offscreen]") && !cp.includes("[mock opening]") && !cp.includes("[mock recap]"), "nothing of the review itself");
  await alicePosts(t, api, "Shall we?"); await settle(t);
  assert.doesNotMatch(directorCalls(llm).find((u) => u.includes("NEWEST LINE: Alice Hale: Shall we?")), /BETWEEN SESSIONS/);
});

test("a short session, or the final review turned off, ends without one; stopping run reviews the session first", async () => {
  const short = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  await alicePosts(short.t, short.api, "Just checking in."); await settle(short.t);
  short.clock.t += 31 * 60000;
  const before = plannerCalls(short.llm).length;
  assert.equal(short.t.checkSessionEnd(), null); assert.equal(short.t.planner.session, null, "closed without a review");
  await short.t.memoryIdle();
  assert.equal(plannerCalls(short.llm).length, before, "no final review");
  const off = await table({ improv: IMPROV, heal: true, cfg: pcfg({ finalReview: false, finalReviewMinLines: 1 }) });
  await alicePosts(off.t, off.api, "Hm."); await settle(off.t);
  off.clock.t += 31 * 60000;
  const offCalls = plannerCalls(off.llm).length;
  assert.equal(off.t.checkSessionEnd(), null); await off.t.memoryIdle();
  assert.equal(plannerCalls(off.llm).length, offCalls);
  const stop = await table({ improv: IMPROV, casual: { on: true }, heal: true, cfg: pcfg({ finalReviewMinLines: 2 }) });
  await alicePosts(stop.t, stop.api, "One."); await settle(stop.t);
  await alicePosts(stop.t, stop.api, "Two, and I have to go."); await settle(stop.t);
  assert.equal(await stop.t.finishSession(), true);
  assert.equal(stop.t.planner.arc.trigger, "final");
  assert.equal(stop.t.calendar.date, "1923-10-04", "the first date, then two days on");
  assert.equal(await stop.t.finishSession(), false, "nothing left to review");
});

test("the Keeper's date and bond actions; traits, gender and relationships, and who knows what about whom", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (u) => (u.includes("NEWEST LINE: Alice Hale: We rest for the night.") && !/^MODE: /m.test(u)
    ? { actions: [
      { type: "date", date: "1923-10-02", time: "night" }, { type: "date", advance_days: 1, time: "dawn", reason: "a night's rest" }, { type: "date", date: "1923-09-01" },
      { type: "bond", a: "Alice Hale", b: "Harriet Vance", kind: "lives with", note: "they share rooms" },
      { type: "bond", a: "Mr. Grimsby", b: "Lady Ashcombe", kind: "lovers", secret: true },
      { type: "bond", a: "Mr. Grimsby", b: "Harriet Vance", kind: "family", note: "her uncle", secret: true },
      { type: "bond", a: "Mr. Grimsby", b: "Alice Hale", kind: "rivals" },
      { type: "npc", name: "Mr. Grimsby", text: "Good night, miss." }, { type: "narrate", text: "Dawn comes grey." }], coplayers_may_act: true }
    : base(u));
  const lady = { id: "c-lady", name: "Lady Ashcombe", kind: "npc", user_id: null, bio: "LADY-BRIEF: owns the mill", role_card: { basic: { sex: "female", age: "40" }, characteristics: { APP: 90, INT: 85 } } };
  const { t, api } = await table({ llm, casual: { on: true }, extraCharacters: [lady] });
  api.characters_[0].role_card.characteristics = { INT: 88, APP: 50 };
  api.characters_[0].role_card.basic.sex = "female";
  Object.assign(api.characters_[2].role_card, { basic: { sex: "male", age: "62" }, characteristics: { SIZ: 90 } });
  await alicePosts(t, api, "We rest for the night."); await settle(t);
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-03", "dawn"], "set, moved on a day; the earlier date refused");
  assert.equal(t.bonds.length, 4);
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.match(cp, /TODAY IN THE STORY: 1923-10-03 \(Wednesday\), dawn/);
  assert.match(cp, /notable: extremely intelligent/, "she knows what is striking about Alice");
  assert.doesNotMatch(cp, /\b88\b/, "never the number");
  assert.match(cp, /PEOPLE YOU HAVE MET[^\n]*\n- Mr\. Grimsby \(male, 62; very large, imposing build\)/, "Grimsby spoke in her scene");
  assert.ok(!cp.includes("Lady Ashcombe"), "Lady Ashcombe she has never met, nor her secret affair");
  assert.ok(!cp.includes("knows where the key is") && !cp.includes("LADY-BRIEF"), "never the Keeper's brief");
  assert.match(cp, /Alice Hale — Harriet Vance \(you\): lives with \(they share rooms\)/);
  assert.match(cp, /Mr\. Grimsby — Harriet Vance \(you\): family \(her uncle\)/, "her own secret bond");
  assert.match(cp, /Mr\. Grimsby — Alice Hale: rivals/);
  await alicePosts(t, api, "Morning, Mr. Grimsby."); await settle(t);
  const gm = directorCalls(llm).find((u) => u.includes("NEWEST LINE: Alice Hale: Morning, Mr. Grimsby.") && !/^MODE: /m.test(u));
  assert.match(gm, /## Calendar[^\n]*\nToday in the story: 1923-10-03 \(Wednesday\), dawn/);
  assert.match(gm, /## Relationships[\s\S]*Mr\. Grimsby — Lady Ashcombe: lovers \[secret\]/);
  assert.match(gm, /- Lady Ashcombe \(female, 40; extremely good-looking, striking; extremely intelligent\): /, "the Keeper's cast");
  assert.match(gm, /- Mr\. Grimsby \(male, 62; very large, imposing build\): /);
  assert.match(gm, /- Alice Hale \(played by alice\)\n[^\n]*gender: female[\s\S]*notable: extremely intelligent/);
  assert.match(llm.calls.find((c) => c.purpose === "director").system, /"type": "date"[\s\S]*"type": "bond"/);
  // The operator's commands.
  await t.command({ cmd: "bond", a: "Alice Hale", b: "Mr. Grimsby", kind: "rivals", end: true });
  assert.equal(t.bonds.length, 3);
  await t.command({ cmd: "date", days: 2, time: "noon" });
  assert.deepEqual([t.calendar.date, t.calendar.time, t.calendar.log.at(-1).by], ["1923-10-05", "noon", "operator"]);
  await assert.rejects(t.command({ cmd: "date", date: "1900-01-01" }), /never runs backwards/);
  await assert.rejects(t.command({ cmd: "bond", a: "Nobody", b: "Alice Hale", kind: "friends" }), /no character named Nobody/);
});

test("the first date and the everyday routine come from the planner, from the world's own calendar; the GM and the co-players read them", async () => {
  const llm = new MockLlm();
  const baseDirector = llm.director.bind(llm);
  llm.director = (u) => (u.includes("NEWEST LINE: Alice Hale: What day is it?") && !/^MODE: /m.test(u) ? { actions: [{ type: "date", date: "1999-12-31", time: "noon" }, { type: "narrate", text: "Hard to say." }], coplayers_may_act: true } : baseDirector(u));
  const world = `${IMPROV.world}\n\n## The fishing year\nWORLD-CALENDAR: the herring run starts in October; the Harbour Fair is held on the first Saturday after the run begins.`;
  const { t, api } = await table({ llm, improv: { ...IMPROV, world }, casual: { on: true }, heal: true, cfg: pcfg() });
  await alicePosts(t, api, "What day is it?"); await settle(t);
  await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.trigger, "first", "no date: the first plan comes after the first line");
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-02", "early morning"], "the planner's date and time of day, not the Keeper's");
  assert.equal(t.calendar.log.find((e) => e.to.includes("1923")).by, "planner");
  const draft = plannerCalls(llm)[0];
  assert.match(draft.system, /choosing the first one is your job/); assert.match(draft.system, /Routine: everyday life follows a calendar/);
  assert.ok(draft.messages[0].content.includes("WORLD-CALENDAR"), "the planner reads the world's own calendar");
  assert.match(draft.messages[0].content, /"routine": "what everyday life is busy with/);
  assert.match(t.calendar.routine.text, /\[mock routine\] The herring season/);
  await alicePosts(t, api, "Harriet, shall we go down to the market?"); await settle(t);
  const gm = directorCalls(llm).find((u) => u.includes("shall we go down to the market?") && !/^MODE: /m.test(u));
  assert.match(gm, /Today in the story: 1923-10-02 \(Tuesday\), early morning\nEveryday life now: \[mock routine\] The herring season[^\n]*Coming up: \[mock\] the Harbour Fair on the quay \(next Saturday\)\./);
  assert.match(llm.calls.find((c) => c.purpose === "director").system, /The story planner chooses the first date/);
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.match(cp, /TODAY IN THE STORY: 1923-10-02 \(Tuesday\), early morning/);
  assert.match(cp, /Everyday life now: \[mock routine\] The herring season.*\(common knowledge: everyone in the story knows it\)/);
  // A routine is common knowledge: one quoting a secret is dropped; the next date move marks it as dated.
  t.applyRoutine({ routine: "Everyone says the Guild master drowned the lighthouse keeper.", upcoming: [] });
  assert.match(t.calendar.routine.text, /herring season/, "kept the old one");
  t.moveCalendar({ days: 1, by: "keeper" });
  assert.match(renderCalendarOf(t), /Everyday life now \(as of 1923-10-02 \(Tuesday\)\)/);
});
import { renderCalendar as _renderCalendar } from "../src/calendar.mjs";
const renderCalendarOf = (t) => _renderCalendar(t.calendar);

test("a solemn game keeps no date: no calendar for anyone, no date action, and the final review moves no calendar", async () => {
  const llm = new MockLlm();
  const base = llm.director.bind(llm);
  llm.director = (u) => (u.includes("NEWEST LINE: Alice Hale: We rest.") && !/^MODE: /m.test(u) ? { actions: [{ type: "date", date: "1923-10-02", advance_days: 1 }, { type: "narrate", text: "Night falls." }], coplayers_may_act: true } : base(u));
  const { t, api, clock } = await table({ llm, improv: IMPROV, heal: true, cfg: { ...pcfg(), autonomyIdleMinutes: 30 } });
  await alicePosts(t, api, "We rest."); await settle(t);
  await planned(t, api);
  assert.equal(t.planner.arc.trigger, "first"); assert.equal(t.calendar.date, "", "no date");
  const director = llm.calls.find((c) => c.purpose === "director");
  assert.doesNotMatch(director.system, /"type": "date"|advance_days|- Time:/);
  assert.ok(!director.messages[0].content.includes("## Calendar"));
  const draft = plannerCalls(llm)[0];
  assert.doesNotMatch(draft.system, /Time \(a casual game|Routine:/); assert.doesNotMatch(draft.messages[0].content, /"calendar": \{/);
  assert.ok(!llm.calls.filter((c) => c.purpose === "coplayer_turn").some((c) => c.messages[0].content.includes("TODAY IN THE STORY")));
  clock.t += 31 * 60000;
  await t.checkSessionEnd(); await t.memoryIdle(); await settle(t);
  const review = plannerCalls(llm).filter((c) => c.messages[0].content.includes("This is the FINAL REVIEW"));
  assert.equal(review.length, 3, "the final review still runs");
  assert.doesNotMatch(review[0].system, /advance_days/); assert.doesNotMatch(review[0].messages[0].content, /"advance_days"/);
  assert.equal(t.calendar.date, ""); assert.equal(t.calendar.log.length, 0);
  const note = api.posts.find((p) => p.content.startsWith("Final review of the session"));
  assert.doesNotMatch(note.content, /Calendar/); assert.match(note.content, /Off-screen: 1 development/);
  await alicePosts(t, api, "Back again."); await settle(t);
  const first = directorCalls(llm).find((u) => u.includes("NEWEST LINE: Alice Hale: Back again.") && !/^MODE: /m.test(u));
  assert.match(first, /BETWEEN SESSIONS: this is the first turn of a new session\. Meanwhile, off-screen:/);
  assert.doesNotMatch(first, /day\(s\) passed|what day and time/);
  await assert.rejects(t.command({ cmd: "date", days: 1 }), /only in a casual game/);
});

test("a plan made before the platform's first scenario is not redone when that scenario opens; a later change still is", async () => {
  const { t, api, llm } = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  t.scenario = null;
  await planned(t, api);
  assert.equal(t.planner.arc.version, 1); assert.equal(t.planner.scenarioId, null);
  t.onEvent({ stream: "chat", type: "scene.changed", channel_id: "ch", scene: { id: "sc1", status: "active" } });
  await alicePosts(t, api, "Onward."); await settle(t); await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.version, 1, "the first scenario is no change");
  t.onEvent({ stream: "chat", type: "scene.changed", channel_id: "ch", scene: { id: "sc2", status: "active" } });
  await alicePosts(t, api, "Onward again."); await settle(t); await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.version, 2); assert.equal(t.planner.arc.trigger, "scenario");
  assert.ok(plannerCalls(llm).length === 6);
});

test("turning casual mode on mid-campaign asks the planner for the story's first date", async () => {
  const { t, api } = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  await planned(t, api);
  assert.equal(t.planner.arc.calendar, null, "a solemn game's plan carries no calendar");
  assert.doesNotMatch(t.storyPlanSection(), /Calendar:/);
  await t.command({ cmd: "casual", on: true });
  await alicePosts(t, api, "Let's take it easy for a while."); await settle(t); await t.memoryIdle(); await settle(t);
  assert.equal(t.planner.arc.trigger, "asked");
  assert.deepEqual([t.calendar.date, t.calendar.time], ["1923-10-02", "early morning"]);
});

// ---- the table's own windows: the phone log, the planner window, new players
const COPLAYER2 = { id: "c-tomas", name: "Tomas Leclerc", kind: "pc", user_id: "u-bot", player_name: "AI Keeper", bio: "A journalist.", role_card: {} };
const logLines = (t, api) => api.posts.filter((p) => p.window === t.casual.log && p.kind === "ic");

test("casual: texts between co-players and NPCs go to the Keeper's phone log, answered in their own time, and stop before they run away", async () => {
  const llm = new MockLlm();
  const baseCp = llm.coplayer.bind(llm);
  // Harriet texts Tomas when Alice asks her to; Tomas and Harriet then answer each other through their own models.
  llm.coplayer = (u) => (u.startsWith("YOU ARE: Harriet Vance") && u.includes("NEWEST LINE: #") && u.includes("Text Tomas") ? { action: "text", to: "Tomas Leclerc", text: "Meet me at the pier at nine." } : baseCp(u));
  const { t, api, clock } = await isolated({ llm, extraCharacters: [COPLAYER2], cfg: { casualAiChain: 3 } });
  const phonesBefore = api.posts.filter((p) => Object.values(t.casual.phones).includes(p.window) && p.kind === "ic").length;
  await alicePosts(t, api, "Harriet, please. Text Tomas."); await settle(t);
  assert.deepEqual(logLines(t, api).map((p) => [p.content, p.character_id]), [["→ Tomas Leclerc: Meet me at the pier at nine.", "c-harriet"]], "in the log, as Harriet");
  await settle(t);
  const cpPhone = llm.calls.filter((c) => c.purpose === "coplayer_phone");
  assert.equal(cpPhone.length, 1, "Tomas reads it"); assert.match(cpPhone[0].system, /You play Tomas Leclerc/);
  clock.t += 6 * MIN; await t.deliverDue(); await settle(t);
  assert.equal(logLines(t, api).at(-1).character_id, "c-tomas"); assert.match(logLines(t, api).at(-1).content, /^→ Harriet Vance: \[mock Tomas Leclerc\] On my way\./);
  clock.t += 6 * MIN; await t.deliverDue(); await settle(t);
  clock.t += 6 * MIN; await t.deliverDue(); await settle(t);
  assert.equal(logLines(t, api).length, 3, "three texts, then the exchange rests (casual.ai_chain 3)");
  clock.t += 60 * MIN; await t.deliverDue(); await settle(t);
  assert.equal(logLines(t, api).length, 3);
  assert.equal(api.posts.filter((p) => Object.values(t.casual.phones).includes(p.window) && p.kind === "ic").length, phonesBefore, "no player's phone saw any of it");
  assert.deepEqual(t.store.phoneOf("c-tomas").map((r) => r.from), ["c-harriet", "c-tomas", "c-harriet"], "both remember the thread");
  // An NPC answers a co-player through the GM, in the log.
  const base = llm.director.bind(llm);
  llm.director = (u) => (/^MODE: phone — Harriet Vance texted Mr\. Grimsby/m.test(u) ? { actions: [{ type: "text", from: "Mr. Grimsby", to: "Harriet Vance", text: "The key is not mine to give.", delay_minutes: 0 }], coplayers_may_act: false } : base(u));
  llm.coplayer = (u) => (u.startsWith("YOU ARE: Harriet Vance") && u.includes("Ask Grimsby") ? { action: "text", to: "Mr. Grimsby", text: "Where is the key?" } : baseCp(u));
  await alicePosts(t, api, "Harriet? Ask Grimsby by text."); await settle(t); await settle(t);
  assert.ok(logLines(t, api).some((p) => p.content === "→ Mr. Grimsby: Where is the key?" && p.character_id === "c-harriet"));
  assert.ok(logLines(t, api).some((p) => p.content === "→ Harriet Vance: The key is not mine to give." && p.character_id === "c-butler"), "Grimsby's answer, through the GM");
  const phoneTurn = directorCalls(llm).find((u) => /^MODE: phone — Harriet Vance texted Mr\. Grimsby/m.test(u));
  assert.match(phoneTurn, /## Chat in "Phone log \(Keeper only\)"[\s\S]*Where is the key\?/, "the Keeper reads the log when answering");
  await alicePosts(t, api, "Anything new?"); await settle(t);
  assert.match(directorCalls(llm).find((u) => u.includes("NEWEST LINE: Alice Hale: Anything new?")), /## Recent lines in "Phone log \(Keeper only\)"[\s\S]*The key is not mine to give\./, "and in every other turn");
  // Nobody at the table: a text still arrives, but no one answers it.
  const answers = llm.calls.filter((c) => c.purpose === "coplayer_phone").length;
  t.aiText("c-butler", "c-tomas", "Stay away from the pier.");
  clock.t += 3 * 3600000; await t.deliverDue(); await settle(t);
  assert.ok(logLines(t, api).some((p) => p.content === "→ Tomas Leclerc: Stay away from the pier."));
  assert.equal(llm.calls.filter((c) => c.purpose === "coplayer_phone").length, answers, "everyone is away: no answer");
  assert.equal(await t.tick(), null, "the log never gets a turn");
});

test("the planner window: every player sits in it; wishes and corrections reach the planner, the Keeper and (corrections only) the co-players", async () => {
  const { t, api, llm } = await table({ improv: IMPROV, heal: true, cfg: pcfg() });
  const w = api.createdWindows.find((x) => x.id === t.planner.window);
  assert.equal(w.name, "To the story planner"); assert.deepEqual(w.members.map((m) => m.user_id), ["u-bot", "u-alice"]);
  assert.ok(api.posts.some((p) => p.window === w.id && p.kind === "ooc" && p.content.startsWith("🧭 This window is for the story planner")));
  const turns = t.turns;
  const say = (content) => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: w.id, author_id: "u-alice", author_name: "alice", author_role: "player", character_id: "c-alice", content }) });
  say("Harriet would never leave a friend behind.");
  say("I'd love a slow-burn rivalry with the harbour master.");
  await settle(t);
  assert.equal(t.turns, turns, "no turn is played there"); assert.equal(t.planner.session, null, "and it is no play");
  await t.memoryIdle();
  assert.equal(plannerCalls(llm).length, 0, "no run of its own: the planner keeps its routine");
  assert.equal(t.planner.inbox.length, 2, "the lines wait for the next run");
  await planned(t, api);   // the planner's usual first plan comes after ten lines of play
  assert.equal(t.planner.arc.trigger, "first");
  const draft = plannerCalls(llm)[0];
  assert.match(draft.system, /The players can write to you/);
  assert.match(draft.messages[0].content, /## The players' words to you[^\n]*\n- alice: Harriet would never leave a friend behind\.\n- alice: I'd love a slow-burn rivalry/);
  assert.deepEqual(t.planner.table.map((n) => [n.id, n.kind, n.about]), [["N1", "correction", ["Harriet Vance"]], ["N2", "wish", []]]);
  assert.equal(t.planner.inbox.length, 0, "read");
  const reply = api.posts.filter((p) => p.window === w.id && p.kind === "ooc").at(-1);
  assert.equal(reply.content, "🧭 [mock reply] Noted 2 line(s): the story will follow.");
  await alicePosts(t, api, "Harriet, the clock?"); await settle(t);
  const gm = directorCalls(llm).at(-2);
  assert.match(gm, /## The players' wishes and corrections[\s\S]*Corrections:[^\n]*\n- N1: \[mock note\] Harriet would never leave a friend behind\. \(about Harriet Vance\)[\s\S]*Wishes:[^\n]*\n- N2: \[mock note\] I'd love a slow-burn rivalry/);
  const cp = llm.calls.filter((c) => c.purpose === "coplayer_turn").at(-1).messages[0].content;
  assert.match(cp, /TABLE CORRECTIONS[^\n]*\n- \[mock note\] Harriet would never leave a friend behind\./);
  assert.ok(!cp.includes("slow-burn rivalry"), "a wish is the planner's to weave in, never a co-player's to play to");
  // The next words refine the notes; the standing ones are shown to the planner by id.
  say("Actually, no rivalry after all.");
  await t.command({ cmd: "plan", action: "now" }); await settle(t);
  assert.match(plannerCalls(llm).at(-3).messages[0].content, /## Standing table notes[^\n]*\n- N1 \[correction\][\s\S]*- N2 \[wish\]/);
});

test("a new player is seated in the planner window, gets a phone in casual mode, and the Keeper brings their character in", async () => {
  const { t, api, llm } = await isolated({ cfg: pcfg() });
  await t.ensureTableWindows();
  assert.ok(t.planner.window && t.casual.log, "planner window and phone log");
  const before = Object.keys(t.casual.phones).length;
  api.channelUsers.push("u-cara");
  api.characters_.push({ id: "c-cara", name: "Cara Lind", kind: "pc", user_id: "u-cara", player_name: "cara", role_card: { basic: { sex: "female" } } });
  api.windows_[0].members.push({ user_id: "u-cara", character_id: "c-cara", character_name: "Cara Lind" });
  t.onEvent({ stream: "chat", type: "window.changed", channel_id: "ch", window: { id: "w-main" } });
  await settle(t); await t.ensureTableWindows(); await settle(t);
  assert.ok(api.addedMembers.some((m) => m.window === t.planner.window && m.user_id === "u-cara"), "seated in the planner window");
  assert.equal(Object.keys(t.casual.phones).length, before + 1); assert.ok(t.casual.phones["c-cara"], "her phone");
  assert.equal(api.createdWindows.find((w) => w.id === t.casual.phones["c-cara"]).name, "Phone: Cara Lind");
  const welcome = directorCalls(llm).find((u) => u.includes("a new player just joined the table with Cara Lind"));
  assert.ok(welcome, "the Keeper brings her in"); assert.match(welcome, /Bring this character into the story here, naturally/);
  assert.ok(t.timelines.main().members.includes("c-cara"));
  await t.refresh(); await settle(t);
  assert.equal(directorCalls(llm).filter((u) => u.includes("a new player just joined the table")).length, 1, "welcomed once");
});
