import { test } from "node:test";
import assert from "node:assert/strict";
import { artRequest, artText, drawable, isArtLine, parts, playLength, renderEntries } from "../src/plotArt.mjs";

test("the picture command: /画, /插画, /draw and /illustrate, with or without a space after a Chinese command", () => {
  assert.equal(artRequest("/画 我们在灯塔顶上看到极光的那一刻"), "我们在灯塔顶上看到极光的那一刻");
  assert.equal(artRequest("/画灯塔上的极光"), "灯塔上的极光");
  assert.equal(artRequest("/插画  雨夜的码头"), "雨夜的码头");
  assert.equal(artRequest("  /Draw   the duel\non the bridge "), "the duel on the bridge");
  assert.equal(artRequest("/illustrate the ball"), "the ball");
  assert.equal(artRequest("/画"), "");
  assert.equal(artRequest("/drawing lessons"), null, "a longer word is not the command");
  assert.equal(artRequest("please /draw this"), null, "only at the start");
  assert.equal(artRequest("/pause"), null);
  assert.equal(artRequest(`/draw ${"x".repeat(900)}`).length, 500);
});

test("what a picture may draw on, and the table's own picture traffic", () => {
  const line = { visibility: "window", kind: "ic", content: "We climb the stairs." };
  assert.ok(drawable(line));
  assert.ok(!drawable({ ...line, visibility: "whisper" }) && !drawable({ ...line, visibility: "gm_only" }));
  assert.ok(!drawable({ ...line, kind: "ooc" }) && !drawable({ ...line, recalled_at: "x" }) && !drawable({ ...line, media_asset_id: "a" }));
  assert.ok(drawable({ ...line, kind: "narration" }) && drawable({ ...line, kind: "roll" }));
  assert.ok(isArtLine({ content: "🎨 Looking for that moment" }) && isArtLine({ content: "🖼️ The pier" }) && isArtLine({ content: "x", media_asset_id: "a" }));
  assert.ok(!isArtLine({ content: "🧭 Noted." }));
});

test("the index: runs of lines, shortened and thinned to fit, summaries as given", () => {
  assert.deepEqual(parts([1, 2, 3, 4, 5], 2).map((p) => p.length), [2, 2, 1]);
  assert.equal(parts(Array.from({ length: 100 }, (_, i) => i), 5, 4).length, 4, "never more runs than asked: they grow");
  const rows = Array.from({ length: 40 }, (_, i) => ({ who: "Alice", text: `line ${i} ${"word ".repeat(60)}` }));
  assert.equal(playLength([{ who: "GM", text: "Hi." }]), 8);
  const entries = [{ key: "C1", label: "summary", text: "The night at the harbour." }, { key: "R1", label: "play", rows }];
  const full = renderEntries(entries, 1e9);
  assert.match(full, /^C1 \[summary\] The night at the harbour\.\nR1 \[play\] Alice: line 0 word/);
  const small = renderEntries(entries, 2000);
  assert.ok(small.length <= 2000 && small.startsWith("C1 [summary] The night at the harbour.") && small.includes("Alice: line 0"), "shortened, then thinned");
});

test("the replies follow the table's language", () => {
  assert.match(artText("Simplified Chinese", "notFound"), /^🎨 没能/);
  assert.match(artText("Traditional Chinese", "notFound"), /^🎨 沒能/);
  assert.match(artText("English", "limit", { n: 4 }), /4 pictures in the last hour/);
  assert.match(artText("French", "busy"), /still on its way/, "other languages read English");
});
