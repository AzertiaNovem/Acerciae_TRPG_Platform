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

test("a line belongs to its window's timeline when the window is bound, else to its speaker's", () => {
  const tl = make();
  const side = tl.split({ name: "The docks", members: ["cp1"], windowId: "w-side" });
  assert.equal(tl.ofLine({ chat_window_id: "w-side", character_id: "pc1" }).id, side.id, "bound window wins");
  assert.equal(tl.ofLine({ chat_window_id: "w-main", character_id: "cp1" }).id, side.id, "a side traveller relating events in the Main Chat speaks from its timeline");
  assert.equal(tl.ofLine({ chat_window_id: "w-main", character_id: "pc1" }).id, MAIN);
  assert.equal(tl.ofLine({ chat_window_id: "w-main", character_id: null }).id, MAIN, "Keeper narration in an unbound window");
  tl.merge(side.id);
  assert.equal(tl.ofLine({ chat_window_id: "w-side" }).id, side.id, "old side lines keep their (merged) timeline");
  assert.equal(tl.byName("the docks").id, side.id);
});

test("the shape survives a round trip through JSON", () => {
  const tl = make();
  tl.split({ name: "x", members: ["cp1"] });
  const back = new Timelines(JSON.parse(JSON.stringify(tl)));
  assert.deepEqual(back.toJSON(), tl.toJSON());
});
