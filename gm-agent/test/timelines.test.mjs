import { test } from "node:test";
import assert from "node:assert/strict";
import { Timelines, MAIN } from "../src/timelines.mjs";

const make = () => new Timelines([], { now: () => 1000 }).reconcile(["pc1", "cp1", "cp2"]);

test("the main timeline always exists and holds every investigator exactly once", () => {
  const tl = make();
  assert.deepEqual(tl.main().members, ["pc1", "cp1", "cp2"]);
  tl.reconcile(["pc1", "cp2", "pc9"]);
  assert.deepEqual(tl.main().members, ["pc1", "cp2", "pc9"], "gone characters dropped, new ones added");
  assert.equal(new Timelines([{ id: "x", name: "orphan", status: "active", members: [] }]).main().id, MAIN);
});

test("split, update and merge", () => {
  const tl = make();
  const side = tl.split({ name: "The docks", members: ["cp1", "cp2"], windowId: "w-side", returnTo: ["w-main"], location: "Harbour" });
  assert.deepEqual(tl.main().members, ["pc1"]);
  assert.equal(tl.of("cp1").id, side.id); assert.equal(tl.of("pc1").id, MAIN);
  tl.update(side.id, { narrativeTime: "night", notes: "secret", remove: ["cp2"] });
  assert.deepEqual(side.members, ["cp1"]); assert.deepEqual(tl.main().members, ["pc1", "cp2"]);
  tl.update(MAIN, { add: ["cp1"] });
  assert.deepEqual(side.members, []);
  assert.equal(tl.merge(side.id), tl.main()); assert.equal(side.status, "merged"); assert.equal(side.mergedInto, MAIN);
  assert.equal(tl.merge(MAIN), null, "the main timeline cannot be merged away");
  assert.equal(tl.active().length, 1);
});

test("a line belongs to its speaker's timeline at that moment; Keeper and NPC lines to their window's", () => {
  const tl = make();
  const side = tl.split({ name: "The docks", members: ["cp1"], windowId: "w-side", fromSeq: 10 });
  assert.equal(tl.ofLine({ chat_window_id: "w-main", character_id: "cp1", seq: 5 }).id, MAIN, "before the split, cp1 spoke from the main story");
  assert.equal(tl.ofLine({ chat_window_id: "w-main", character_id: "cp1", seq: 12 }).id, side.id, "a side traveller relating events in the Main Chat speaks from its timeline");
  assert.equal(tl.ofLine({ chat_window_id: "w-side", character_id: "pc1", seq: 12 }).id, MAIN, "a visitor writing in the side window still speaks from where it is");
  assert.equal(tl.ofLine({ chat_window_id: "w-side", character_id: null, seq: 12 }).id, side.id, "Keeper narration takes the window's timeline");
  assert.equal(tl.ofLine({ chat_window_id: "w-main", character_id: null, seq: 12 }).id, MAIN);
  tl.merge(side.id, MAIN, 20);
  assert.equal(tl.ofLine({ chat_window_id: "w-side", character_id: "cp1", seq: 15 }).id, side.id, "old side lines keep their (merged) timeline");
  assert.equal(tl.ofLine({ chat_window_id: "w-main", character_id: "cp1", seq: 25 }).id, MAIN);
  assert.equal(tl.byName("the docks").id, side.id);
  assert.equal(tl.byHandle("T1").id, side.id, "handles are persistent");
  assert.ok(tl.retired("w-side"));
});

test("handles are never reused, places match loosely, and the old array shape still loads", () => {
  const tl = make();
  const a = tl.split({ name: "A", members: ["cp1"], windowId: "w-a", location: "The Old Harbour" });
  tl.merge(a.id);
  const b = tl.split({ name: "B", members: ["cp2"], windowId: "w-b", location: "Lighthouse" });
  assert.equal(a.handle, 1); assert.equal(b.handle, 2);
  assert.equal(tl.atPlace("old harbour!"), null, "a merged thread holds no place");
  assert.equal(tl.atPlace("the lighthouse").id, b.id);
  const legacy = new Timelines([{ id: "main", name: "Main story", status: "active", members: ["pc1"] }, { id: "t-x", name: "Old", status: "active", members: ["cp1"] }]);
  assert.equal(legacy.main().handle, 0); assert.equal(legacy.get("t-x").handle, 1); assert.equal(legacy.get("t-x").span, "short");
  const back = new Timelines(JSON.parse(JSON.stringify(tl)));
  assert.equal(back.split({ name: "C", members: [] }).handle, 3, "the counter survives a round trip");
});

test("the shape survives a round trip through JSON", () => {
  const tl = make();
  tl.split({ name: "x", members: ["cp1"] });
  const back = new Timelines(JSON.parse(JSON.stringify(tl)));
  assert.deepEqual(back.toJSON(), tl.toJSON());
});
