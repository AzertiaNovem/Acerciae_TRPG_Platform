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
  async channel() { return { id: "ch", server_id: "s", name: "Hale house", my_role: "gm", era: "1920s", current_scene_id: "sc1" }; }
  async serverSettings() { return { language: "en", features: {} }; }
  async coc7Rules() { return { skills: [{ name: "Spot Hidden", base: 25, names: {} }], families: [] }; }
  async characters() { return structuredClone(this.characters_); }
  async windows() { return structuredClone(this.windows_); }
  async messages(_ch, w, limit) { return this.lines.filter((m) => m.chat_window_id === w).slice(-limit); }
  async postMessage(_ch, w, body) {
    this.posts.push({ window: w, ...body });
    return this.add({ chat_window_id: w, author_id: "u-bot", author_role: "gm", ...body, kind: body.content.startsWith(".") ? "roll" : body.kind });
  }
  async characterSpace(_ch, cid) { return { character: { id: cid, role_card: { characteristics: { INT: 70 }, skills: { "Spot Hidden": 60 } } } }; }
  async createWindow(_ch, body) { const w = { id: `w-new${this.windows_.length}`, kind: body.kind, name: body.name, members: [{ user_id: "u-bot" }, ...(body.members ?? [])] }; this.windows_.push(w); return structuredClone(w); }
  async createCharacter(_ch, body) { const c = { id: `c-new${this.created.length}`, user_id: null, ...body }; this.created.push(c); this.characters_.push(c); return c; }
  async putCard() { return {}; }
  async putAppearance() { return {}; }
  async scenes() { return [{ id: "sc1", title: "The study", status: "active" }]; }
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

async function table({ llm = new MockLlm(), cfg: over = {}, extraCharacters = [], clock = { t: 1_700_000_000_000 } } = {}) {
  const api = new FakeApi();
  api.characters_.push(...extraCharacters);
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

test("split moves co-players into a window of their own on a new timeline; rejoin brings them back", async () => {
  const llm = new MockLlm();
  llm.director = quietDirector(splitPlan);
  const { t, api } = await table({ llm });
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
  const { t, api, clock } = await table({ llm, cfg: { autonomySideIntervalMs: 90000, autonomyQuietMs: 10 * MIN } });
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
