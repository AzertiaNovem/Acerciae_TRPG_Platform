import { test } from "node:test";
import assert from "node:assert/strict";
import { recall, clipTokens } from "../src/context/recall.mjs";
import { estimateTokens } from "../src/memory.mjs";
import { GmContext } from "../src/context/gmContext.mjs";
import { coplayerTurn } from "../src/coplayer.mjs";
import { MockLlm } from "../src/llm/mock.mjs";
import { historyParts } from "../src/llm/parts.mjs";

const candidate = (match) => ({ match, text: `[Old source] ${match}` });

test("local recall finds Chinese clues and English names, without filling with unrelated records", () => {
  const records = [candidate("码头的铜钥匙藏在灯塔三楼。"), candidate("Harriet entrusted the emerald to Byrne."), candidate("The garden is empty.")];
  assert.match(recall("铜钥匙在哪？", records, 400), /灯塔三楼/);
  assert.match(recall("Where did Harriet put the emerald?", records, 400), /Byrne/);
  assert.equal(recall("unrelated telescope", records, 400), "");
  assert.equal(recall("the and 我们 那个", records, 400), "");
  assert.equal(recall("铜钥匙", records, 0), "");
  assert.equal((recall("铜钥匙", [records[0], records[0]], 400).match(/灯塔三楼/g) ?? []).length, 1);
});

test("recall reaches a match late in a large record and strictly bounds CJK/emoji excerpts", () => {
  const text = `${"无关的旧记录。".repeat(500)}铜钥匙在灯塔三楼。${"无关的旧记录。".repeat(20)}`;
  const result = recall("铜钥匙灯塔", [candidate(text)], 450);
  assert.match(result, /铜钥匙在灯塔三楼/);
  assert.match(result, /Old source/);
  assert.ok(estimateTokens(result) <= 450);
  for (const budget of [0, 1, 7, 25, 100]) {
    const clipped = clipTokens("中文😀𠮷混合English".repeat(100), budget);
    assert.ok(clipped.isWellFormed());
    assert.ok(estimateTokens(clipped) <= budget);
  }
});

test("history chunk boundaries survive growth from 50 to 100 lines", () => {
  const rows = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const before = historyParts(rows.slice(0, 50), String, "History");
  const after = historyParts(rows, String, "History");
  assert.equal(before[0].text, after[0].text);
  assert.equal(before[0].cache, true);
  assert.equal(after[0].cache, undefined);
  assert.equal(after[1].cache, true);
});

test("co-player HP, sanity and inventory changes preserve the cached identity and history", async () => {
  const llm = new MockLlm();
  const opts = { language: "English", coplayer: { name: "Harriet" }, card: { derived: { hp: 10, san: 60 }, items: [{ name: "key" }] }, log: [] };
  await coplayerTurn(llm, opts);
  opts.card.derived.hp = 5; opts.card.derived.san = 50; opts.card.items = [{ name: "torch" }];
  await coplayerTurn(llm, opts);
  assert.equal(llm.calls[0].parts[0][0].text, llm.calls[1].parts[0][0].text);
  assert.match(llm.calls[1].parts[0].at(-1).text, /HP 5\/\?, SAN 50/);
  assert.match(llm.calls[1].parts[0].at(-1).text, /carrying: torch/);
  assert.doesNotMatch(llm.calls[1].parts[0][0].text, /HP|carrying:/);
});

test("document cache keeps the full version for recall, retries errors, invalidates updates and prunes deletions", async () => {
  let version = 1, reads = 0, fail = true, listed = true;
  const api = {
    documents: async () => listed ? [{ id: "d", version, entry_count: 61, title: "Clues", preview: "preview" }] : [],
    document: async () => {
      reads++;
      if (fail) throw new Error("temporary failure");
      return { entries: [
        { content_md: "铜钥匙在灯塔三楼", updated_version: 1 },
        ...Array.from({ length: 60 }, (_, i) => ({ content_md: `NEW-${i} ${"关于无关花园的详细记录".repeat(10)}`, updated_version: i + 2 })),
        { content_md: "DELETED 铜钥匙已销毁", updated_version: 99, removed: true },
      ] };
    },
  };
  const gm = new GmContext(api, "ch", { budget: 16000 });
  assert.match((await gm.documents())[0], /preview/);
  fail = false;
  const omitted = [];
  const recent = await gm.documents(omitted);
  assert.equal(reads, 2, "a failed full fetch must be retried at the same version");
  assert.match(recent[0], /NEW-59/);
  assert.doesNotMatch(recent[0], /铜钥匙在灯塔/);
  assert.match(recall("铜钥匙", omitted, 300), /灯塔三楼/);
  assert.doesNotMatch(recall("铜钥匙", omitted, 300), /DELETED/);
  await gm.documents(); assert.equal(reads, 2);
  version++;
  await gm.documents(); assert.equal(reads, 3);
  gm.onContextEvent({ type: "document.updated", document_id: "d" });
  await gm.documents(); assert.equal(reads, 4);
  gm.onContextEvent({ type: "knowledge.reset" }); assert.equal(gm.docCache.size, 0);
  await gm.documents(); assert.equal(reads, 5);
  listed = false;
  assert.deepEqual(await gm.documents(), []); assert.equal(gm.docCache.size, 0);
});
