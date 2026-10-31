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
      { id: "c-harriet", name: "Harriet Vance", kind: "npc", user_id: null, speaking_style: markStyle("dry wit"), bio: "A sharp antiquarian.",
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
  async channelMembers() { return this.channelUsers.map((id) => ({ id })); }
  async addWindowMember() { this.membershipWrites++; return []; }
  async serverSettings() { return { language: "en", features: {} }; }
  async coc7Rules() { return { skills: [{ name: "Spot Hidden", base: 25, names: {} }], families: [] }; }
  async characters() { return structuredClone(this.characters_); }
  async windows() { return structuredClone(this.windows_.map((w) => ({ ...w, last_seq: Math.max(0, ...this.lines.filter((m) => m.chat_window_id === w.id).map((m) => m.seq)) }))); }
  async messages(_ch, w, limit) { return this.lines.filter((m) => m.chat_window_id === w).slice(-limit); }
  async postMessage(_ch, w, body) {
    this.posts.push({ window: w, ...body });
    return this.add({ chat_window_id: w, author_id: "u-bot", author_role: "gm", ...body, kind: body.content.startsWith(".") ? "roll" : body.kind });
  }
  async characterSpace(_ch, cid) { return { character: { id: cid, role_card: { characteristics: { INT: 70 }, skills: { "Spot Hidden": 60 } } } }; }
  async playerGroups() { return this.groups ?? []; }
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
  async createCharacter(_ch, body) { const c = { id: `c-new${this.created.length}`, user_id: null, ...body }; this.created.push(c); this.characters_.push(c); return c; }
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

async function table({ llm = new MockLlm(), cfg: over = {}, extraCharacters = [], clock = { t: 1_700_000_000_000 }, bob = false } = {}) {
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
  const cfg = { ...buildConfig({}, {}), debounceMs: 0, postDelayMs: 0, ...over };
  const t = await new Table({ api, llm, cfg, channelId: "ch", roster: new Roster(), sleep: async () => {}, now: () => clock.t }).init();
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
  const tomas = { id: "c-tomas", name: "Tomas Leclerc", kind: "npc", user_id: null, speaking_style: markStyle("eager"), bio: "TOMAS-BIO: a reporter who owes Alice",
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
