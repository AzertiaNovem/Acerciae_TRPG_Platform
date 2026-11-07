import { test } from "node:test";
import assert from "node:assert/strict";
import { artRequest, artText, bestPlace, drawable, isArtLine } from "../src/plotArt.mjs";

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

test("the best place: most different terms together, then most matches, then the newer; its middle match", () => {
  const hit = (windowId, seq, ...terms) => ({ windowId, seq, terms: new Set(terms) });
  const hits = [hit("w1", 10, "aurora"), hit("w1", 2000, "aurora"), hit("w1", 2010, "lighthouse"), hit("w1", 2030, "aurora"), hit("w2", 2015, "lighthouse")];
  assert.deepEqual(bestPlace(hits), { windowId: "w1", seq: 2010, score: 2003 });
  assert.equal(bestPlace([]), null);
  assert.equal(bestPlace([hit("w1", 5, "a"), hit("w1", 900, "a")]).seq, 900, "a tie goes to the newer place");
});

test("the replies follow the table's language", () => {
  assert.match(artText("Simplified Chinese", "notFound"), /^🎨 没能/);
  assert.match(artText("Traditional Chinese", "notFound"), /^🎨 沒能/);
  assert.match(artText("English", "limit", { n: 4 }), /4 pictures in the last hour/);
  assert.match(artText("French", "busy"), /still on its way/, "other languages read English");
});
