import { test } from "node:test";
import assert from "node:assert/strict";
import { coplayerLog, visibleToCoplayer, renderLine } from "../src/context/coplayerContext.mjs";

const me = { characterId: "c-me", name: "Harriet", seats: [{ windowId: "w-main", fromSeq: 0, toSeq: null }, { windowId: "w-private", fromSeq: 0, toSeq: null }] };
let seq = 0;
const line = (over) => ({ id: `m${++seq}`, seq, chat_window_id: "w-main", visibility: "window", kind: "ic", content: "hello", author_role: "player", character_name: "Alice", ...over });

test("a co-player sees window lines and whispers to itself, in the windows it sits in", () => {
  const lines = [
    line({ content: "public line" }),
    line({ content: "whisper to me", visibility: "whisper", whisper_to: ["c-me"], author_role: "gm", character_name: null }),
    line({ content: "private window line", chat_window_id: "w-private" }),
  ];
  assert.deepEqual(coplayerLog(me, lines).map((m) => m.content), ["public line", "whisper to me", "private window line"]);
});

test("Keeper-only lines, other characters' whispers and other windows never reach a co-player", () => {
  const secret = [
    line({ content: "KEEPER NOTE: the butler did it", visibility: "gm_only", author_role: "gm" }),
    line({ content: "hidden roll result 07", visibility: "gm_only", kind: "roll", dice: { text: "secret" } }),
    line({ content: "whisper to Bob", visibility: "whisper", whisper_to: ["c-bob"] }),
    line({ content: "another window", chat_window_id: "w-other" }),
    line({ content: "unknown visibility", visibility: "something_new" }),
  ];
  assert.equal(coplayerLog(me, secret).length, 0);
  for (const m of secret) assert.equal(visibleToCoplayer(me, m), false, m.content);
});

test("the newest lines are kept, oldest first", () => {
  const many = Array.from({ length: 30 }, (_, i) => line({ content: `l${i}` }));
  const log = coplayerLog(me, [...many].reverse(), 5);
  assert.deepEqual(log.map((m) => m.content), ["l25", "l26", "l27", "l28", "l29"]);
});

test("roll lines show the platform's dice text; narration is attributed to the Keeper", () => {
  assert.match(renderLine(line({ kind: "roll", content: ".ra Spot Hidden", dice: { text: "Alice rolled 23/60: Success" } })), /\.ra Spot Hidden → Alice rolled 23\/60/);
  assert.match(renderLine(line({ kind: "narration", character_name: null, author_role: "gm", content: "Rain." })), /Keeper \(narration\): Rain\./);
});

test("a seat has a start and an end: a co-player hears a window only while it sits there", () => {
  const traveller = { characterId: "c-me", name: "Harriet", seats: [{ windowId: "w-main", fromSeq: 0, toSeq: 10 }, { windowId: "w-side", fromSeq: 11, toSeq: 20 }, { windowId: "w-main", fromSeq: 21, toSeq: null }] };
  const lines = [
    { seq: 5, chat_window_id: "w-main", visibility: "window", content: "before leaving" },
    { seq: 12, chat_window_id: "w-main", visibility: "window", content: "MAIN-WHILE-AWAY" },
    { seq: 15, chat_window_id: "w-side", visibility: "window", content: "on the side trip" },
    { seq: 16, chat_window_id: "w-other-side", visibility: "window", content: "OTHER-SIDE" },
    { seq: 25, chat_window_id: "w-side", visibility: "window", content: "SIDE-AFTER-RETURN" },
    { seq: 30, chat_window_id: "w-main", visibility: "window", content: "after returning" },
  ];
  assert.deepEqual(coplayerLog(traveller, lines).map((m) => m.content), ["before leaving", "on the side trip", "after returning"]);
});

test("a line can carry its timeline for the Keeper", () => {
  assert.match(renderLine(line({ content: "We found a badge." }), { timeline: "The docks" }), /Alice \[timeline: The docks\]: We found a badge\./);
});
