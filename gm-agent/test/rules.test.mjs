import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RULE_SYSTEMS, adaptPrompt, ruleSystemOf, rulesProfile } from "../src/rules/index.mjs";
import { directorSystem } from "../src/director.mjs";
import { coplayerSystem } from "../src/coplayer.mjs";
import { plannerSystem } from "../src/planner.mjs";

test("the rule system comes from the channel; unknown ids are refused", () => {
  assert.equal(ruleSystemOf({ rule_system: "dnd2024" }), "dnd2024");
  assert.equal(ruleSystemOf({ rule_system: "coc7e" }), "coc7e");
  assert.equal(ruleSystemOf({}), "coc7e"); assert.equal(ruleSystemOf(null), "coc7e"); assert.equal(ruleSystemOf({ rule_system: "junk" }), "coc7e");
  assert.equal(ruleSystemOf({ rule_system: "pbta" }), "pbta");
  assert.deepEqual(RULE_SYSTEMS, ["coc7e", "dnd2024", "pbta"]);
  assert.equal(rulesProfile("dnd2024").vocab.gm, "Dungeon Master"); assert.equal(rulesProfile().vocab.gm, "Keeper");
  assert.throws(() => rulesProfile("dnd5e"), /unknown rule system "dnd5e"/);
  assert.ok(Object.isFrozen(rulesProfile("dnd2024")));
});

test("adaptPrompt swaps the CoC words for a D&D table and leaves a CoC table's text untouched", () => {
  const text = "You are the Keeper's assistant in a Call of Cthulhu 7th edition campaign; the investigators and one investigator; KP(Narrative); the Keeper.";
  assert.equal(adaptPrompt(rulesProfile("coc7e"), text), text);
  assert.equal(adaptPrompt(null, text), text);
  assert.equal(adaptPrompt(rulesProfile("dnd2024"), text), "You are the Dungeon Master's assistant in a a fifth-edition fantasy roleplaying game (D&D 2024 rules, System Reference Document 5.2) campaign; the adventurers and one adventurer; DM(Narrative); the Dungeon Master.");
  assert.equal(adaptPrompt(rulesProfile("dnd2024"), "Keepers of the flame; a shopkeeper"), "Keepers of the flame; a shopkeeper", "only the whole word");
});

test("a CoC table's prompts preserve main's continuity and calendar pacing before D&D support", () => {
  const snap = JSON.parse(fs.readFileSync(new URL("./fixtures/prompts.coc7e.json", import.meta.url), "utf8"));
  const got = {
    director: { base: directorSystem("English", {}), improv: directorSystem("English", { improv: true }), full: directorSystem("English", { casual: true, calendar: true, planner: true }), legacy: directorSystem("English", { auto: false }) },
    coplayer: { base: coplayerSystem("English", {}), improvCasual: coplayerSystem("English", { improv: true, casual: true }) },
    planner: { full: plannerSystem("English", { mode: "full" }), paceFinal: plannerSystem("English", { mode: "pace", final: true, calendar: true, table: true }) },
  };
  for (const [group, prompts] of Object.entries(got)) for (const [k, v] of Object.entries(prompts)) assert.equal(v, snap[group][k], `${group}.${k}`);
  const coc = rulesProfile("coc7e");
  assert.equal(directorSystem("English", { profile: coc }), snap.director.base, "the CoC profile is the default");
});

test("PbtA keeps sourced moves and player choices without CoC or D&D dice", () => {
  const profile = rulesProfile("pbta");
  const director = directorSystem("English", { profile, pbta: true });
  assert.match(director, /^You are the MC of a Powered by the Apocalypse campaign/);
  assert.match(director, /"type":"move","source_id"/);
  assert.match(director, /quote the options and wait for their actual reply/);
  assert.doesNotMatch(director, /Keeper|Sealdice|"type": "dice"|"type": "request_roll"|undefined/);
  const coplayer = coplayerSystem("English", { profile, pbta: { moves: [] } });
  assert.match(coplayer, /"command": "\.move <move-id>"/);
  assert.doesNotMatch(coplayer, /Keeper|Sealdice|\.rc |\.ra |undefined/);
});

test("a D&D table's prompts name the Dungeon Master and the D20 commands, never the Keeper or sanity", () => {
  const dnd = rulesProfile("dnd2024");
  const director = directorSystem("English", { profile: dnd, improv: true });
  assert.match(director, /^You are the Dungeon Master \(Game Master\) of a fifth-edition fantasy campaign \(D&D 2024 rules, SRD 5\.2\), whose genre and tone follow the campaign's world setting, not necessarily fantasy, on an online table\. Human players play their adventurers; some adventurers are AI co-players/);
  assert.doesNotMatch(director, /Keeper|\.sc |Sealdice|investigator/);
  assert.match(director, /"\.rc Stealth dc 15", "\.rc WIS save dc 13", "\.rc attack \+5 ac 14"/);
  assert.match(director, /- Combat: when a fight starts, have everyone roll initiative/); assert.match(director, /Your dice action runs a command as the Dungeon Master/);
  assert.match(director, /\{"type": "dice", "command": "\.ri \+2 Goblin \| \.init next/); assert.match(director, /"command": "\.rc <skill \| ABILITY save \| attack \+N> \[dc N \| ac N\]"/);
  assert.match(director, /<Dungeon Master-only note>/); assert.match(director, /"who": \["<adventurer names>"\]/);
  assert.match(director, /Decide|nothing needs the Dungeon Master now/);
  const coplayer = coplayerSystem("English", { profile: dnd });
  assert.match(coplayer, /^You play one adventurer in a fifth-edition fantasy game \(D&D 2024 rules\) on an online table/);
  assert.doesNotMatch(coplayer, /Keeper|Sealdice|\.ra Spot Hidden/);
  assert.match(coplayer, /"\.rc Stealth dc 15" for a check, "\.rc WIS save dc 13" for a save/); assert.match(coplayer, /"command": "\.rc <skill> dc N"/);
  assert.match(coplayerSystem("English", { profile: dnd, improv: true }), /a fifth-edition fantasy game \(D&D 2024 rules\) whose genre and tone follow its world setting, on an online table/);
});
