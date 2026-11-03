import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCalendar, calendarState, dateLabel, describeCalendar, eraYears, fitEra, parseIso, renderCalendar } from "../src/calendar.mjs";
import { distinctiveTraits, impression } from "../src/context/traits.mjs";
import { investigatorProfile } from "../src/context/profiles.mjs";
import { applyBond, bondsFor, bondsState, renderBonds, renderBondsFor, resolveBonds } from "../src/bonds.mjs";

test("calendar: dates are YYYY-MM-DD with their weekday, across months and leap years; it never runs backwards", () => {
  assert.equal(dateLabel("1924-02-28"), "1924-02-28 (Thursday)");
  assert.equal(parseIso("1925-02-30"), null); assert.equal(parseIso("the 3rd of Rain-moon"), null);
  const cal = calendarState(null);
  assert.equal(describeCalendar(cal), "", "nothing set yet");
  assert.match(advanceCalendar(cal, { days: 2 }).refused, /no date yet/, "no days pass before the first date");
  assert.match(advanceCalendar(cal, { date: "the 3rd of Rain-moon" }).refused, /dates are YYYY-MM-DD/);
  assert.equal(advanceCalendar(cal, { date: "1924-02-28", time: "evening", by: "planner" }).changed, true);
  assert.equal(describeCalendar(cal), "1924-02-28 (Thursday), evening");
  assert.equal(cal.log[0].days, 0, "setting the first date is not a day passing");
  const r = advanceCalendar(cal, { days: 2, by: "final review", why: "they slept on it", seq: 40 });
  assert.deepEqual([r.changed, r.days, cal.date, cal.time], [true, 2, "1924-03-01", ""], "29 February counted; the time of day is cleared");
  assert.match(advanceCalendar(cal, { date: "1924-02-01" }).refused, /never runs backwards/);
  assert.match(advanceCalendar(cal, { days: -1 }).refused, /never runs backwards/);
  assert.equal(advanceCalendar(cal, { date: "1924-03-08", time: "noon" }).days, 7, "a later date counts the days between");
  assert.equal(advanceCalendar(cal, { days: 400, maxDays: 30 }).days, 30, "clipped to the most days at once");
  assert.equal(cal.log.at(-1).by, "keeper"); assert.equal(cal.log[1].seq, 40);
  assert.deepEqual(calendarState(JSON.parse(JSON.stringify(cal))), cal, "survives a round trip");
  assert.equal(calendarState({ date: "the 3rd of Rain-moon" }).date, "", "an old free-text date is dropped");
  assert.match(renderCalendar(cal), /^## Calendar \(the story's date, YYYY-MM-DD/); assert.match(renderCalendar(cal), /Today in the story: 1924-04-07 \(Monday\)/);
  assert.doesNotMatch(renderCalendar(cal), /day \d+ of the story/);
  assert.match(renderCalendar(calendarState({ time: "dusk" })), /no date set yet \(the story planner chooses the first one\); time of day: dusk/);
});

test("calendar: the planner's first date stays within the channel's era", () => {
  assert.deepEqual(eraYears("1920s"), { from: 1920, to: 1929 });
  assert.deepEqual(eraYears("1890-1899"), { from: 1890, to: 1899 });
  assert.deepEqual(eraYears("Jazz Age, 1923"), { from: 1923, to: 1923 });
  assert.equal(eraYears("the present day"), null);
  assert.deepEqual(fitEra("1925-09-14", "1920s"), { date: "1925-09-14", moved: false });
  assert.deepEqual(fitEra("1935-09-14", "1920s"), { date: "1929-09-14", moved: true });
  assert.deepEqual(fitEra("1904-02-29", "1890s"), { date: "1899-02-28", moved: true }, "no 29 February in 1899");
  assert.deepEqual(fitEra("2031-05-02", ""), { date: "2031-05-02", moved: false }, "no era: any real date");
  assert.equal(fitEra("next Tuesday", "1920s"), null);
});

test("traits: only the extremes, in words, the most extreme first; luck and numbers never", () => {
  const card = { characteristics: { APP: 88, INT: "90", STR: 22, SIZ: 40, DEX: 50, LUK: 95, EDU: 75 }, basic: { sex: "female", age: "31" } };
  assert.deepEqual(distinctiveTraits(card), ["extremely intelligent", "extremely good-looking, striking", "very small, slight build"]);
  assert.deepEqual(distinctiveTraits(card, { max: 5 }).slice(-1), ["physically weak"]);
  assert.deepEqual(distinctiveTraits({ characteristics: { INT: 79, APP: 26, SIZ: 46 } }), [], "nothing distinctive");
  assert.equal(impression(card), "(female, 31; extremely intelligent; extremely good-looking, striking; very small, slight build)");
  assert.equal(impression({}), "");
  const profile = investigatorProfile({ name: "A", role_card: card }).join("\n");
  assert.match(profile, /gender: female/); assert.match(profile, /notable: extremely intelligent/);
  assert.doesNotMatch(profile, /\b(88|90|95)\b/, "no numbers");
});

test("bonds: unordered pairs, updated in place, ended; the Keeper reads all, a co-player its own and the public ones it knows", () => {
  const bonds = bondsState(null);
  assert.equal(applyBond(bonds, { a: "alice", b: "harriet", kind: "Lives with", note: "a flat above the shop" }), "added");
  assert.equal(applyBond(bonds, { a: "harriet", b: "alice", kind: "lives with" }), null, "the same pair either way round");
  assert.equal(applyBond(bonds, { a: "harriet", b: "alice", kind: "lives with", secret: true }), "updated");
  applyBond(bonds, { a: "grimsby", b: "ezra", kind: "family", note: "Grimsby is Ezra's brother", secret: true });
  applyBond(bonds, { a: "grimsby", b: "alice", kind: "rivals" });
  applyBond(bonds, { a: "grimsby", b: "harriet", kind: "lovers", secret: true });
  assert.equal(applyBond(bonds, { a: "x", b: "x", kind: "friends" }), null, "never with oneself");
  const names = { alice: "Alice", harriet: "Harriet", grimsby: "Mr. Grimsby", ezra: "Ezra" };
  const nameOf = (id) => names[id];
  const gm = renderBonds(bonds, nameOf);
  assert.match(gm, /Alice — Harriet: lives with \(a flat above the shop\) \[secret\]/); assert.match(gm, /Mr\. Grimsby — Ezra: family/);
  const known = new Set(["alice", "harriet", "grimsby"]);
  assert.deepEqual(bondsFor(bonds, "harriet", known).map((b) => b.kind), ["lives with", "rivals", "lovers"], "her own (secret or not) and the public one she knows of");
  assert.deepEqual(bondsFor(bonds, "harriet", new Set(["alice", "harriet"])).map((b) => b.kind), ["lives with", "lovers"], "not between people she has not met");
  assert.match(renderBondsFor(bonds, "harriet", known, nameOf), /^WHO IS WHO TO WHOM[\s\S]*Mr\. Grimsby — Harriet \(you\): lovers/);
  assert.doesNotMatch(renderBondsFor(bonds, "harriet", known, nameOf), /\[secret\]|Ezra/);
  assert.equal(applyBond(bonds, { a: "alice", b: "grimsby", end: true }), "ended");
  assert.equal(bonds.length, 3);
  const resolved = resolveBonds([{ a: "Alice", b: "Nobody", kind: "friends" }, { a: "Alice", b: "Harriet", kind: "friends" }, { a: "Alice", b: "Harriet" }], (n) => ({ Alice: "alice", Harriet: "harriet" })[n]);
  assert.deepEqual(resolved.map((b) => [b.a, b.b, b.kind]), [["alice", "harriet", "friends"]]);
  assert.deepEqual(bondsState(JSON.parse(JSON.stringify(bonds))), bonds);
});
