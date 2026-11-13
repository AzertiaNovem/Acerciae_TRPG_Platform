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

test("discovery separates immediate individual destinations even without a GM proposal or arrival narration", async () => {
  const input = { discover: true, destinations: [], actors: [
    { id: "zhou", sources: [2] }, { id: "xie", sources: [3] }, { id: "cheng", sources: [4] }, { id: "su", sources: [5] },
  ], lines: [
    { seq: 1, kind: "narration", text: "周见微在三班，程叙白在四班。" },
    { seq: 2, kind: "ic", text: "我回三班了。谢遥，你要和我一起吗？" },
    { seq: 3, kind: "ic", text: "好，我跟你回班。" },
    { seq: 4, kind: "ic", text: "我回自己班里去。" },
    { seq: 5, kind: "ic", text: "那我留在食堂，明天再去书店。" },
  ] };
  const moves = [
    { id: "zhou", seq: 2, destination: "NEW", own_scene: true, place: "三班", place_seq: 2, span: "long" },
    { id: "xie", seq: 3, destination: "NEW", own_scene: true, place: "三班", place_seq: 2, span: "long" },
    { id: "cheng", seq: 4, destination: "NEW", own_scene: true, place: "四班", place_seq: 1, span: "long" },
    { id: "su", seq: 5, destination: null },
  ];
  const llm = { complete: async request => {
    assert.equal(JSON.parse(request.messages[0].content).discover, true);
    return JSON.stringify({ moves });
  } };
  assert.deepEqual(await readDestinations(llm, input), moves.slice(0, 3));
});

test("discovery rejects borrowed decisions, invented places, uncertain destinations and later cancellations", async () => {
  const input = { discover: true, destinations: [], actors: [{ id: "zhou", sources: [2, 3] }], lines: [
    { seq: 1, kind: "ic", text: "我现在去书店。" },
    { seq: 2, kind: "ic", text: "我回三班。" },
    { seq: 3, kind: "ic", text: "算了，我先留在这里。" },
    { seq: 4, kind: "ooc", text: "以后安排去暗房。" },
  ] };
  const go = { id: "zhou", seq: 2, destination: "NEW", own_scene: true, place: "三班", place_seq: 2 };
  for (const moves of [
    [{ ...go, seq: 1, place: "书店", place_seq: 1 }],
    [{ ...go, place: "四班" }],
    [{ ...go, place: "暗房", place_seq: 4 }],
    [{ ...go, own_scene: false }],
    [go, { ...go, place: "书店", place_seq: 1 }],
    [go, { id: "zhou", seq: 3, destination: null }],
  ]) {
    assert.deepEqual(await readDestinations({ complete: async () => JSON.stringify({ moves }) }, input), []);
  }
});

test("relative destinations distinguish separate homes while keeping an accepted companion with the right host", async () => {
  const input = { discover: true, destinations: [], actors: [
    { id: "zhou", name: "周见微", sources: [1] }, { id: "xie", name: "谢遥", sources: [2] }, { id: "cheng", name: "程叙白", sources: [3] },
  ], lines: [
    { seq: 1, kind: "ic", text: "我回家了，谢遥要来玩吗？" },
    { seq: 2, kind: "ic", text: "好，我跟你回家。" },
    { seq: 3, kind: "ic", text: "我也回家，明天学校见。" },
  ] };
  const moves = input.actors.map((a, i) => ({ id: a.id, seq: i + 1, destination: "NEW", own_scene: true, place: "家", place_seq: i + 1, place_owner: a.id === "xie" ? "zhou" : a.id }));
  const llm = { complete: async () => JSON.stringify({ moves }) };
  assert.deepEqual((await readDestinations(llm, input)).map(d => d.place), ["周见微 · 家", "周见微 · 家", "程叙白 · 家"]);
  moves.push({ ...moves[0], place_owner: "cheng" });
  assert.ok(!(await readDestinations(llm, input)).some(d => d.id === "zhou"), "conflicting owners cannot select an arbitrary group");
  moves[1].place_owner = "unknown";
  assert.ok(!(await readDestinations(llm, input)).some(d => d.id === "xie"), "an invented host cannot define the destination");
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
