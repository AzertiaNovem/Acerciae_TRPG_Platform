import { test } from "node:test";
import assert from "node:assert/strict";
import { investigatorProfile, investigatorsFor, renderProfile } from "../src/context/profiles.mjs";
import { Roster } from "../src/roles/roster.mjs";

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
