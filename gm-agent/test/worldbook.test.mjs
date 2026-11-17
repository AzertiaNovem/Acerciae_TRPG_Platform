import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { worldbookState, validateWorldbook, keyMatcher, entriesInPlay, findEntry, renderIndex, renderInPlay } from "../src/worldbook.mjs";
import { operatorPath, readOperatorFile, writeOperatorFile, watchOperatorFile, RevisionConflict } from "../src/operator-files.mjs";

const entry = (id, title, body, extra = {}) => ({ id, title, body, keys: [], secret: false, enabled: true, ...extra });
const BOOK = worldbookState({ bible: "Kingsport, 1923.", entries: [
  entry("e1", "Harbour Guild", "The Guild runs the docks.", { keys: ["guild hall", "dockmasters"] }),
  entry("e2", "The drowned keeper", "The keeper was murdered by the Guild master.", { secret: true, keys: ["lighthouse"] }),
  entry("e3", "灯塔", "旧灯塔在北岬。", { keys: ["北岬"] }),
  entry("e4", "Old customs", "x".repeat(3000), { keys: ["custom house"] }),
  entry("e5", "Retired", "Not in use.", { enabled: false }),
] });

test("worldbook: a file's content becomes a usable book; broken entries are left out", () => {
  const b = worldbookState({ bible: " B ", entries: [entry("e1", "A", "a", { keys: "x, y，z、 x" }), entry("bad", "B", "b"), entry("e1", "dup", "d"), entry("e2", "", "no title"), entry("e3", "No body", "  ")] });
  assert.equal(b.bible, "B");
  assert.deepEqual(b.entries.map((e) => e.id), ["e1"]);
  assert.deepEqual(b.entries[0].keys, ["x", "y", "z"]);
  assert.equal(b.nextId, 2);
  assert.deepEqual(worldbookState(null), { revision: 0, bible: "", hidden: "", entries: [], nextId: 1, updatedAt: null });
});

test("worldbook: an edit is checked strictly, and new entries get ids", () => {
  const v = validateWorldbook({ bible: "B", hidden: "H", entries: [{ id: "e7", title: "Kept", body: "k", keys: ["a"] }, { title: "New", body: "n", keys: "p, q" }] }, { nextId: 3 });
  assert.deepEqual(v.entries.map((e) => e.id), ["e7", "e8"]);
  assert.deepEqual(v.entries[1].keys, ["p", "q"]);
  assert.equal(v.nextId, 9);
  assert.throws(() => validateWorldbook({ entries: [{ title: "Same", body: "a" }, { title: "same", body: "b" }] }), /two entries are titled/);
  assert.throws(() => validateWorldbook({ entries: [{ title: "Empty", body: " " }] }), /has no text/);
  assert.throws(() => validateWorldbook({ entries: [{ title: "", body: "x" }] }), /entry 1 has no title/);
  assert.throws(() => validateWorldbook({ bible: "x".repeat(30001) }), /bible is 30001 characters/);
  assert.throws(() => validateWorldbook({ entries: [{ title: "Long", body: "x".repeat(6001) }] }), /at most 6000/);
});

test("worldbook: keys match whole words in Latin scripts and anywhere in CJK text", () => {
  assert.ok(keyMatcher("Guild")("The guild's men wait."));
  assert.ok(!keyMatcher("Guild")("We reached Guildford."));
  assert.ok(keyMatcher("guild hall")("at the Guild  Hall tonight"));
  assert.ok(keyMatcher("北岬")("我们去北岬看看"));
  assert.equal(keyMatcher("x"), null);
});

test("worldbook: entries come into play by mention, newest first, within the budget; secrets only for the GM", () => {
  const ids = (list) => list.map((e) => e.id);
  assert.deepEqual(ids(entriesInPlay(BOOK, { texts: ["We walk to the guild hall.", "Up at the lighthouse."] })), ["e1"]);
  assert.deepEqual(ids(entriesInPlay(BOOK, { texts: ["We walk to the guild hall.", "Up at the lighthouse."], secret: true })), ["e1", "e2"]);
  assert.deepEqual(ids(entriesInPlay(BOOK, { texts: ["灯塔下"], requested: ["e4"], budget: 870 })), ["e4"], "an opened entry comes first; the rest no longer fits");
  assert.deepEqual(ids(entriesInPlay(BOOK, { texts: ["custom house, the dockmasters"], budget: 100 })), ["e1"], "a long entry that does not fit is skipped");
  assert.deepEqual(ids(entriesInPlay(BOOK, { texts: ["Retired"] })), [], "a disabled entry is never used");
  assert.deepEqual(ids(entriesInPlay(BOOK, { texts: ["灯塔下", "the dockmasters"], secret: true })), ["e1", "e3"], "book order, not mention order");
});

test("worldbook: an entry is found by title, id or key; the GM's index lists what exists", () => {
  assert.equal(findEntry(BOOK, "harbour guild").id, "e1");
  assert.equal(findEntry(BOOK, "dockmasters").id, "e1");
  assert.equal(findEntry(BOOK, "lighthouse"), null, "a secret entry is not found for a co-player");
  assert.equal(findEntry(BOOK, "lighthouse", { secret: true }).id, "e2");
  const index = renderIndex(BOOK);
  assert.match(index, /- The drowned keeper \[secret: yours alone\] \(keys: lighthouse\)/);
  assert.ok(!index.includes("Retired") && !index.includes("murdered"), "titles and keys only, never the text");
  assert.match(renderInPlay([BOOK.entries[1]], { gm: true }), /### The drowned keeper \[secret/);
  assert.match(renderInPlay([BOOK.entries[0]]), /^WHAT YOU KNOW ABOUT WHAT CAME UP/);
});

test("operator files: revisioned atomic writes, conflicts refused, readers see changes and survive a broken file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-"));
  const file = operatorPath(dir, "ch", "worldbook");
  assert.equal(readOperatorFile(file), null);
  const logs = [];
  const read = watchOperatorFile(file, (raw) => worldbookState(raw), (m) => logs.push(m));
  assert.equal(read().revision, 0);
  const first = writeOperatorFile(file, () => ({ bible: "one" }), { expect: 0 });
  assert.equal(first.revision, 1);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  assert.equal(read().bible, "one");
  assert.throws(() => writeOperatorFile(file, () => ({ bible: "stale" }), { expect: 0 }), RevisionConflict);
  writeOperatorFile(file, (cur) => ({ ...cur, bible: "two" }), { expect: 1 });
  assert.equal(read().bible, "two");
  fs.writeFileSync(file, "{ not json");
  assert.equal(read().bible, "two", "the last good copy stays");
  assert.match(logs[0], /not valid JSON/);
  assert.throws(() => writeOperatorFile(file, () => ({ bible: "over" })), /not valid JSON/, "a broken file is never overwritten blindly");
  fs.writeFileSync(file, JSON.stringify({ revision: 2, bible: "fixed by hand" }));
  fs.writeFileSync(`${file}.lock`, ""); fs.utimesSync(`${file}.lock`, new Date(0), new Date(0));
  assert.equal(writeOperatorFile(file, () => ({ bible: "three" })).bible, "three", "a stale lock is cleared");
  assert.ok(!fs.existsSync(`${file}.lock`));
});

test("intentions: an edit sets or clears a co-player's intention, and only a co-player's", async () => {
  const { intentionsState, applyIntentions, renderIntention } = await import("../src/intentions.mjs");
  const current = { intentions: { "c-h": { text: "old", at: "x" }, "c-z": { text: "keep", at: "y" } } };
  const out = applyIntentions(current, { "c-h": "  Win Mina's trust.  ", "c-q": "" }, { coplayers: ["c-h", "c-q", "c-z"], now: "now" });
  assert.deepEqual(out, { "c-h": { text: "Win Mina's trust.", at: "now" }, "c-z": { text: "keep", at: "y" } });
  assert.deepEqual(Object.keys(applyIntentions(current, { "c-h": "" }, { coplayers: ["c-h"] })), ["c-z"], "an empty text clears it");
  assert.throws(() => applyIntentions(current, { "c-alice": "x" }, { coplayers: ["c-h"] }), /not a co-player/);
  assert.throws(() => applyIntentions(current, { "c-h": "x".repeat(1001) }, { coplayers: ["c-h"] }), /at most 1000/);
  assert.deepEqual(intentionsState({ intentions: { "bad id!": { text: "x" }, ok: { text: " " } } }).intentions, {});
  assert.equal(renderIntention(""), "");
  assert.match(renderIntention("Win."), /^YOUR STANDING INTENTION .*\nWin\.$/s);
});
