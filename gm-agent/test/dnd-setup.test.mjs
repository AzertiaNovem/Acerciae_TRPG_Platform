import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLlm } from "../src/llm/mock.mjs";
import { generateCoplayer, generateNpc, putCardWithPoints, saveCharacter } from "../src/roles/cardgen.mjs";
import { completeExistingCharacter } from "../src/roles/complete.mjs";
import { checkDnd } from "../src/roles/dndcard.mjs";
import { rulesProfile } from "../src/rules/index.mjs";
import { DND_RULES as rules } from "./fixtures/dndRules.mjs";

const profile = rulesProfile("dnd2024");
const opts = { rules, language: "English", era: "", pointsMode: true, profile, level: 1, takenNames: [], partyNotes: "", index: 0, total: 1 };

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

test("a new D&D co-player: the model's build is normalised, checked locally and saved at the configured level", async () => {
  const llm = new MockLlm();
  const out = await generateCoplayer(llm, { ...opts, level: 2 });
  assert.deepEqual(llm.calls.map((c) => c.purpose), ["coplayer_card"], "a legal build needs no repair");
  assert.match(llm.calls[0].system, /^You create adventurer characters for a fifth-edition fantasy campaign \(D&D 2024 rules, SRD 5\.2\)\./); assert.doesNotMatch(llm.calls[0].system, /Mythos|investigator/);
  assert.match(llm.calls[0].messages[0].content, /Build a level 2 character/); assert.match(llm.calls[0].messages[0].content, /^DND BUILD RULES/m);
  const d = out.role_card.dnd;
  assert.deepEqual([d.class, d.species, d.background, d.level, d.saves, d.hp_max, d.ac, d.hit_dice], ["Rogue", "Elf", "Criminal", 2, ["DEX", "INT"], 17, 14, "2d8"]);
  assert.deepEqual(checkDnd(d, rules).violations, []);
  assert.deepEqual(Object.keys(out.role_card).sort(), ["background", "basic", "dnd", "items", "wealth"], "no CoC characteristics or skills on a D&D card");
  assert.equal(out.role_card.basic.occupation, "Rogue");
});

test("a build that breaks the rules gets one repair round; still broken, it is refused under point buy and kept otherwise", async () => {
  const llm = new MockLlm();
  const base = llm.card.bind(llm);
  llm.card = (u, k) => { const c = base(u, k); c.role_card.dnd.base.STR = 15; c.role_card.dnd.skills.Athletics = 1; return c; };
  const logs = [];
  const out = await generateCoplayer(llm, { ...opts, log: (m) => logs.push(m) });
  assert.deepEqual(llm.calls.map((c) => c.purpose), ["coplayer_card", "coplayer_build"]);
  assert.deepEqual(checkDnd(out.role_card.dnd, rules).violations, []); assert.equal(out.role_card.dnd.base.STR, 8);
  assert.match(logs[0], /the build breaks the rules \(budget, skills\)/);
  const stubborn = new MockLlm();
  stubborn.card = (u, k) => { const c = base(u, k); c.role_card.dnd.base.STR = 15; return c; };
  stubborn.dndBuild = () => ({ ...new MockLlm().dndBuild(), base: { STR: 15, DEX: 15, CON: 14, INT: 12, WIS: 13, CHA: 10 } });
  await assert.rejects(generateCoplayer(stubborn, opts), /build still breaks the rules: The scores cost 36 points/);
  const kept = await generateCoplayer(stubborn, { ...opts, pointsMode: false, log: (m) => logs.push(m) });
  assert.equal(kept.role_card.dnd.base.STR, 15); assert.match(logs.at(-1), /saved with a build outside the rules \(budget\); point buy is off/);
});

test("saving: create, card, appearance; a 400 points_rule from the platform is repaired up to twice", async () => {
  const api = new MemoryApi({}, { refuse: 1 });
  const llm = new MockLlm();
  const generated = await generateCoplayer(llm, opts);
  const saved = await saveCharacter(api, "ch", generated, { kind: "coplayer", rules, llm, language: "English", pointsMode: true, profile, level: 1 });
  assert.deepEqual(api.writes.map((w) => w.kind), ["card", "card", "appearance"]);
  assert.equal(api.created[0].kind, "pc"); assert.equal(saved.card.dnd.class, "Rogue");
  assert.equal(llm.calls.filter((c) => c.purpose === "coplayer_build").length, 1, "the platform's refusal asked for one repair");
  assert.ok(!("attrs" in api.writes[0].body) && !("sheet" in api.writes[0].body), "live values are never sent with the card");
  const api3 = new MemoryApi({ id: "x", role_card: generated.role_card }, { refuse: 3 });
  await assert.rejects(putCardWithPoints(api3, "ch", "x", generated.role_card, { llm, rules, language: "English", pointsMode: true, profile, level: 1 }), /points_rule|budget/);
  assert.equal(api3.writes.length, 3);
});

test("completing an existing D&D PC fills the missing build and text, keeps its level, HP, AC and improvements, and sends no attrs", async () => {
  const existing = { id: "pc1", name: "Mira", bio: "A quiet archer.", appearance_prompt: "", role_card: { basic: { player: "Pat", occupation: "", age: "30", sex: "female", residence: "Westmarch", birthplace: "Westmarch" }, background: { personal_description: "tall", ideology: "", significant_people: "a brother", meaningful_locations: "the woods", treasured_possessions: "a bow", traits: "patient", injuries: "None", phobias: "None", arcane: "None", encounters: "None" }, dnd: { level: 4, class: "Ranger", species: "Human", background: "Soldier", base: { STR: 8, DEX: 15, CON: 14, INT: 10, WIS: 15, CHA: 8 }, increases: { DEX: 2, STR: 1 }, improvements: { WIS: 2 }, saves: ["STR", "DEX"], skills: { Athletics: 1, Intimidation: 1, Perception: 1, Stealth: 1, Survival: 1, Insight: 1 }, ac: 15, hp_max: 36 } } };
  const api = new MemoryApi(existing);
  const llm = new MockLlm();
  llm.complete = async ({ purpose, messages }) => { llm.calls.push({ purpose, messages: messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("") })) }); return JSON.stringify({ appearance_prompt: "Tall archer, green cloak, braided hair.", role_card: { basic: { occupation: "Ranger" }, background: { ideology: "the wild must be kept" } } }); };
  const changed = await completeExistingCharacter(api, llm, "ch", "pc1", { rules, language: "English", era: "", pointsMode: true, profile, level: 1 });
  assert.equal(changed, true);
  assert.equal(llm.calls[0].purpose, "coplayer_repair"); assert.match(llm.calls[0].messages[0].content, /MISSING: \["appearance_prompt","role_card.basic.occupation","role_card.background.ideology"\]/);
  const card = api.writes.find((w) => w.kind === "card").body.role_card;
  assert.deepEqual([card.dnd.level, card.dnd.hp_max, card.dnd.ac, card.dnd.improvements, card.dnd.saves, card.dnd.hit_dice, card.dnd.slots, card.dnd.spellcasting_ability], [4, 36, 15, { WIS: 2 }, ["STR", "DEX"], "4d10", { 1: 3 }, "WIS"], "kept, and the rest derived");
  assert.equal(card.background.ideology, "the wild must be kept"); assert.equal(card.basic.occupation, "Ranger");
  assert.ok(!("attrs" in api.writes[0].body)); assert.equal(api.writes.at(-1).kind, "appearance");
  assert.equal(await completeExistingCharacter(api, new MockLlm(), "ch", "pc1", { rules, language: "English", era: "", pointsMode: true, profile, level: 1 }), false, "complete now");
  const noBuild = new MemoryApi({ ...existing, appearance_prompt: "x", role_card: { ...existing.role_card, basic: { ...existing.role_card.basic, occupation: "Ranger" }, background: { ...existing.role_card.background, ideology: "y" }, dnd: undefined } });
  const llm2 = new MockLlm();
  llm2.complete = async ({ purpose, messages }) => { llm2.calls.push({ purpose, messages: messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("") })) }); return JSON.stringify({ role_card: { dnd: { class: "Fighter", species: "Dwarf", background: "Soldier", base: { STR: 15, DEX: 12, CON: 14, INT: 8, WIS: 13, CHA: 10 }, increases: { STR: 2, CON: 1 }, skills: { Athletics: 1, Intimidation: 1, Perception: 1, Survival: 1 } } } }); };
  assert.equal(await completeExistingCharacter(noBuild, llm2, "ch", "pc1", { rules, language: "English", era: "", pointsMode: true, profile, level: 2 }), true);
  assert.match(llm2.calls[0].messages[0].content, /MISSING: \["role_card.dnd.class","role_card.dnd.species","role_card.dnd.background","role_card.dnd.base"\]/); assert.match(llm2.calls[0].messages[0].content, /^DND BUILD RULES/m);
  const d = noBuild.writes[0].body.role_card.dnd;
  assert.deepEqual([d.class, d.level, d.saves, d.hp_max, d.ac], ["Fighter", 2, ["STR", "CON"], 10 + 2 + 6 + 2, 11], "a level-2 Fighter, from the configured level");
});

test("an NPC in a D&D channel gets a build too: legal under point buy, any scores otherwise", async () => {
  const llm = new MockLlm();
  const npc = await generateNpc(llm, { language: "English", era: "", rules, name: "Grog", brief: "an orc bouncer", gmContext: "", profile, pointsMode: false });
  assert.match(llm.calls[0].system, /^You are the Dungeon Master's assistant in a fifth-edition fantasy campaign/); assert.match(llm.calls[0].messages[0].content, /DM'S BRIEF: an orc bouncer/);
  assert.equal(npc.role_card.dnd.class, "Rogue"); assert.equal(npc.role_card.basic.player, "NPC");
  const api = new MemoryApi({});
  const saved = await saveCharacter(api, "ch", npc, { kind: "npc", rules, llm, language: "English", pointsMode: false, profile, level: 1 });
  assert.equal(api.created[0].kind, "npc"); assert.equal(saved.card.dnd.hp_max, 10);
});
