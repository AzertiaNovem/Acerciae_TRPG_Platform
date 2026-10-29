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
      { id: "c-alice", name: "Alice Hale", kind: "pc", user_id: "u-alice", player_name: "alice" },
      { id: "c-harriet", name: "Harriet Vance", kind: "npc", user_id: null, speaking_style: markStyle("dry wit"), bio: "A sharp antiquarian." },
      { id: "c-butler", name: "Mr. Grimsby", kind: "npc", user_id: null, speaking_style: "", bio: "The butler; knows where the key is." },
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
  async createCharacter(_ch, body) { const c = { id: `c-new${this.created.length}`, user_id: null, ...body }; this.created.push(c); this.characters_.push(c); return c; }
  async putCard() { return {}; }
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

async function table({ llm = new MockLlm(), cfg: over = {} } = {}) {
  const api = new FakeApi();
  api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "KEEPER NOTE SECRET-ONE: the clock hides the key", visibility: "gm_only" });
  api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "SECRET-TWO: you alone hear a whisper", visibility: "whisper", whisper_to: ["c-alice"] });
  api.add({ chat_window_id: "w-priv", author_id: "u-alice", author_role: "player", character_id: "c-alice", content: "SECRET-THREE in Alice's own window" });
  api.add({ chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "The study is cold and smells of pipe smoke." });
  const cfg = { ...buildConfig({}, {}), debounceMs: 0, postDelayMs: 0, ...over };
  const t = await new Table({ api, llm, cfg, channelId: "ch", roster: new Roster(), sleep: async () => {} }).init();
  return { t, api, llm };
}
const playerSays = (t, api, content, w = "w-main") => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: w, author_id: "u-alice", author_role: "player", character_id: "c-alice", content }) });

test("co-players and real NPCs are told apart from the platform's characters", async () => {
  const { t } = await table();
  assert.deepEqual(t.roster.coplayers.map((c) => [c.name, c.windows]), [["Harriet Vance", ["w-main"]]]);
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
  assert.deepEqual(api.posts.map((p) => [p.kind, p.character_id ?? null]), [["narration", null], ["ic", "c-harriet"]]);
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
