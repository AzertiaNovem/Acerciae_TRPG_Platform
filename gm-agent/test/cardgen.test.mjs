import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCard, derived, skillIndex } from "../src/roles/cardgen.mjs";
import { completeJson } from "../src/llm/index.mjs";

const rules = {
  skills: [{ name: "Spot Hidden", base: 25, names: { "zh-CN": "侦查" } }, { name: "Library Use", base: 20, names: {} }, { name: "Cthulhu Mythos", base: 0, names: {} }],
  families: [{ name: "Fighting", base: 0 }, { name: "Science", base: 1 }],
};

test("characteristics are clamped to COC7 creation ranges and derived values computed", () => {
  const card = normalizeCard({ characteristics: { STR: 120, CON: 5, SIZ: 30, DEX: 60, APP: 50, INT: 95, POW: 55, EDU: 70 } }, { rules });
  assert.deepEqual(card.characteristics, { STR: 90, CON: 15, SIZ: 40, DEX: 60, APP: 50, INT: 90, POW: 55, EDU: 70, LUK: 50 });
  assert.equal(card.derived.hp_max, 5);
  assert.equal(card.derived.san, 55);
  assert.equal(card.derived.mp_max, 11);
  assert.equal(card.derived.db, "+1D4");
});

test("MOV follows DEX, STR and SIZ", () => {
  assert.equal(derived({ STR: 40, DEX: 40, SIZ: 60, CON: 50, POW: 50 }).mov, 7);
  assert.equal(derived({ STR: 70, DEX: 70, SIZ: 60, CON: 50, POW: 50 }).mov, 9);
  assert.equal(derived({ STR: 70, DEX: 40, SIZ: 60, CON: 50, POW: 50 }).mov, 8);
});

test("skill names are matched to the platform's names, unknown ones dropped, Mythos capped for investigators", () => {
  const card = normalizeCard({ skills: { "spot hidden": 70, 侦查: 65, "fighting (brawl)": 40, "Science (Chemistry)": 30, Telepathy: 90, "Cthulhu Mythos": 40, "Library Use": 120 } }, { rules });
  assert.deepEqual(card.skills, { "Spot Hidden": 65, "Fighting (Brawl)": 40, "Science (Chemistry)": 30, "Cthulhu Mythos": 10, "Library Use": 99 });
  assert.equal(card.derived.san_max, 89);
  assert.equal(skillIndex(null)("Anything"), "Anything");
});

test("NPC cards may go beyond investigator limits", () => {
  const card = normalizeCard({ characteristics: { STR: 150 }, skills: { "Cthulhu Mythos": 60 } }, { rules, kind: "npc" });
  assert.equal(card.characteristics.STR, 150);
  assert.equal(card.skills["Cthulhu Mythos"], 60);
});

test("a reply that is not JSON gets one repair round", async () => {
  const replies = ["Sure! Here it is", "```json\n{\"name\": \"Ada\", \"role_card\": {}}\n```"];
  const llm = { calls: 0, async complete() { return replies[this.calls++]; } };
  const out = await completeJson(llm, { system: "s", user: "u", purpose: "coplayer_card" }, (x) => x);
  assert.equal(out.name, "Ada");
  assert.equal(llm.calls, 2);
});
