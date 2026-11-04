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
  const llm = { complete: async () => JSON.stringify({
    completed: [{ seq: 12, quote: "苏婉中午吃了牛肉面" }],
    planned: [{ seq: 12, quote: "晚饭我想去二食堂" }],
  }) };
  const body = await sceneHandoff(llm, { messages, time: "17:30", language: "Simplified Chinese" });
  assert.match(body.content, /已经发生[^\n]+中午吃了牛肉面\S*\n仍是打算[^\n]+晚饭我想去二食堂/);
  assert.deepEqual(body.reference_ids, ["msg"]);
});

test("a quoted intention retains its condition when the model selects only part of the sentence", async () => {
  const messages = [{ id: "m", seq: 4, visibility: "window", kind: "ic", character_name: "谢遥", content: "我吃过饭就去暗房冲胶卷。" }];
  const llm = { complete: async () => '{"completed":[],"planned":[{"seq":4,"quote":"吃过饭"}]}' };
  const body = await sceneHandoff(llm, { messages, time: "17:30", language: "Simplified Chinese" });
  assert.match(body.content, /仍是打算 · 谢遥「我吃过饭就去暗房冲胶卷。」/);
});
