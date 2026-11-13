import test from "node:test";
import assert from "node:assert/strict";
import { readPresence } from "../src/presence.mjs";

// Minimal replay of the reported campus case. Old thread labels do not describe the latest public play.
const threads = [
  { key: "T0", location: "教室", time: "周三21:30", members: [{ id: "su", name: "苏婉" }], lines: [
    { seq: 10, actor: "su", text: "你住在哪里来着，我跟谢遥一起在507哦" },
    { seq: 11, keeper: true, text: "你回到507，今晚的奔忙到这里结束，接下来可以安心休息。" },
  ] },
  { key: "T1", location: "七号楼一楼门厅", time: "周三21:30", members: [{ id: "xie", name: "谢遥" }, { id: "jiang", name: "江念" }], lines: [
    { seq: 12, actor: "xie", text: "（朝江念点点头，往五楼走）记着呢，明天吃完饭再去领钥匙。晚安，我也回507洗漱了。" },
    { seq: 13, keeper: true, text: "谢遥上到五楼，回到507；苏婉也正准备回寝休息。" },
    { seq: 14, actor: "jiang", text: "我先回寝洗漱，你们也早点睡。" },
  ] },
];
const placement = { id: "xie", thread: "T0", with: "su", actor_seq: 13, target_seq: 11, place: "507" };
const decide = placements => ({ complete: async () => JSON.stringify({ placements }) });

test("published arrivals support co-presence without another movement declaration; the request retains both accounts", async () => {
  const llm = { complete: async request => {
    const input = JSON.parse(request.messages[0].content);
    assert.deepEqual(input, { current: "T0", threads });
    assert.match(request.system, /not permission|not deciding whether a character is allowed to travel/);
    assert.match(request.system, /while one is still in the washroom/i);
    assert.match(request.system, /incompatible story times/);
    return JSON.stringify({ placements: [placement] });
  } };
  assert.deepEqual(await readPresence(llm, { current: "T0", threads }), [
    { id: "xie", thread: "T0", with: "su", actorSeq: 13, targetSeq: 11, place: "507" },
  ]);
});

test("both confirming records must exist and belong to their respective scenes; another actor cannot supply the evidence", async () => {
  for (const invalid of [
    { actor_seq: 999 }, { actor_seq: 14 }, { target_seq: 13 }, { target_seq: 999 },
    { with: "nobody" }, { thread: "new" }, { thread: "T1" }, { id: "nobody" }, { place: "508" },
  ]) assert.deepEqual(await readPresence(decide([{ ...placement, ...invalid }]), { current: "T0", threads }), [], JSON.stringify(invalid));
});

test("no automatic reunion from room labels alone, conflicting targets or circular exchanges", async () => {
  assert.deepEqual(await readPresence(decide([]), { current: "T0", threads }), []);
  assert.deepEqual(await readPresence(decide([placement, placement]), { current: "T0", threads }), []);
  const back = { id: "su", thread: "T1", with: "xie", actor_seq: 11, target_seq: 13, place: "507" };
  assert.deepEqual(await readPresence(decide([placement, back]), { current: "T0", threads }), []);
});

const shared = [{ key: "T0", location: "晚风书店", time: "14:15", members: [
  { id: "su", name: "苏婉", coplayer: false, since: 0 },
  { id: "zhou", name: "周见微", coplayer: true, since: 5 },
], lines: [
  { seq: 10, actor: "zhou", kind: "ic", text: "（回后街家里吃过午饭，留下陪奶奶。）奶奶，我陪你听会儿广播。" },
  { seq: 11, keeper: true, kind: "narration", text: "周见微留在后街奶奶家，陪她听广播，没有去书店。苏婉仍在晚风书店。" },
  { seq: 12, actor: "su", kind: "ic", text: "我看看书。" },
] }];
const departure = { id: "zhou", actor_seq: 10, confirmation_seq: 11, place: "后街奶奶家", span: "long" };
const separate = departures => ({ complete: async () => JSON.stringify({ placements: [], departures }) });

test("a co-player's confirmed departure creates a separate scene even when everyone is still recorded in one window", async () => {
  const result = await readPresence(separate([departure]), { current: "T0", threads: shared });
  assert.deepEqual(result, [{ id: "zhou", thread: "NEW", actorSeq: 10, confirmationSeq: 11, place: "后街奶奶家", span: "long" }]);
});

test("separation requires the co-player's own recent action and a later public GM confirmation", async () => {
  for (const change of [
    { id: "su", actor_seq: 12 }, { id: "nobody" }, { actor_seq: 12 }, { actor_seq: 999 },
    { confirmation_seq: 10 }, { confirmation_seq: 12 }, { confirmation_seq: 999 }, { place: "别人的家" }, { place: "晚风书店" },
  ]) assert.deepEqual(await readPresence(separate([{ ...departure, ...change }]), { current: "T0", threads: shared }), [], JSON.stringify(change));
  for (const mutate of [
    t => { t[0].lines[0].standIn = true; },
    t => { t[0].lines[0].kind = "ooc"; },
    t => { t[0].members[1].since = 10; },
    t => { t[0].lines[1].keeper = false; },
  ]) {
    const copy = structuredClone(shared); mutate(copy);
    assert.deepEqual(await readPresence(separate([departure]), { current: "T0", threads: copy }), []);
  }
});

test("conflicting separations are discarded, and a lone occupant cannot split from themself", async () => {
  assert.deepEqual(await readPresence(separate([departure, departure]), { current: "T0", threads: shared }), []);
  const copy = structuredClone(shared); copy[0].members.shift();
  let called = false;
  assert.deepEqual(await readPresence({ complete: async () => { called = true; throw Error("not needed"); } }, { current: "T0", threads: copy }), []);
  assert.equal(called, false);
});
