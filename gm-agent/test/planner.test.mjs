import { test } from "node:test";
import assert from "node:assert/strict";
import { leaksSecret, narrationRepeats, plannerDue, plannerModeOf, plannerState, renderPlanNote, renderStoryPlan, stallSignature, validateCritique, validateImpulses, validateStoryPlan } from "../src/planner.mjs";
import { estimateTokens } from "../src/memory.mjs";

const CFG = { intervalMs: 30 * 60000, minLines: 40, cooldownMs: 10 * 60000, stallTurns: 6, maxRunsPerHour: 4 };
const snap = (over = {}) => ({ on: true, busy: false, overBudget: false, now: 10_000_000, lastHumanAt: 10_000_000, idleMs: 30 * 60000, runs: [], lastRunAt: 0, lastRunSeq: 0, lastSeq: 100, arc: { version: 1 }, asked: null, scenarioId: "sc1", plannerScenarioId: "sc1", stallTurns: 0, ...over });

test("plannerState normalises and survives a round trip; the mode follows the improvisation switch", () => {
  const s = plannerState({ on: false, arc: { version: 2 }, impulses: [{ coplayerId: "c", text: "x" }, { bad: true }], runs: [1, "x"], stall: { turns: "3" }, notes: [{ text: "a" }] });
  assert.equal(s.on, false); assert.deepEqual(s.impulses.map((i) => i.coplayerId), ["c"]); assert.deepEqual(s.runs, [1]); assert.equal(s.stall.turns, 3);
  assert.deepEqual(plannerState(JSON.parse(JSON.stringify(s))), s);
  assert.equal(plannerState(null).on, true, "on by default");
  assert.equal(plannerModeOf(s, { on: true }), "off"); assert.equal(plannerModeOf(plannerState(null), { on: true }), "full"); assert.equal(plannerModeOf(plannerState(null), { on: false }), "pace");
});

test("plannerDue: the reasons, in order, and everything that blocks a run", () => {
  assert.equal(plannerDue(snap({ on: false }), CFG), null);
  assert.equal(plannerDue(snap({ busy: true, asked: { why: "x" } }), CFG), null);
  assert.equal(plannerDue(snap({ overBudget: true, asked: { why: "x" } }), CFG), null);
  assert.equal(plannerDue(snap({ lastHumanAt: 10_000_000 - 31 * 60000, asked: { why: "x" } }), CFG), null, "away");
  assert.equal(plannerDue(snap({ runs: [1, 2, 3, 4].map((i) => 10_000_000 - i * 60000), asked: { why: "x" } }), CFG), null, "hourly cap");
  assert.equal(plannerDue(snap({ arc: null, lastSeq: 9 }), CFG), null, "a first plan waits for ten lines");
  assert.equal(plannerDue(snap({ arc: null, lastSeq: 10 }), CFG), "first");
  assert.equal(plannerDue(snap({ lastRunAt: 10_000_000 - 5 * 60000, asked: { why: "x" } }), CFG), null, "cooldown");
  assert.equal(plannerDue(snap({ lastRunAt: 10_000_000 - 11 * 60000, asked: { why: "x" } }), CFG), "asked");
  assert.equal(plannerDue(snap({ lastRunAt: 10_000_000 - 11 * 60000, plannerScenarioId: "old" }), CFG), "scenario");
  assert.equal(plannerDue(snap({ lastRunAt: 10_000_000 - 11 * 60000, stallTurns: 6 }), CFG), "stall");
  assert.equal(plannerDue(snap({ lastRunAt: 10_000_000 - 31 * 60000, lastSeq: 39 }), CFG), null, "interval without enough lines");
  assert.equal(plannerDue(snap({ lastRunAt: 10_000_000 - 11 * 60000, lastSeq: 400 }), CFG), null, "lines without the interval");
  assert.equal(plannerDue(snap({ lastRunAt: 10_000_000 - 31 * 60000, lastSeq: 40 }), CFG), "interval");
  assert.equal(plannerDue(snap({ lastRunAt: 10_000_000 - 31 * 60000, lastSeq: 400 }), { ...CFG, intervalMs: 0 }), null, "interval 0: manual only");
});

test("stall signature and repeated narration", () => {
  const a = stallSignature({ scenarioId: "s", place: "docks", worldVersion: 3, worldChange: "t1", truths: 2, threads: 1 });
  assert.equal(a, stallSignature({ scenarioId: "s", place: "docks", worldVersion: 3, worldChange: "t1", truths: 2, threads: 1 }));
  assert.notEqual(a, stallSignature({ scenarioId: "s", place: "docks", worldVersion: 4, worldChange: "t1", truths: 2, threads: 1 }));
  const same = "The fog rolls in over the harbour and the lamps gutter in the wind.";
  assert.equal(narrationRepeats([same, same + " You wait.", same]), true);
  assert.equal(narrationRepeats(["The fog rolls in over the harbour.", "A carriage rattles past the church.", "Silas lights his pipe and says nothing."]), false);
  assert.equal(narrationRepeats(["雾气笼罩着港口，灯火摇曳不定。", "雾气笼罩着港口，灯火摇曳不定，你们等待着。", "雾气笼罩着港口，灯火摇曳。"]), true);
  assert.equal(narrationRepeats(["only one"]), false);
});

test("leaksSecret: a quoted secret is caught, a paraphrase is not, CJK too", () => {
  const secrets = ["The Guild master, Ezra Whateley, drowned Silas because Silas saw what the night boats bring in.", "守秘人的秘密：灯塔看守人西拉斯是被公会首领埃兹拉亲手淹死的，因为他看见了夜船。"];
  assert.equal(leaksSecret("You remember that Ezra Whateley drowned Silas because Silas saw the boats", secrets), true);
  assert.equal(leaksSecret("You want to know why the keeper died; the Guild makes you uneasy.", secrets), false);
  assert.equal(leaksSecret("你总觉得灯塔看守人西拉斯是被公会首领埃兹拉亲手淹死的", secrets), true);
  assert.equal(leaksSecret("你想今晚去码头看看夜船。", secrets), false);
  assert.equal(leaksSecret("", secrets), false);
});

test("impulses: one per co-player by name, never a secret quote or talk of the game", () => {
  const coplayers = [{ characterId: "c1", name: "Harriet Vance" }, { characterId: "c2", name: "Tomas Leclerc" }];
  const out = validateImpulses([
    { who: "harriet vance", text: "You want to see the docks tonight." },
    { who: "Harriet Vance", text: "A second one for her." },
    { who: "Nobody", text: "x" },
    { who: "Tomas Leclerc", text: "The planner wants you at the mill." },
    { who: "Tomas Leclerc", text: "Ezra Whateley drowned Silas because Silas saw the night boats." },
  ], { coplayers, secrets: ["Ezra Whateley drowned Silas because Silas saw what the night boats bring in."], version: 3, lastSeq: 100, lifetime: 60 });
  assert.deepEqual(out.map((i) => [i.coplayerId, i.version, i.expiresSeq]), [["c1", 3, 160]]);
  assert.equal(out[0].text, "You want to see the docks tonight.");
});

test("validateStoryPlan clips, caps, keeps ids across versions, numbers new threads; pace mode keeps only the beat", () => {
  const prev = { version: 2, threads: [{ id: "P1", title: "Old" }, { id: "P2", title: "Older" }], beat: { title: "Same beat", startedSeq: 10, startedVersion: 1 } };
  const long = "x".repeat(500);
  const { arc, nextId, rawImpulses } = validateStoryPlan({
    throughline: long,
    threads: [{ id: "P2", title: "Older", status: "ripe" }, { id: "new", title: "Fresh", status: "nonsense", hooks: ["a", "b", "c", "d"] }, { id: "P9", title: "Unknown id", status: "seed" }, { title: "" }, ...Array.from({ length: 10 }, (_, i) => ({ id: "new", title: `T${i}`, status: "live" }))],
    beat: { title: "Same beat", exit: long }, next: [{ what: "a" }, { what: "b" }, { what: "c" }, { what: "d" }], verdict: { move_on: "true", why: "done" },
    impulses: [{ who: "H", text: "t" }], played: "ok", changed: "c",
  }, { mode: "full", prev, nextId: 5, seq: 200, trigger: "interval", now: 0 });
  assert.equal(arc.version, 3); assert.equal(arc.throughline.length, 300); assert.equal(arc.beat.exit.length, 200);
  assert.deepEqual([arc.beat.startedSeq, arc.beat.startedVersion], [10, 1], "the beat continues");
  assert.equal(arc.threads[0].id, "P2"); assert.equal(arc.threads[1].id, "P5", "a new thread gets the next number"); assert.equal(arc.threads[1].status, "live"); assert.equal(arc.threads[1].hooks.length, 3);
  assert.equal(arc.threads[2].id, "P6", "an unknown id is renumbered");
  assert.equal(arc.threads.length, 8); assert.equal(nextId, 5 + 12); assert.equal(arc.next.length, 3);
  assert.deepEqual(arc.verdict, { moveOn: true, why: "done", sinceSeq: 200 }); assert.deepEqual(rawImpulses, [{ who: "H", text: "t" }]);
  const other = validateStoryPlan({ beat: { title: "New beat" } }, { prev, nextId: 1, seq: 300 });
  assert.deepEqual([other.arc.beat.startedSeq, other.arc.beat.startedVersion], [300, 3]);
  const pace = validateStoryPlan({ throughline: "x", threads: [{ title: "T" }], beat: { title: "B" }, next: [{ what: "n" }], impulses: [{ who: "H", text: "t" }] }, { mode: "pace" });
  assert.deepEqual([pace.arc.threads, pace.arc.next, pace.arc.throughline], [[], [], ""]);
  assert.throws(() => validateStoryPlan(null), /object/); assert.throws(() => validateStoryPlan({ threads: [] }), /beat\.title/);
  assert.deepEqual(validateCritique("junk").must_fix, []); assert.equal(validateCritique({ beat_done: true, must_fix: ["a"] }).beat_done, true);
});

test("renderStoryPlan stays within its budget by dropping resolved, then seed threads; the note is short", () => {
  const threads = [...Array.from({ length: 4 }, (_, i) => ({ id: `P${i}`, title: `Live ${i}`, status: "live", stakes: "s".repeat(150), twist: "t".repeat(200) })), { id: "P8", title: "Done", status: "resolved", stakes: "x".repeat(150) }, { id: "P9", title: "Seed", status: "seed", stakes: "y".repeat(150) }];
  const arc = { version: 1, mode: "full", throughline: "A town.", threads, beat: { title: "B", exit: "e" }, next: [{ what: "n" }], verdict: { moveOn: false }, review: { changed: "c" } };
  const full = renderStoryPlan(arc, 100000);
  assert.ok(full.includes("P8") && full.includes("P9") && full.startsWith("## Story plan (your private plan"));
  const tight = renderStoryPlan(arc, 450);
  assert.ok(!tight.includes("P8") && !tight.includes("P9") && tight.includes("P0"), tight);
  assert.ok(estimateTokens(tight) <= 450 || tight.split("\n- ").length === 1);
  assert.match(renderStoryPlan({ ...arc, mode: "pace", threads: [], next: [] }, 1000), /^## Story plan \(pace only/);
  const note = renderPlanNote({ ...arc, trigger: "stall", verdict: { moveOn: true, why: "six turns in one room" } }, [{ name: "Harriet Vance" }]);
  assert.match(note, /^Story plan v1 \(stall\) — beat "B": exit when e\. Verdict: MOVE ON — six turns in one room\./);
  assert.match(note, /Impulse for Harriet Vance\./); assert.ok(note.length <= 900);
});
