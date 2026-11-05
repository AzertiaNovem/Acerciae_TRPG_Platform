import test from "node:test";
import assert from "node:assert/strict";
import { readDestinations, sceneHandoff } from "../src/continuity.mjs";

test("newest deciding line wins, including a cancellation; borrowed evidence cannot supersede it", async () => {
  const actor = { id: "Jiang", sources: [1, 5, 8] };
  const input = { actors: [actor], lines: [], destinations: [{ key: "office" }, { key: "darkroom" }] };
  const decide = (seq, destination) => ({ id: "Jiang", seq, destination });
  const results = [decide(5, "office"), decide(1, "darkroom"), decide(9, "darkroom")];
  const llm = { complete: async () => JSON.stringify({ moves: results }) };
  assert.deepEqual(await readDestinations(llm, input), [decide(5, "office")]);
  results.push(decide(8, null));
  assert.deepEqual(await readDestinations(llm, input), []);
});

test("a sentence can establish lunch and propose dinner without counting an unconfirmed meal twice", async () => {
  const text = "苏婉中午吃了牛肉面；晚饭我想去二食堂。";
  const messages = [{ id: "msg", seq: 12, visibility: "window", kind: "ic", character_name: "苏婉", content: text }];
  const logs = [];
  const llm = { complete: async () => JSON.stringify({ summary: "苏婉中午吃过牛肉面了，晚饭还打算去二食堂。", source_seqs: [12] }) };
  const body = await sceneHandoff(llm, { messages, time: "17:30", language: "Simplified Chinese", log: text => logs.push(text) });
  assert.equal(body.content, "时间转场 · 17:30\n苏婉中午吃过牛肉面了，晚饭还打算去二食堂。");
  assert.ok(!("reference_ids" in body), "the public post does not create quote cards");
  assert.match(logs[0], /#12/, "sources remain in internal diagnostics");
});

test("the short recap prompt retains conditions and distinguishes plans from completed events", async () => {
  const messages = [{ id: "m", seq: 4, visibility: "window", kind: "ic", character_name: "谢遥", content: "我吃过饭就去暗房冲胶卷。" }];
  const llm = { complete: async request => {
    assert.match(request.system, /one or two short/);
    assert.match(request.system, /no dialogue quotations/);
    assert.match(request.system, /Intentions, invitations and schedules must remain plans/);
    assert.match(request.system, /吃过饭就去暗房 is a plan/);
    return JSON.stringify({ summary: "谢遥打算吃完饭再去暗房冲胶卷。", source_seqs: [4] });
  } };
  const body = await sceneHandoff(llm, { messages, time: "17:30", language: "Simplified Chinese" });
  assert.equal(body.content, "时间转场 · 17:30\n谢遥打算吃完饭再去暗房冲胶卷。");
});

test("previous handoffs prevent repeated reminders but cannot be cited as new evidence", async () => {
  const messages = [
    { seq: 1, visibility: "window", kind: "narration", content: "大家回到了寝室。" },
    { seq: 2, visibility: "window", kind: "narration", content: "时间转场 · 21:30\n大家已回寝，明天再去暗房。" },
    { seq: 3, visibility: "gm_only", kind: "narration", content: "SECRET" },
  ];
  const llm = { complete: async request => {
    const input = JSON.parse(request.messages[0].content);
    assert.equal(input.previous_handoff, messages[1].content);
    assert.deepEqual(input.lines.map(l => l.seq), [1]);
    assert.ok(!JSON.stringify(input).includes("SECRET"));
    return JSON.stringify({ summary: "", source_seqs: [] });
  } };
  assert.equal((await sceneHandoff(llm, { messages, time: "22:30", language: "Simplified Chinese" })).content, "时间转场 · 22:30");
});

test("an overlong recap is rewritten, never cut mid-condition; failed or unsupported recaps show only the time", async () => {
  const input = { messages: [{ seq: 1, visibility: "window", kind: "ic", content: "我明天再去暗房。" }], time: "22:30", language: "Simplified Chinese" };
  let calls = 0;
  const llm = { complete: async () => JSON.stringify({ summary: ++calls === 1 ? "长".repeat(141) : "明天再去暗房。", source_seqs: [1] }) };
  assert.match((await sceneHandoff(llm, input)).content, /明天再去暗房。$/);
  assert.equal(calls, 2);
  for (const reply of [
    { summary: "长".repeat(141), source_seqs: [1] },
    { summary: "已经去了暗房。", source_seqs: [999] },
    { summary: "已经去了暗房。", source_seqs: [] },
  ]) {
    const body = await sceneHandoff({ complete: async () => JSON.stringify(reply) }, input);
    assert.deepEqual(body, { content: "时间转场 · 22:30", kind: "narration" });
  }
  assert.equal((await sceneHandoff({ complete: async () => { throw Error("provider timed out"); } }, input)).content, "时间转场 · 22:30");
});
