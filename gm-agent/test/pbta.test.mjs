import { test } from "node:test";
import assert from "node:assert/strict";
import { PACK_FIELDS, fitSheet, onlyPackFields, playbookTarget, prepareActor, preparePack } from "../src/pbta.mjs";
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

const SHEET_PACK = {
  books: [{ id: "smuggler", name: "Smuggler" }, { id: "scribe", name: "抄录师" }, { id: "warden", name: "Warden" }],
  stats: [{ id: "nerve", name: "Nerve" }, { id: "rapport", name: "交涉" }],
  resources: [{ id: "supply", name: "Supply" }],
  conditions: [{ id: "shaken", name: "Shaken" }, { id: "hurt", name: "受伤" }],
  moves: [],
};

test("a PbtA sheet is fitted to the pack: names become IDs, numbers and yes/no words count, unknown entries go", () => {
  assert.deepEqual(fitSheet({ book: "抄录师", stats: { Nerve: "+1", rapport: 2.4, charm: 3 }, resources: { supply: "2", xp: 0 }, conditions: ["受伤"] }, SHEET_PACK),
    { book: "scribe", stats: { nerve: 1, rapport: 2 }, resources: { supply: 2 }, conditions: { hurt: true } });
  assert.deepEqual(fitSheet({ book: "warden", stats: [{ id: "nerve", value: -1 }], resources: [], conditions: { shaken: "no", hurt: "yes", tired: true } }, SHEET_PACK).conditions, { shaken: false, hurt: true });
  assert.deepEqual(fitSheet({ book: "warden", stats: { nerve: "lots" }, conditions: { shaken: "maybe" } }, SHEET_PACK), { book: "warden", stats: {}, resources: {}, conditions: {} }, "values that are not numbers or yes/no are left out");
  assert.equal(fitSheet({ book: "pirate" }, SHEET_PACK).book, "pirate", "an unknown playbook stays (the check refuses it)");
});

function cardApi() {
  const made = [];
  return {
    made,
    createCharacter: async (_ch, body) => { const c = { id: `c${made.length + 1}`, ...body }; made.push(c); return c; },
    characterSpace: async (_ch, id) => ({ character: made.find((c) => c.id === id) }),
    putCard: async (_ch, id, body) => { const c = made.find((x) => x.id === id); c.role_card = body.role_card; return { character: c }; },
    putAppearance: async () => ({}),
  };
}

test("a co-player card: a near-miss sheet is used at once, and only a playbook nobody holds is offered", async () => {
  const api = cardApi();
  const calls = [];
  const llm = { complete: async (r) => { calls.push(JSON.parse(r.messages[0].content)); return JSON.stringify({ name: "闻砚舟", persona: "p", speaking_style: "s", role_card: { pbta: { book: "Warden", stats: { nerve: "+1" }, resources: { supply: "2" }, conditions: ["Shaken"] } } }); } };
  const actor = await prepareActor(api, llm, "ch", { rules: { pack: SHEET_PACK, revision: 1 }, language: "Chinese", takenBooks: ["smuggler", "scribe"] });
  assert.equal(calls.length, 1, "no second call");
  assert.deepEqual(calls[0].books.map((b) => b.id), ["warden"], "only the free playbook is offered");
  assert.deepEqual(actor.role_card.pbta, { book: "warden", stats: { nerve: 1 }, resources: { supply: 2 }, conditions: { shaken: true } });
});

test("a co-player that picks a taken playbook is asked again with the free ones; with none free, all are offered", async () => {
  const api = cardApi();
  const replies = ["smuggler", "warden"];
  const asks = [];
  const llm = { complete: async (r) => { asks.push(r.messages.at(-1).content); return JSON.stringify({ name: "陆听榆", role_card: { pbta: { book: replies.shift(), stats: {}, resources: {}, conditions: {} } } }); } };
  const actor = await prepareActor(api, llm, "ch", { rules: { pack: SHEET_PACK, revision: 1 }, language: "Chinese", takenBooks: ["smuggler", "scribe"] });
  assert.equal(actor.role_card.pbta.book, "warden");
  assert.match(asks[1], /one of these playbook IDs: warden/);
  const seen = [];
  const all = { complete: async (r) => { seen.push(JSON.parse(r.messages[0].content).books.length); return JSON.stringify({ name: "岑听桥", role_card: { pbta: { book: "scribe", stats: {}, resources: {}, conditions: {} } } }); } };
  await prepareActor(cardApi(), all, "ch", { rules: { pack: SHEET_PACK, revision: 1 }, language: "Chinese", takenBooks: ["smuggler", "scribe", "warden"] });
  assert.deepEqual(seen, [3]);
});

test("the PbtA design asks for spare playbooks for the human players, and refuses a pack with none to spare", async () => {
  assert.equal(playbookTarget({ coplayers: 5, players: 0 }), 7);
  assert.equal(playbookTarget({ coplayers: 5, players: 3 }), 9);
  assert.equal(playbookTarget({ coplayers: 0, players: 0 }), 3);
  const systems = [];
  const asks = [];
  const books = [PACK.books, [...PACK.books, { id: "b2", name: "B2" }, { id: "b3", name: "B3" }]];
  const llm = { complete: async (r) => { systems.push(r.system); asks.push(r.messages.at(-1).content); return JSON.stringify({ pack: { ...PACK, books: books.shift() }, reasons: ["One.", "Two."] }); } };
  const api = { pbtaDraft: async () => ({ status: "none", version: 1, eligible: true }), previewPbta: async () => ({}), reviewPbta: async (_c, b) => ({ status: b.op, version: 2, pack: b.pack }) };
  const r = await preparePack(api, llm, "ch", { pack: PACK }, "World.", "English", undefined, () => {}, { coplayers: 2, players: 1 });
  assert.match(systems[0], /Design at least 4 playbooks: the table has 2 AI co-player\(s\) and 1 human player\(s\) so far, every character takes a different playbook/);
  assert.match(asks[1], /Design at least 4 playbooks: one for each character, and spares for the human players/, "one playbook for two co-players is refused");
  assert.equal(r.status, "submit"); assert.equal(r.pack.books.length, 3, "more playbooks than co-players");
});
