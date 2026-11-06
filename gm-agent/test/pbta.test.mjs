import { test } from "node:test";
import assert from "node:assert/strict";
import { PACK_FIELDS, onlyPackFields, preparePack } from "../src/pbta.mjs";
import { completeJson } from "../src/llm/index.mjs";
import { withProgress } from "../src/llm/progress.mjs";

const PACK = {
  schemaVersion: 1, name: "Harbour Nights",
  stats: [{ id: "nerve", name: "Nerve" }], bands: [{ id: "miss", name: "Miss", min: null, max: 6 }, { id: "hit", name: "Hit", min: 7, max: null }],
  books: [{ id: "smuggler", name: "Smuggler" }], resources: [], conditions: [], gmMoves: [],
  moves: [
    { id: "run", name: "Run the blockade", trigger: "When you run the blockade", stat: "nerve", book: "", outcomes: {}, playerChoiceBands: ["hit"] },
    { id: "deal", name: "Strike a deal", trigger: "When you strike a deal", stat: "", book: "smuggler", outcomes: {}, playerChoiceBands: ["no_roll"] },
  ],
};

test("a pack keeps only the fields the platform takes", () => {
  assert.deepEqual(PACK_FIELDS, ["schemaVersion", "name", "stats", "bands", "books", "moves", "gmMoves", "resources", "conditions"]);
  const { pack, extra } = onlyPackFields({ ...PACK, designQuestions: ["What do people risk?"], notes: "x" });
  assert.deepEqual(extra, ["designQuestions", "notes"]);
  assert.deepEqual(pack, PACK);
  assert.deepEqual(onlyPackFields(PACK).extra, []);
});

test("the PbtA design: a field the platform does not take is left out before the preview, without a second call", async () => {
  const calls = { preview: [], review: [] };
  const api = {
    pbtaDraft: async () => ({ status: "none", version: 3, eligible: true }),
    previewPbta: async (_ch, pack) => {
      calls.preview.push(pack);
      for (const k of Object.keys(pack)) if (!PACK_FIELDS.includes(k)) throw Object.assign(Error(`400 bad_request Unknown pack field: ${k}`), { status: 400 });
      return { ok: true };
    },
    reviewPbta: async (_ch, body) => { calls.review.push(body); return { status: body.op === "submit" ? "pending" : "designing", version: 4 }; },
  };
  let llmCalls = 0;
  const llm = { complete: async () => { llmCalls++; return JSON.stringify({ pack: { ...PACK, designQuestions: ["What do people risk?"] }, reasons: ["Smuggling drives play.", "Deals are diceless."] }); } };
  const logs = [];
  const result = await preparePack(api, llm, "ch", { pack: PACK }, "A harbour town.", "English", undefined, (m) => logs.push(m));
  assert.equal(llmCalls, 1, "no retry");
  assert.deepEqual(Object.keys(calls.preview[0]).sort(), [...PACK_FIELDS].sort());
  assert.deepEqual(calls.review.map((r) => r.op), ["start", "submit"]);
  assert.equal("designQuestions" in calls.review[1].pack, false, "the submitted pack is the one previewed");
  assert.equal(result.status, "pending");
  assert.deepEqual(logs, ["PbtA design: left out field(s) the platform does not take: designQuestions"]);
});

test("the PbtA design prompt names the pack's fields and keeps design notes in the reasons", async () => {
  let system = "";
  const api = { pbtaDraft: async () => ({ status: "none", version: 1, eligible: true }), previewPbta: async () => ({}), reviewPbta: async (_c, b) => ({ status: b.op, version: 2 }) };
  const llm = { complete: async (r) => { system = r.system; return JSON.stringify({ pack: PACK, reasons: ["One.", "Two."] }); } };
  await preparePack(api, llm, "ch", { pack: PACK }, "World.", "English");
  assert.match(system, /exactly its top-level fields \(schemaVersion, name, stats, bands, books, moves, gmMoves, resources, conditions\) and no others: design notes belong in reasons/);
});

test("a reply that could not be used: the log says why before asking again", async () => {
  const logs = [];
  let n = 0;
  const llm = withProgress({ complete: async () => (++n === 1 ? "not json at all" : '{"ok":true}') }, (m) => logs.push(m));
  const value = await completeJson(llm, { system: "s", user: "u", purpose: "pbta_design" }, (x) => { if (!x?.ok) throw Error("Specify playerChoiceBands for every move"); return x; });
  assert.deepEqual(value, { ok: true });
  assert.equal(logs[0], "LLM pbta_design: generating…");
  assert.match(logs.find((l) => /could not be used/.test(l)) ?? "", /^LLM pbta_design: the reply could not be used \(.+\); asking again…$/);
});
