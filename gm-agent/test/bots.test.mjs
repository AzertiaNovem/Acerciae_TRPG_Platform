import { test } from "node:test";
import assert from "node:assert/strict";
import { Table } from "../src/loop.mjs";
import { Roster } from "../src/roles/roster.mjs";
import { MockLlm } from "../src/llm/mock.mjs";
import { buildConfig } from "../src/config.mjs";
import { FakeApi } from "./fixtures/platform.mjs";
import { botBrief } from "../src/table/bots.mjs";

// The platform's bots (docs/BOTS.md) at a table this client runs: their lines are players' lines the GM answers, never
// people at the table; after the GM answered a person and let the players' side act, the bots seated there are asked
// for their turn (paced), and the GM's answer to their lines asks nothing more of them.
async function table({ improv = null, mayAct = true } = {}) {
  const api = new FakeApi();
  api.characters_ = api.characters_.filter((c) => c.id !== "c-harriet");   // no co-player of this client's own here
  api.characters_.push({ id: "c-wren", name: "Wren Ashby", kind: "pc", user_id: "u-wren", player_name: "Wren", player_is_bot: true, role_card: {} });
  api.windows_[0].members.push({ user_id: "u-wren", character_id: "c-wren", character_name: "Wren Ashby" });
  api.channelUsers.push("u-wren");
  const clock = { t: 1_700_000_000_000 };
  api.add({ created_at: new Date(clock.t - 3600000).toISOString(), chat_window_id: "w-main", author_id: "u-bot", author_role: "gm", kind: "narration", content: "The study is cold." });
  const llm = new MockLlm();
  llm.director = () => ({ actions: [{ type: "narrate", text: `The GM answers (${++llm.turns}).` }], coplayers_may_act: mayAct });
  llm.turns = 0;
  const base = buildConfig({}, {});
  const cfg = { ...base, sceneForks: false, debounceMs: 0, postDelayMs: 0, planner: { ...base.planner, enabled: false } };
  const t = await new Table({ api, llm, cfg, channelId: "ch", roster: new Roster(), improv, sleep: async () => {}, now: () => clock.t, log: process.env.TEST_LOG ? console.log : () => {} }).init();
  return { t, api, llm, clock };
}
const settle = async (t) => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 2)); await t.queue; } };
const post = (t, api, m) => t.onEvent({ stream: "chat", type: "message.posted", channel_id: "ch", message: api.add({ chat_window_id: "w-main", author_role: "player", ...m }) });
const gmLines = (api) => api.posts.filter((p) => /The GM answers/.test(p.content ?? ""));
// The calls that ask bots for a turn (pacing alone names no character).
const asked = (api) => (api.botCalls ?? []).filter((c) => c.character_ids.length);

test("a person's line: the GM answers, then the bots seated there are asked for their turn, paced", async () => {
  const { t, api, clock } = await table();
  // From the start the bots are this client's to pace; again every few minutes while lines come.
  assert.deepEqual(api.botCalls, [{ window: "w-main", pace: true, character_ids: [] }]);
  await post(t, api, { author_id: "u-alice", character_id: "c-alice", content: "I open the door." });
  await settle(t);
  assert.equal(gmLines(api).length, 1);
  assert.deepEqual(asked(api), [{ window: "w-main", pace: true, character_ids: ["c-wren"] }]);
  // The bot plays its character: a player's line the GM answers, but it asks the bots nothing more.
  const humanAt = t.lastHumanAt;
  await post(t, api, { author_id: "u-wren", author_is_bot: true, character_id: "c-wren", content: "Wren peers into the dark." });
  await settle(t);
  assert.equal(gmLines(api).length, 2, "the GM answers the bot's character");
  assert.equal(asked(api).length, 1, "no new call for the bots' own lines");
  assert.equal(t.lastHumanAt, humanAt, "a bot is no person at the table");
  assert.ok(!t.isHuman({ author_id: "u-wren", author_is_bot: true }));
  // The next person's line calls them again.
  const paced = api.botCalls.length;
  clock.t += 6 * 60000;
  await post(t, api, { author_id: "u-alice", character_id: "c-alice", content: "I follow Wren." });
  await settle(t);
  assert.equal(asked(api).length, 2);
  assert.ok(api.botCalls.slice(paced).some((c) => !c.character_ids.length), "paced again after five minutes");
});

test("a GM turn that keeps the players' side waiting calls no bot; a bot's out-of-character line is no command", async () => {
  const { t, api } = await table({ mayAct: false });
  await post(t, api, { author_id: "u-alice", character_id: "c-alice", content: "Can I ask the butler something?" });
  await settle(t);
  assert.equal(gmLines(api).length, 1);
  assert.equal(asked(api).length, 0);
  assert.equal(t.playerSpeech({ channel_id: "ch", author_id: "u-wren", author_is_bot: true, author_role: "player", kind: "ooc", content: "/pause" }), false);
});

test("the notes for bots carry the public world, and are sent when they change", async () => {
  const { t, api } = await table({ improv: { on: true, world: "A fishing town where the fog never lifts." } });
  assert.match(botBrief(t), /THE WORLD[\s\S]*fog never lifts/);
  await post(t, api, { author_id: "u-alice", character_id: "c-alice", content: "We walk to the harbour." });
  await settle(t);
  assert.equal(api.botBriefs?.length, 1);
  assert.match(api.botBriefs[0], /fog never lifts/);
  // Unchanged: not sent again.
  assert.equal(await t.syncBotBrief({ force: true }), false);
});

test("without a world to tell, the GM's own notes for bots are left as they are", async () => {
  const { t, api } = await table();
  await post(t, api, { author_id: "u-alice", character_id: "c-alice", content: "Hello." });
  await settle(t);
  assert.equal(api.botBriefs, undefined);
});
