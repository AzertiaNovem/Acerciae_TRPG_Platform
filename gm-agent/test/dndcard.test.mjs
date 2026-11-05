import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateDndBuild, cardSummaryDnd, castNoteDnd, checkDnd, classSlots, deriveDnd, findNamed, mod, normalizeDnd, proficiencyBonus, rulesSummaryDnd, scores, skillIndex } from "../src/roles/dndcard.mjs";
import { rulesProfile } from "../src/rules/index.mjs";
import { DND_RULES as rules } from "./fixtures/dndRules.mjs";
import { MockLlm } from "../src/llm/mock.mjs";

const ROGUE = { class: "Rogue", species: "Elf", background: "Criminal", method: "point_buy", base: { STR: 8, DEX: 15, CON: 14, INT: 12, WIS: 13, CHA: 10 }, increases: { DEX: 2, CON: 1 }, skills: { "Sleight of Hand": 2, Stealth: 2, Acrobatics: 1, Deception: 1, Insight: 1, Perception: 1, Survival: 1 } };

test("modifiers, proficiency, names: the SRD maths and the platform's name matching", () => {
  assert.deepEqual([mod(8), mod(10), mod(11), mod(17), mod(20)], [-1, 0, 0, 3, 5]);
  assert.deepEqual([1, 4, 5, 8, 9, 17].map(proficiencyBonus), [2, 2, 3, 3, 4, 6]);
  assert.equal(findNamed(rules.classes, "rogue").name, "Rogue"); assert.equal(findNamed(rules.species, "精灵").name, "Elf"); assert.equal(findNamed(rules.backgrounds, "Pirate"), null);
  const skill = skillIndex(rules);
  assert.equal(skill("stealth"), "Stealth"); assert.equal(skill("隐匿"), "Stealth"); assert.equal(skill("sleight of hand"), "Sleight of Hand"); assert.equal(skill("Lockpicking"), null);
  assert.deepEqual(classSlots(rules, "Wizard", 3), { 1: 4, 2: 2 }); assert.deepEqual(classSlots(rules, "Warlock", 3), { 2: 2 }); assert.deepEqual(classSlots(rules, "Paladin", 1), { 1: 2 }, "a 2024 Paladin casts from level 1"); assert.deepEqual(classSlots(rules, "Rogue", 5), {});
});

test("normalise + derive: saves from the class, HP from the hit die and CON, AC from DEX, speed, hit dice, slots and the casting ability", () => {
  const d = normalizeDnd(ROGUE, { rules, level: 1 });
  assert.deepEqual(scores(d), { STR: 8, DEX: 17, CON: 15, INT: 12, WIS: 13, CHA: 10 });
  assert.deepEqual([d.level, d.saves, d.hp_max, d.ac, d.speed, d.hit_dice, d.spellcasting_ability, d.slots, d.initiative], [1, ["DEX", "INT"], 10, 13, 30, "1d8", "", {}, 0]);
  const l3 = normalizeDnd({ ...ROGUE, ac: 14 }, { rules, level: 3 });
  assert.deepEqual([l3.hp_max, l3.ac, l3.hit_dice], [24, 14, "3d8"], "d8 + 2, then (5 + 2) a level; armour AC kept");
  const wiz = normalizeDnd({ class: "wizard", species: "Human", background: "Sage", base: { STR: 8, DEX: 14, CON: 13, INT: 15, WIS: 12, CHA: 10 }, increases: { INT: 2, CON: 1 }, skills: { Arcana: 1, History: 1, Investigation: 1, Insight: 1, Perception: 1 }, spells: "Fire Bolt, Magic Missile" }, { rules, level: 3 });
  assert.deepEqual([wiz.class, wiz.saves, wiz.spellcasting_ability, wiz.slots, wiz.hp_max], ["Wizard", ["INT", "WIS"], "INT", { 1: 4, 2: 2 }, 6 + 2 + 2 * (4 + 2)]);
  const lock = normalizeDnd({ class: "Warlock", species: "Tiefling", background: "Acolyte", base: { STR: 8, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 15 }, increases: { CHA: 2, WIS: 1 } }, { rules, level: 3 });
  assert.deepEqual([lock.spellcasting_ability, lock.slots], ["CHA", { 2: 2 }]);
  const kept = deriveDnd({ class: "Fighter", level: 4, base: { STR: 16, DEX: 12, CON: 14, INT: 8, WIS: 10, CHA: 10 }, increases: {}, improvements: { STR: 2 }, saves: [], ac: 18, hp_max: 40, speed: 25, slots: {} }, rules);
  assert.deepEqual([kept.saves, kept.ac, kept.hp_max, kept.speed, kept.hit_dice], [["STR", "CON"], 18, 40, 25, "4d10"], "existing values stand, missing ones are filled");
  const npc = normalizeDnd({ class: "Fighter", species: "Orc", background: "Soldier", method: "manual", base: { STR: 18, DEX: 12, CON: 16, INT: 8, WIS: 10, CHA: 9 } }, { rules, kind: "npc", pointsMode: false });
  assert.deepEqual([npc.method, npc.base.STR], ["manual", 18], "an NPC with point buy off keeps its scores");
  assert.deepEqual([normalizeDnd(npc, { rules, kind: "npc", pointsMode: true }).method, normalizeDnd(npc, { rules, kind: "npc", pointsMode: true }).base.STR], ["point_buy", 15], "under point buy it is clamped like anyone");
});

test("checkDnd mirrors the platform's point-buy rules, code for code", () => {
  const codes = (d) => checkDnd(normalizeDnd(d, { rules, level: 1 }), rules).violations.map((v) => v.code);
  const r = checkDnd(normalizeDnd(ROGUE, { rules }), rules);
  assert.deepEqual(r, { spent: 27, violations: [] });
  assert.deepEqual(codes({ ...ROGUE, base: { ...ROGUE.base, STR: 15 } }), ["budget"]);
  assert.deepEqual(checkDnd({ ...normalizeDnd(ROGUE, { rules }), base: { ...ROGUE.base, STR: 16 } }, rules).violations.map((v) => v.code), ["score_range"]);
  assert.deepEqual(checkDnd({ ...normalizeDnd(ROGUE, { rules }), saves: ["STR", "CON"] }, rules).violations.map((v) => v.code), ["saves"]);
  assert.deepEqual(codes({ ...ROGUE, skills: { ...ROGUE.skills, Athletics: 1 } }), ["skills"]);
  assert.match(checkDnd(normalizeDnd({ ...ROGUE, skills: { ...ROGUE.skills, Athletics: 1, Religion: 1 } }, { rules }), rules).violations[0].message, /Athletics, Religion/);
  assert.deepEqual(codes({ ...ROGUE, increases: { DEX: 2, CON: 2 } }), ["increases"]);
  assert.deepEqual(codes({ ...ROGUE, increases: { DEX: 2, CHA: 1 } }), ["increase_ability"]);
  assert.deepEqual(codes({ ...ROGUE, method: "standard_array", base: { STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 10 } }), ["standard_array"]);
  assert.deepEqual(codes({ ...ROGUE, method: "standard_array", base: { STR: 8, DEX: 15, CON: 14, INT: 13, WIS: 12, CHA: 10 } }), []);
  assert.deepEqual(checkDnd({ ...normalizeDnd(ROGUE, { rules }), method: "manual" }, rules).violations.map((v) => v.code), ["method"]);
  assert.deepEqual(codes({ ...ROGUE, class: "Jester" }), ["class", "saves"].slice(0, 1).concat(checkDnd(normalizeDnd({ ...ROGUE, class: "Jester" }, { rules }), rules).violations.slice(1).map((v) => v.code)));
  assert.deepEqual(codes({ ...ROGUE, species: "Kenku", skills: { "Sleight of Hand": 2, Stealth: 2, Acrobatics: 1, Deception: 1, Insight: 1, Perception: 1 } }), ["species"]);
  assert.deepEqual(codes({ ...ROGUE, species: "Human", skills: { ...ROGUE.skills, Survival: 0, Athletics: 1 } }), [], "a Human's extra skill may be any");
  assert.deepEqual(codes({ ...ROGUE, species: "Dwarf", skills: ROGUE.skills }), ["skills"], "no species skill: Survival is one too many");
});

test("the rules summary, the repair round and the co-player's sheet", async () => {
  const summary = rulesSummaryDnd(rules, true, 2);
  assert.match(summary, /^DND BUILD RULES/m); assert.match(summary, /LEVEL: 2\./); assert.match(summary, /Rogue \(d8; saves DEX\/INT; 4 skills from Acrobatics/); assert.match(summary, /Bard \(d8; saves DEX\/CHA; 3 skills from any; full caster\)/);
  assert.match(summary, /Elf \(speed 30; \+1 skill from Insight, Perception, Survival\)/); assert.match(summary, /Criminal \(abilities DEX\/CON\/INT; skills Sleight of Hand, Stealth\)/); assert.match(summary, /8:0 9:1 10:2 11:3 12:4 13:5 14:7 15:9/); assert.match(summary, /POINT-BUY IS ON/);
  const llm = new MockLlm();
  const broken = { basic: { occupation: "Rogue" }, dnd: normalizeDnd({ ...ROGUE, base: { ...ROGUE.base, STR: 15 }, skills: { ...ROGUE.skills, Athletics: 1 } }, { rules, level: 3 }) };
  const fixed = await allocateDndBuild(llm, broken, { rules, language: "English", level: 3 });
  assert.equal(llm.calls[0].purpose, "coplayer_build"); assert.match(llm.calls[0].messages[0].content, /VIOLATIONS: \[.*"budget".*"skills"/);
  assert.deepEqual(checkDnd(fixed.dnd, rules).violations, []); assert.equal(fixed.dnd.level, 3); assert.equal(fixed.dnd.hp_max, 24, "recomputed for the repaired scores");
  const card = { basic: { age: "24", sex: "female", birthplace: "the hills", residence: "the harbour" }, background: { ideology: "freedom" }, items: [{ name: "Dagger" }], dnd: normalizeDnd({ ...ROGUE, ac: 14 }, { rules, level: 3 }) };
  const sheet = cardSummaryDnd(card, { HP: 11, "Temp HP": 3 });
  assert.match(sheet, /^level 3 Elf Rogue, Criminal background; age 24, female, from the hills, lives in the harbour\n/);
  assert.match(sheet, /abilities: STR 8 \(-1\), DEX 17 \(\+3\), CON 15 \(\+2\), INT 12 \(\+1\), WIS 13 \(\+1\), CHA 10 \(\+0\); proficiency bonus \+2/);
  assert.match(sheet, /HP 11\/24 \(\+3 temp\), AC 14, speed 30, initiative \+3, hit dice 3d8/); assert.match(sheet, /saving throws: DEX \+5, INT \+3/);
  assert.match(sheet, /Stealth \+7 \(expertise\)/); assert.match(sheet, /Perception \+3/); assert.match(sheet, /background: ideology: freedom/); assert.match(sheet, /carrying: Dagger/);
  assert.match(cardSummaryDnd({ dnd: normalizeDnd({ class: "Wizard", species: "Human", background: "Sage", base: { STR: 8, DEX: 14, CON: 13, INT: 15, WIS: 12, CHA: 10 }, increases: { INT: 2, CON: 1 } }, { rules, level: 3 }) }, { "Slot 1": 2 }), /spellcasting: INT, save DC 13, attack \+5; slots level 1: 2\/4, level 2: 2\/2/);
  assert.equal(castNoteDnd(card), "level 3 Elf Rogue (Criminal)"); assert.equal(castNoteDnd({ basic: {} }), "");
  assert.equal(cardSummaryDnd(null), "(not available)");
  assert.equal(rulesProfile("dnd2024").cardSummary, cardSummaryDnd);
});
