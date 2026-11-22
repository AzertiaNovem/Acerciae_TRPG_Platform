import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffBriefing, handoffToBot } from "../src/handoff.mjs";

// `bots handoff`: one of this client's characters goes to a platform bot (docs/BOTS.md), with its memories as the
// bot's briefing, seated where the character sat.
function platform() {
  const calls = [];
  const characters = [
    { id: "c-harriet", name: "Harriet Vance", kind: "pc", user_id: "u-gm", bio: "A sharp antiquarian." },
    { id: "c-alice", name: "Alice Hale", kind: "pc", user_id: "u-alice" },
    { id: "c-grimsby", name: "Mr. Grimsby", kind: "npc", user_id: null },
  ];
  const windows = [
    { id: "w-main", name: "Main Chat", members: [{ user_id: "u-gm" }, { user_id: "u-alice", character_id: "c-alice" }] },
    { id: "w-attic", name: "The attic", members: [{ user_id: "u-gm" }] },
  ];
  let present = [];
  const api = {
    calls,
    async channel() { return { id: "ch", server_id: "s", my_role: "gm" }; },
    async me() { return { id: "u-gm" }; },
    async characters() { return structuredClone(characters); },
    async windows() { return structuredClone(windows); },
    async get(path) {
      if (path === "/api/servers/s/bots") return [{ id: "b-wren", user_id: "u-wren", name: "Wren", enabled: true }, { id: "b-off", user_id: "u-off", name: "Off", enabled: false }];
      if (path === "/api/channels/ch/bots") return { present };
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) { calls.push(["POST", path, body]); present = [{ id: body.bot_id }]; return {}; },
    async put(path, body) { calls.push(["PUT", path, body]); return {}; },
    async transferCharacter(ch, id, body) { calls.push(["owner", id, body]); characters.find((c) => c.id === id).user_id = body.user_id; return {}; },
    async addWindowMember(ch, w, body) { calls.push(["seat", w, body]); return []; },
  };
  return api;
}

test("a character of this account's goes to a bot: invited, owner, seats and its memories as the briefing", async () => {
  const api = platform();
  const state = { coplayers: [{ characterId: "c-harriet", name: "Harriet Vance", persona: "Collects old maps.", seats: [{ windowId: "w-main", fromSeq: 0, toSeq: 10 }, { windowId: "w-attic", fromSeq: 11, toSeq: null }] }] };
  const chapters = [{ fromSeq: 1, toSeq: 5, text: "I met Alice in the study." }, { fromSeq: 6, toSeq: 10, text: "The key was in the clock." }];
  const done = await handoffToBot(api, { channelId: "ch", characterName: "harriet vance", botName: "WREN", state, chapters: () => chapters, intentionOf: () => "Find the missing map." });
  assert.equal(done.bot, "Wren"); assert.equal(done.windows, 1); assert.equal(done.chapters, 2);
  assert.deepEqual(api.calls[0], ["POST", "/api/channels/ch/bots", { bot_id: "b-wren" }]);
  assert.deepEqual(api.calls[1], ["owner", "c-harriet", { user_id: "u-wren", expected_user_id: "u-gm" }]);
  assert.deepEqual(api.calls[2], ["seat", "w-attic", { user_id: "u-wren", character_id: "c-harriet" }]);
  const [, path, { text }] = api.calls[3];
  assert.equal(path, "/api/channels/ch/bots/b-wren/briefing");
  assert.match(text, /You now play Harriet Vance/); assert.match(text, /Collects old maps/); assert.match(text, /Find the missing map/);
  assert.ok(text.indexOf("I met Alice") < text.indexOf("The key was in the clock"), "oldest first");
});

test("an older state file without seats: the windows it lists are where the character sits", async () => {
  const api = platform();
  const state = { coplayers: [{ characterId: "c-harriet", name: "Harriet Vance", persona: "Collects old maps.", windows: ["w-attic"] }] };
  const done = await handoffToBot(api, { channelId: "ch", characterName: "Harriet Vance", botName: "Wren", state });
  assert.equal(done.windows, 1);
  assert.deepEqual(api.calls.filter((c) => c[0] === "seat"), [["seat", "w-attic", { user_id: "u-wren", character_id: "c-harriet" }]]);
  assert.match(api.calls.find((c) => c[0] === "PUT")[2].text, /Collects old maps/);
});

test("only this account's player characters, only enabled bots, one character per bot", async () => {
  const api = platform();
  await assert.rejects(handoffToBot(api, { channelId: "ch", characterName: "Alice Hale", botName: "Wren" }), /not one of this account's characters/);
  await assert.rejects(handoffToBot(api, { channelId: "ch", characterName: "Mr. Grimsby", botName: "Wren" }), /not one of this account's characters/);
  await assert.rejects(handoffToBot(api, { channelId: "ch", characterName: "Harriet Vance", botName: "Off" }), /switched off/);
  await assert.rejects(handoffToBot(api, { channelId: "ch", characterName: "Harriet Vance", botName: "Nobody" }), /no bot "Nobody"/);
  await handoffToBot(api, { channelId: "ch", characterName: "Harriet Vance", botName: "Wren" });
  assert.equal(api.calls.filter((c) => c[0] === "POST").length, 1);
});

test("a long memory keeps its newest chapters, whole, within the briefing's 8000 bytes", () => {
  const chapters = Array.from({ length: 40 }, (_, i) => ({ fromSeq: i * 10, toSeq: i * 10 + 9, text: `Chapter ${i}: ${"x".repeat(400)}` }));
  const text = handoffBriefing({ name: "Harriet", persona: "A sharp antiquarian.", chapters });
  assert.ok(Buffer.byteLength(text) <= 8000);
  assert.match(text, /Chapter 39:/); assert.doesNotMatch(text, /Chapter 0:/);
});
