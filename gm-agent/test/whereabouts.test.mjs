import { test } from "node:test";
import assert from "node:assert/strict";
import { Timelines, MAIN } from "../src/timelines.mjs";
import { Guard, planWhereabouts, validateWhereabouts, whereaboutsBrief } from "../src/whereabouts.mjs";

const CFG = { timelineGuardTurns: 2, timelineGuardMs: 180000, timelineMaxActive: 4, timelinePcCooldownMs: 300000 };
const PEOPLE = { alice: { pc: true, user: "u-alice" }, bob: { pc: true, user: "u-bob" }, harriet: { pc: false }, tomas: { pc: false } };

function world({ main = ["alice", "bob", "harriet", "tomas"], threads = [] } = {}) {
  const tl = new Timelines([], { now: () => 1000 }).reconcile(main);
  const windows = {};
  for (const th of threads) {
    const t = tl.split({ name: th.place, members: th.members, windowId: th.window, location: th.place, span: th.span ?? "short" });
    windows[th.window] = th.users ?? th.members.filter((m) => PEOPLE[m].pc).map((m) => PEOPLE[m].user);
  }
  return { tl, windows };
}

function plan(w, reports, { scene = MAIN, mode = "human", speakers = [], guard = new Guard(), turn = 1, now = 10_000_000, scope } = {}) {
  const sceneTl = w.tl.get(scene) ?? w.tl.byName(scene);
  return planWhereabouts({
    timelines: w.tl, scene: { timeline: sceneTl }, reports: validateWhereabouts(reports), scopeIds: new Set(scope ?? sceneTl.members), speakers: new Set(speakers), mode,
    resolve: (n) => (PEOPLE[n.toLowerCase()] ? n.toLowerCase() : null), isPc: (id) => PEOPLE[id]?.pc, userOf: (id) => PEOPLE[id]?.user, windowUsers: (win) => w.windows[win] ?? [],
    guard, turn, now, cfg: CFG,
  });
}
const kinds = (r) => r.ops.map((o) => o.op);

test("a player who says so leaves for a place of their own; nobody else moves", () => {
  const r = plan(world(), [{ who: ["alice"], thread: "new", place: "Old Harbour", own_scene: true }], { speakers: ["alice"] });
  assert.deepEqual(kinds(r), ["split"]);
  assert.deepEqual(r.ops[0].ids, ["alice"]); assert.equal(r.ops[0].place, "Old Harbour"); assert.equal(r.ops[0].span, "short");
});

test("a step aside, a missing place, an unknown handle or an unknown name moves no one", () => {
  const w = world();
  for (const rep of [{ who: ["alice"], thread: "new", place: "the hall", own_scene: false }, { who: ["alice"], thread: "new", own_scene: true }, { who: ["alice"], thread: "T9" }, { who: ["nobody"], thread: "new", place: "x", own_scene: "yes" }]) {
    assert.deepEqual(plan(w, [rep], { speakers: ["alice"] }).ops, [], JSON.stringify(rep));
  }
});

test("authority: a player moves only on their own line in a human or relay round; co-players only after their own lines", () => {
  const w = world();
  const go = [{ who: ["alice", "harriet"], thread: "new", place: "Docks", own_scene: true }];
  assert.deepEqual(plan(w, go, { speakers: ["bob"] }).ops.flatMap((o) => o.ids ?? []), [], "another player's line moves neither Alice nor (in a human round) Harriet");
  for (const mode of ["followup", "kickoff", "quiet", "side", "arrival"]) assert.ok(!plan(w, go, { mode, speakers: ["alice"] }).ops.some((o) => (o.ids ?? []).includes("alice")), `no player move in ${mode}`);
  assert.deepEqual(plan(w, go, { mode: "followup" }).ops[0].ids, ["harriet"], "the co-player moves after its own line");
  assert.ok(plan(w, go, { mode: "kickoff" }).ignored.some((i) => i.id === "harriet"), "not at kickoff");
});

test("the whole scene going to one place relocates the thread instead of opening a window", () => {
  const w = world({ main: ["alice", "bob"] });
  const r = plan(w, [{ who: ["alice", "bob"], thread: "new", place: "Docks", own_scene: true, time: "night" }], { speakers: ["alice", "bob"] });
  assert.deepEqual(kinds(r), ["relocate"]); assert.equal(r.ops[0].timeline, MAIN); assert.equal(r.ops[0].location, "Docks"); assert.equal(r.ops[0].narrativeTime, "night");
});

test("everyone leaving for two places: the group with the players keeps the scene", () => {
  const w = world({ main: ["alice", "bob"] });
  const r = plan(w, [{ who: ["alice"], thread: "new", place: "Docks", own_scene: true }, { who: ["bob"], thread: "new", place: "Mill", own_scene: true }], { speakers: ["alice", "bob"] });
  assert.deepEqual(kinds(r).sort(), ["relocate", "split"]);
  assert.equal(r.ops.find((o) => o.op === "relocate").location, "Docks", "first listed wins the tie");
  assert.deepEqual(r.ops.find((o) => o.op === "split").ids, ["bob"]);
});

test("when only co-players would stay in the Main Chat, the players keep it and the co-players get a side window", () => {
  const w = world({ main: ["alice", "harriet"] });
  w.tl.main().location = "Hale House";
  const r = plan(w, [{ who: ["alice"], thread: "new", place: "Docks", own_scene: true }], { speakers: ["alice"] });
  const split = r.ops.find((o) => o.op === "split");
  assert.deepEqual(split.ids, ["harriet"]); assert.equal(split.place, "Hale House");
  assert.equal(r.ops.find((o) => o.op === "relocate").location, "Docks");
});

test("places match: going where you already are is no move; going to another thread's place joins it", () => {
  const w = world({ main: ["bob", "harriet"], threads: [{ place: "Old Harbour", members: ["alice"], window: "w-harbour" }] });
  assert.deepEqual(plan(w, [{ who: ["alice"], thread: "new", place: "the old harbour", own_scene: true }], { scene: "Old Harbour", speakers: ["alice"] }).ops, []);
  const r = plan(w, [{ who: ["harriet"], thread: "new", place: "Old Harbour", own_scene: true }], { mode: "followup" });
  assert.deepEqual(r.ops, [{ op: "move", ids: ["harriet"], to: w.tl.atPlace("Old Harbour").id }], "a co-player joins without any window change");
});

test("reunions land in the main timeline; a thread left empty is merged", () => {
  const w = world({ main: ["bob"], threads: [{ place: "Old Harbour", members: ["alice"], window: "w-harbour" }] });
  const harbour = w.tl.atPlace("Old Harbour");
  const back = plan(w, [{ who: ["alice"], thread: "T0" }], { scene: harbour.id, speakers: ["alice"] });
  assert.deepEqual(back.ops.map((o) => [o.op, o.from ?? o.to, o.into]), [["move", MAIN, undefined], ["merge", harbour.id, MAIN]]);
  const there = plan(w, [{ who: ["bob"], thread: `T${harbour.handle}` }], { speakers: ["bob"] });
  assert.deepEqual(there.ops.map((o) => o.op), ["merge", "relocate"], "the Main Chat party walks to Alice: her thread comes back to the Main Chat");
  assert.equal(there.ops[0].from, harbour.id); assert.equal(there.ops[1].location, "Old Harbour");
});

test("privacy: a player joining a thread whose window they are not in regroups it into a fresh window", () => {
  const w = world({ main: ["bob", "harriet"], threads: [{ place: "Old Harbour", members: ["alice", "tomas"], window: "w-harbour" }] });
  const harbour = w.tl.atPlace("Old Harbour");
  w.tl.main().members.push("carol"); PEOPLE.carol = { pc: true, user: "u-carol" };
  const r = plan(w, [{ who: ["carol"], thread: `T${harbour.handle}` }], { speakers: ["carol"], scope: ["bob", "harriet", "carol"] });
  const split = r.ops.find((o) => o.op === "split");
  assert.ok(split, "a fresh window"); assert.equal(split.replaces, harbour.id);
  assert.deepEqual(split.ids.sort(), ["alice", "carol", "tomas"]);
  delete PEOPLE.carol;
});

test("the cap refuses the newest split before anything else is decided", () => {
  const w = world({ main: ["alice", "bob", "harriet", "tomas"], threads: [{ place: "A", members: [], window: "w-a" }, { place: "B", members: [], window: "w-b" }] });
  const r = planWhereabouts({ ...{}, timelines: w.tl, scene: { timeline: w.tl.main() }, reports: validateWhereabouts([{ who: ["alice"], thread: "new", place: "Docks", own_scene: true }, { who: ["bob"], thread: "new", place: "Mill", own_scene: true }]), scopeIds: new Set(w.tl.main().members), speakers: new Set(["alice", "bob"]), mode: "human", resolve: (n) => n, isPc: (id) => PEOPLE[id]?.pc, guard: new Guard(), turn: 1, now: 1e7, cfg: CFG });
  assert.deepEqual(r.ops.filter((o) => o.op === "split").map((o) => o.ids), [["alice"]]);
  assert.ok(r.ignored.some((i) => i.id === "bob" && /too many/.test(i.why)));
});

test("guard: a co-player's move right after a change needs two agreeing later turns; players' own moves are exempt", () => {
  const w = world({ main: ["alice", "harriet"] });
  const guard = new Guard();
  guard.commit(["harriet"], { turn: 5, now: 10_000_000, seq: 1, prevOf: () => "t-old" });
  const back = [{ who: ["harriet"], thread: "new", place: "Cellar", own_scene: true }];
  let r = plan(w, back, { mode: "followup", guard, turn: 5, now: 10_000_000 });
  assert.deepEqual(r.ops, [], "same turn as the change: deferred"); guard.apply(r.guard);
  r = plan(w, back, { mode: "followup", guard, turn: 6, now: 10_000_000 });
  assert.deepEqual(r.ops, [], "a vote cast in the turn of the change does not count"); guard.apply(r.guard);
  r = plan(w, back, { mode: "followup", guard, turn: 7, now: 10_000_000 });
  assert.equal(r.ops[0]?.op, "split", "two agreeing turns after the change");
  const pcGuard = new Guard(); pcGuard.commit(["alice"], { turn: 5, now: 10_000_000, seq: 1, prevOf: () => MAIN });
  assert.equal(plan(world({ main: ["alice", "bob"] }), [{ who: ["alice"], thread: "new", place: "Cellar", own_scene: true }], { speakers: ["alice"], guard: pcGuard, turn: 5, now: 10_000_000 + 400000 }).ops[0]?.op, "split", "a player's explicit move is never deferred");
});

test("a player gets a new window at most once per cooldown", () => {
  const guard = new Guard(); guard.by.alice = { ...guard.rec("alice"), windowAt: 10_000_000 };
  const r = plan(world({ main: ["alice", "bob"] }), [{ who: ["alice"], thread: "new", place: "Docks", own_scene: true }], { speakers: ["alice"], guard, now: 10_000_000 + 1000 });
  assert.deepEqual(r.ops, []); assert.match(r.ignored[0].why, /moments ago/);
});

test("the brief shows handles, places, spans, who may move and the cap", () => {
  const w = world({ main: ["bob"], threads: [{ place: "Old Harbour", members: ["alice"], window: "w-harbour", span: "long" }] });
  const text = whereaboutsBrief({ timelines: w.tl, scene: { timeline: w.tl.main() }, nameOf: (id) => id, windowName: () => "Scene: Old Harbour", isPc: (id) => PEOPLE[id].pc, mayMove: ["bob"], capReached: true });
  assert.match(text, /T0 "Main story" ← this scene/); assert.match(text, /T1 "Old Harbour" in window "Scene: Old Harbour", at Old Harbour, long split: alice \(player\)/);
  assert.match(text, /May move this turn: bob/); assert.match(text, /No new scene can open now/);
});

test("validateWhereabouts never throws and accepts loose booleans", () => {
  assert.deepEqual(validateWhereabouts("nonsense"), []);
  assert.deepEqual(validateWhereabouts([null, { who: "x" }, { who: ["a"], thread: "new", place: "p", own_scene: "yes" }]).map((e) => e.ownScene), [true]);
});
