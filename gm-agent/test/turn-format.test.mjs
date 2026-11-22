import assert from "node:assert/strict";
import { test } from "node:test";
import { directTurn } from "../src/director.mjs";
import { coplayerTurn } from "../src/coplayer.mjs";
import { DEFAULT_WRITING } from "../src/writing.mjs";

const gm = { language: "简体中文", context: [{ text: "UNRELATED-GM-SECRET and the whole table history", cache: true }], casual: true };
const player = { language: "简体中文", coplayer: { name: "谢遥" }, log: [] };

test("presentation can split a paragraph and merge adjacent prose without rewriting it", async () => {
  const calls = [];
  const formatting = '每条一到两句，保留原文。';
  const plan = await directTurn({ async complete(r) {
    calls.push(r);
    if (r.purpose === 'director') return '灯还亮着。她停在门口。\n\n雨没有停。';
    const source = JSON.parse(r.messages[0].content);
    assert.deepEqual(source[0].parts, ['灯还亮着。', '她停在门口。']);
    return JSON.stringify({ actions: [
      { type: 'narrate', text: { id: 1, from: 1, to: 1 } },
      { type: 'narrate', text: [{ id: 1, from: 2, to: 2 }, 2] },
    ] });
  } }, { ...gm, formatting });
  assert.deepEqual(plan.actions.map(a => a.text), ['灯还亮着。', '她停在门口。\n\n雨没有停。']);
  assert.ok(!calls[0].system.includes(formatting));
  assert.ok(calls[1].system.includes(formatting));
  assert.ok(!calls[1].system.includes(DEFAULT_WRITING.formatting));
});

test("sentence ranges cannot omit, repeat, reorder or mix speakers and recipients", async () => {
  const range = (from, to = from) => ({ id: 1, from, to });
  const cases = [
    ['灯亮着。雨停了。', [{ type: 'narrate', text: range(1) }]],
    ['灯亮着。雨停了。', [{ type: 'narrate', text: range(1) }, { type: 'narrate', text: range(1, 2) }]],
    ['灯亮着。雨停了。', [{ type: 'narrate', text: range(2) }, { type: 'narrate', text: range(1) }]],
    ['NPC 江念: 灯亮着。\n\nNPC 谢遥: 雨停了。', [{ type: 'npc', text: [1, 2] }]],
    ['Whisper to 江念: 灯亮着。\n\nWhisper to 谢遥: 雨停了。', [{ type: 'whisper', text: [1, 2] }]],
    ['Whisper to 江念: 灯亮着。雨停了。', [{ type: 'narrate', text: range(1, 2) }]],
  ];
  for (const [draft, actions] of cases) await assert.rejects(directTurn({ async complete(r) {
    return r.purpose === 'director' ? draft : JSON.stringify({ actions });
  } }, gm), /left unplaced|paragraph reference/);
});

test("co-player prose can be one long message or several short messages", async () => {
  for (const multiple of [false, true]) {
    const move = await coplayerTurn({ async complete(r) {
      if (r.purpose === 'coplayer_turn') return '我推开门。\n\n“怎么还不走？”';
      return JSON.stringify({ action: 'speak', kind: 'ic', ...(multiple ? { messages: [1, 2] } : { text: [1, 2] }) });
    } }, player);
    assert.equal(move.text, '我推开门。\n\n“怎么还不走？”');
    assert.deepEqual(move.messages, multiple ? ['我推开门。', '“怎么还不走？”'] : undefined);
  }
});

test("a GM draft becomes ordered messages without sharing context or rewriting prose", async () => {
  const replies = [
    `雨把窗格缝成了两行细线。
NPC 江念：她把最后一枚硬币推过去。 “别算在我账上。”

Whisper to 谢遥: 只有你注意到她把手藏到了桌下。

Phone from 江念 to 周见微: 书我先拿走了。

GM only: 把钥匙留在后门。

Opening: 走廊尽头，纸箱还留着一圈湿印。

Table directions: 周见微自己去了走廊，单开短线。短信两分钟后送达。让谢遥先行动。`,
    JSON.stringify({ actions: [
      { type: "narrate", text: 1 }, { type: "npc", name: "WRONG NAME", text: 2 },
      { type: "whisper", to: "WRONG RECIPIENT", text: 3 },
      { type: "text", from: "WRONG SENDER", to: "WRONG RECIPIENT", text: 4, delay_minutes: 2 },
      { type: "note", text: 5 },
    ], spotlight: ["谢遥"], whereabouts: [{ who: ["周见微"], thread: "new", place: "走廊", own_scene: true, opening: 6 }] }),
  ];
  const requests = [];
  const plan = await directTurn({ async complete(r) { requests.push(r); return replies.shift(); } }, gm);
  assert.deepEqual(requests.map(r => r.purpose), ["director", "chat_format"]);
  assert.match(requests[0].system, /Write the turn as plain text/);
  assert.ok(requests[0].messages[0].content[0].cache);
  assert.doesNotMatch(requests[1].messages[0].content, /UNRELATED-GM-SECRET|whole table history/);
  assert.deepEqual(plan.actions, [
    { type: "narrate", text: "雨把窗格缝成了两行细线。" },
    { type: "npc", name: "江念", text: "她把最后一枚硬币推过去。 “别算在我账上。”" },
    { type: "whisper", to: "谢遥", text: "只有你注意到她把手藏到了桌下。" },
    { type: "text", from: "江念", to: "周见微", text: "书我先拿走了。", delay_minutes: 2 },
    { type: "note", text: "把钥匙留在后门。" },
  ]);
  assert.equal(plan.whereabouts[0].opening, "走廊尽头，纸箱还留着一圈湿印。");
  assert.deepEqual(plan.spotlight, ["谢遥"]);
});

test("a formatter that tries to publish a private paragraph gets repaired without redrafting", async () => {
  const calls = [];
  const plan = await directTurn({ async complete(r) {
    calls.push(r);
    if (r.purpose === "director") return "Whisper to 谢遥: 手心的车票还没沾湿。";
    return JSON.stringify({ actions: [{ type: r.attempt === 1 ? "narrate" : "whisper", text: 1 }] });
  } }, gm);
  assert.deepEqual(calls.map(r => r.purpose), ["director", "chat_format", "chat_format"]);
  assert.equal(plan.actions[0].to, "谢遥");
});

test("co-player prose stays intact and only an explicitly drafted command can roll", async () => {
  const calls = [];
  const first = "我把钥匙拍在桌面上。";
  const second = "“你要我回去，我偏要开这扇门。”";
  const llm = { async complete(r) {
    calls.push(r);
    if (r.purpose === "coplayer_turn") return `${first}\n\n${second}\n\nTable directions: Roll .ra Locksmith.`;
    return JSON.stringify({ action: "roll", command: ".ra Locksmith", text: [1, 2] });
  } };
  const result = await coplayerTurn(llm, player);
  assert.deepEqual(result, { action: "roll", command: ".ra Locksmith", text: `${first}\n\n${second}` });
  assert.deepEqual(calls.map(r => r.purpose), ["coplayer_turn", "chat_format"]);
  await assert.rejects(coplayerTurn({ async complete(r) {
    return r.purpose === "coplayer_turn" ? first : '{"action":"roll","command":".ra Locksmith","text":1}';
  } }, player), /operation must be stated/);
});

test("an autonomous turn that spends its budget drafting does not call the formatter", async () => {
  const calls = [];
  const plan = await directTurn({ async complete(r) { calls.push(r.purpose); return "茶凉了。"; } },
    { ...gm, mode: "quiet", canFormat: () => calls.length === 0 });
  assert.deepEqual(calls, ["director"]);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.coplayersMayAct, false);
});

test("pausing during formatting cancels the same turn even if the provider returns late", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const llm = { signalOf: () => signal, async complete(r) {
    assert.equal(r.signal, signal);
    if (r.purpose === "director") return "茶凉了。";
    controller.abort();
    return '{"actions":[{"type":"narrate","text":1}]}';
  } };
  await assert.rejects(directTurn(llm, gm), { name: "AbortError" });
});
