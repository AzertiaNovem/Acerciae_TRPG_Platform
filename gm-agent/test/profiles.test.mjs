import { test } from "node:test";
import assert from "node:assert/strict";
import { investigatorProfile, investigatorsFor, renderProfile } from "../src/context/profiles.mjs";
import { Roster } from "../src/roles/roster.mjs";
import { createRequire } from "node:module";
import * as rulesMod from "../src/rules/index.mjs";
import * as traitsMod from "../src/context/traits.mjs";
const require_ = (m) => (m.endsWith("rules/index.mjs") ? rulesMod : traitsMod);

test("a profile holds the non-empty basic details, the bio and the background", () => {
  const lines = investigatorProfile({
    name: "Alice Hale",
    bio: "Grew up above her father's print shop.",
    role_card: { basic: { occupation: "Journalist", age: "31", sex: "", residence: "Arkham" }, background: { ideology: "The truth will out.", traits: "", phobias: "Deep water" }, skills: { "Spot Hidden": 60 }, characteristics: { INT: 70 } },
  });
  assert.deepEqual(lines, ["occupation: Journalist; age: 31; residence: Arkham", "bio: Grew up above her father's print shop.", "ideology: The truth will out.", "phobias: Deep water"]);
  assert.ok(!lines.join(" ").includes("Spot Hidden"), "skills are not part of a profile");
});

test("a blank card gives just the name; long fields are clipped", () => {
  assert.equal(renderProfile({ name: "Mo Reyes", role_card: {} }, "played by mo"), "- Mo Reyes (played by mo)");
  const [line] = investigatorProfile({ name: "X", role_card: { background: { encounters: "a".repeat(1000) } } });
  assert.ok(line.length < 420 && line.endsWith("…"));
});

test("investigators are the player characters, then the co-players, never real NPCs", () => {
  const characters = [{ id: "cp1", kind: "npc" }, { id: "npc", kind: "npc" }, { id: "cp2", kind: "npc" }, { id: "pc", kind: "pc" }];
  const roster = new Roster({ coplayers: [{ characterId: "cp1", seats: [] }, { characterId: "cp2", seats: [] }], npcs: [{ characterId: "npc" }] });
  assert.deepEqual(investigatorsFor(characters, roster).map((c) => c.id), ["pc", "cp1", "cp2"]);
  assert.deepEqual(investigatorsFor(characters, roster, { except: "cp1" }).map((c) => c.id), ["pc", "cp2"]);
});

test("a D&D card: traits from the final scores (18 and above, 7 and below), the build line, never a number", () => {
  const { rulesProfile } = require_("../src/rules/index.mjs");
  const dnd = rulesProfile("dnd2024");
  const card = { basic: { occupation: "Fighter", sex: "male", age: "40" }, dnd: { class: "Fighter", level: 3, species: "Goliath", background: "Soldier", base: { STR: 15, DEX: 10, CON: 14, INT: 8, WIS: 12, CHA: 8 }, increases: { STR: 2, CON: 1 }, improvements: { STR: 1, CHA: -1 }, skills: { Athletics: 1 } } };
  const { distinctiveTraits, impression } = require_("../src/context/traits.mjs");
  assert.deepEqual(distinctiveTraits(card), ["extremely strong", "awkward, off-putting"], "STR 15+2+1 = 18; CHA 8-1 = 7");
  assert.deepEqual(distinctiveTraits({ dnd: { base: { STR: 18, DEX: 6, CON: 10, INT: 7, WIS: 10, CHA: 20 } } }), ["extremely charismatic, magnetic", "clumsy and slow", "extremely strong"]);
  assert.equal(impression({ basic: { sex: "female", age: "30" }, dnd: { base: { STR: 8, DEX: 8, CON: 8, INT: 19, WIS: 8, CHA: 8 } } }), "(female, 30; extremely intelligent)");
  const lines = investigatorProfile({ name: "Bram", role_card: card }, dnd);
  assert.equal(lines[0], "build: level 3 Goliath Fighter (Soldier)"); assert.equal(lines[1], "occupation: Fighter; age: 40; gender: male"); assert.equal(lines[2], "notable: extremely strong; awkward, off-putting");
  assert.ok(!lines.join(" ").match(/\b(15|18|14)\b/), "no scores");
  assert.equal(renderProfile({ name: "Bram", role_card: card }, "", null).split("\n")[1], "    occupation: Fighter; age: 40; gender: male", "without a profile, no build line");
});
