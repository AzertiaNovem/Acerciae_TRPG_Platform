import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLlm } from "../src/llm/mock.mjs";
import { generateNpc, putCardWithPoints, saveCharacter } from "../src/roles/cardgen.mjs";
import { checkDnd } from "../src/roles/dndcard.mjs";
import { rulesProfile } from "../src/rules/index.mjs";
import { DND_RULES as rules } from "./fixtures/dndRules.mjs";

const profile = rulesProfile("dnd2024");
const opts = { rules, language: "English", era: "", pointsMode: true, profile, name: "Mira", brief: "a quiet archer", gmContext: "" };

class MemoryApi {
  constructor(c, { refuse = 0 } = {}) { this.character = structuredClone(c); this.writes = []; this.refuse = refuse; this.created = []; }
  async characterSpace() { return { character: structuredClone(this.character), attrs: { HP: 7, "Slot 1": 1, "Death Failures": 1 }, rule_system: "dnd2024", points: { enabled: true, violations: checkDnd(this.character.role_card?.dnd ?? {}, rules).violations } }; }
  async createCharacter(_ch, body) { this.created.push(body); this.character = { id: "new", ...body, role_card: {} }; return { id: "new", ...body }; }
  async putCard(_channel, id, body) {
    this.writes.push({ kind: "card", body: structuredClone(body) });
    if (this.refuse > 0) { this.refuse--; throw Object.assign(new Error("The scores cost 30 points; the budget is 27."), { code: "points_rule", status: 400 }); }
    Object.assign(this.character, structuredClone(body));
    return this.characterSpace();
  }
  async putAppearance(_channel, id, body) { this.writes.push({ kind: "appearance", body: structuredClone(body) }); Object.assign(this.character, body); return this.characterSpace(); }
}

test("a new D&D NPC under point buy: the model's build is normalised and checked locally, at level 1", async () => {
  const llm = new MockLlm();
  const out = await generateNpc(llm, opts);
  assert.deepEqual(llm.calls.map((c) => c.purpose), ["npc_card"], "a legal build needs no repair");
  assert.match(llm.calls[0].system, /^You are the GM's assistant in a fifth-edition fantasy campaign \(D&D 2024 rules, SRD 5\.2\)\./); assert.doesNotMatch(llm.calls[0].system, /Mythos|investigator/);
  assert.match(llm.calls[0].messages[0].content, /Build a level 1 character/); assert.match(llm.calls[0].messages[0].content, /^DND BUILD RULES/m);
  const d = out.role_card.dnd;
  assert.deepEqual([d.class, d.species, d.background, d.level, d.saves, d.hp_max, d.ac, d.hit_dice], ["Rogue", "Elf", "Criminal", 1, ["DEX", "INT"], 10, 14, "1d8"]);
  assert.deepEqual(checkDnd(d, rules).violations, []);
  assert.deepEqual(Object.keys(out.role_card).sort(), ["background", "basic", "dnd", "items", "wealth"], "no CoC characteristics or skills on a D&D card");
  assert.equal(out.role_card.basic.occupation, "Rogue");
});

test("a build that breaks the rules gets one repair round; still broken, it is refused under point buy and kept otherwise", async () => {
  const llm = new MockLlm();
  const base = llm.card.bind(llm);
  llm.card = (u, k) => { const c = base(u, k); c.role_card.dnd.base.STR = 15; c.role_card.dnd.skills.Athletics = 1; return c; };
  const logs = [];
  const out = await generateNpc(llm, { ...opts, log: (m) => logs.push(m) });
  assert.deepEqual(llm.calls.map((c) => c.purpose), ["npc_card", "coplayer_build"]);
  assert.deepEqual(checkDnd(out.role_card.dnd, rules).violations, []); assert.equal(out.role_card.dnd.base.STR, 8);
  assert.match(logs[0], /the build breaks the rules \(budget, skills\)/);
  const stubborn = new MockLlm();
  stubborn.card = (u, k) => { const c = base(u, k); c.role_card.dnd.base.STR = 15; return c; };
  stubborn.dndBuild = () => ({ ...new MockLlm().dndBuild(), base: { STR: 15, DEX: 15, CON: 14, INT: 12, WIS: 13, CHA: 10 } });
  await assert.rejects(generateNpc(stubborn, opts), /build still breaks the rules: The scores cost 36 points/);
  const kept = await generateNpc(stubborn, { ...opts, pointsMode: false, log: (m) => logs.push(m) });
  assert.equal(kept.role_card.dnd.base.STR, 15); assert.match(logs.at(-1), /saved with a build outside the rules \(budget\); point buy is off/);
});

test("saving: create, card, appearance; a 400 points_rule from the platform is repaired up to twice", async () => {
  const api = new MemoryApi({}, { refuse: 1 });
  const llm = new MockLlm();
  const generated = await generateNpc(llm, opts);
  const saved = await saveCharacter(api, "ch", generated, { kind: "npc", rules, llm, language: "English", pointsMode: true, profile, level: 1 });
  assert.deepEqual(api.writes.map((w) => w.kind), ["card", "card", "appearance"]);
  assert.equal(api.created[0].kind, "npc"); assert.equal(saved.card.dnd.class, "Rogue");
  assert.equal(llm.calls.filter((c) => c.purpose === "coplayer_build").length, 1, "the platform's refusal asked for one repair");
  assert.ok(!("attrs" in api.writes[0].body) && !("sheet" in api.writes[0].body), "live values are never sent with the card");
  const api3 = new MemoryApi({ id: "x", role_card: generated.role_card }, { refuse: 3 });
  await assert.rejects(putCardWithPoints(api3, "ch", "x", generated.role_card, { llm, rules, language: "English", pointsMode: true, profile, level: 1 }), /points_rule|budget/);
  assert.equal(api3.writes.length, 3);
});

test("an NPC in a D&D channel gets a build too: legal under point buy, any scores otherwise", async () => {
  const llm = new MockLlm();
  const npc = await generateNpc(llm, { language: "English", era: "", rules, name: "Grog", brief: "an orc bouncer", gmContext: "", profile, pointsMode: false });
  assert.match(llm.calls[0].system, /^You are the GM's assistant in a fifth-edition fantasy campaign/); assert.match(llm.calls[0].messages[0].content, /GM'S BRIEF: an orc bouncer/);
  assert.equal(npc.role_card.dnd.class, "Rogue"); assert.equal(npc.role_card.basic.player, "NPC");
  const api = new MemoryApi({});
  const saved = await saveCharacter(api, "ch", npc, { kind: "npc", rules, llm, language: "English", pointsMode: false, profile, level: 1 });
  assert.equal(api.created[0].kind, "npc"); assert.equal(saved.card.dnd.hp_max, 10);
});
