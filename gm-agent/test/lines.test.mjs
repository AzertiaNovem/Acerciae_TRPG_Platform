import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLine } from "../src/context/lines.mjs";
import { RULE_SYSTEMS, rulesProfile } from "../src/rules/index.mjs";

let seq = 0;
const line = (over) => ({ id: `m${++seq}`, seq, chat_window_id: "w-main", visibility: "window", kind: "ic", content: "hello", author_role: "player", character_name: "Alice", ...over });

test("roll lines show the platform's dice text; narration is attributed to the GM", () => {
  assert.match(renderLine(line({ kind: "roll", content: ".ra Spot Hidden", dice: { text: "Alice rolled 23/60: Success" } })), /\.ra Spot Hidden → Alice rolled 23\/60/);
  assert.match(renderLine(line({ kind: "narration", character_name: null, author_role: "gm", content: "Rain." })), /GM \(narration\): Rain\./);
});

test("a line can carry its timeline for the GM", () => {
  assert.match(renderLine(line({ content: "We found a badge." }), { timeline: "The docks" }), /Alice \[timeline: The docks\]: We found a badge\./);
});

test("a picture line reads as words: its caption, and that it is a picture the model cannot see", () => {
  const shown = renderLine(line({ content: "🖼️ A torn page: \"Meet me at the pier at midnight.\"", media_asset_id: "a1" }));
  assert.match(shown, /Alice: \[posts a picture; you cannot see it, its caption says:\] A torn page: "Meet me at the pier at midnight\."$/);
  assert.match(renderLine(line({ content: "🖼️", media_asset_id: "a2", kind: "ooc" })), /Alice \(out of character\): \[posts a picture without a caption; you cannot see pictures\]$/);
  // The same text without a picture attached is just what someone typed.
  assert.match(renderLine(line({ content: "🖼️ imagine a lighthouse" })), /Alice: 🖼️ imagine a lighthouse$/);
});

test("renderLine labels the GM account's lines \"GM\", in every rule system", () => {
  const m = line({ content: "The door creaks.", kind: "narration", author_role: "gm", character_name: null, visibility: "gm_only" });
  assert.match(renderLine(m, { markVisibility: true }), /^#\d+ GM \(narration\) \[GM only\]: The door creaks\.$/);
  for (const id of RULE_SYSTEMS) assert.equal(renderLine(m, { markVisibility: true, gm: rulesProfile(id).vocab.gm }), renderLine(m, { markVisibility: true }), id);
  assert.match(renderLine(line({ content: "ok", author_role: "gm", character_name: null })), /^#\d+ GM: ok$/);
});
