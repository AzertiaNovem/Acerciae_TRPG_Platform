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
  for (const id of RULE_SYSTEMS) assert.deepEqual([rulesProfile(id).vocab.gm, rulesProfile(id).vocab.gmShort], ["GM", "GM"], `the GM is "GM" in ${id}`);
  assert.equal(rulesProfile("dnd2024").vocab.pcs, "adventurers"); assert.equal(rulesProfile().vocab.pcs, "investigators");
  assert.throws(() => rulesProfile("dnd5e"), /unknown rule system "dnd5e"/);
  assert.ok(Object.isFrozen(rulesProfile("dnd2024")));
});

test("adaptPrompt swaps the CoC words for a D&D table and leaves a CoC table's text untouched; the GM stays the GM", () => {
  const text = "You are the GM's assistant in a Call of Cthulhu 7th edition campaign; the Investigators, the investigators and one investigator; GM-only notes; the GM.";
  assert.equal(adaptPrompt(rulesProfile("coc7e"), text), text);
  assert.equal(adaptPrompt(null, text), text);
  assert.equal(adaptPrompt(rulesProfile("dnd2024"), text), "You are the GM's assistant in a a fifth-edition fantasy roleplaying game (D&D 2024 rules, System Reference Document 5.2) campaign; the Adventurers, the adventurers and one adventurer; GM-only notes; the GM.");
  assert.equal(adaptPrompt(rulesProfile("pbta"), text), "You are the GM's assistant in a Powered by the Apocalypse campaign; the Characters, the characters and one character; GM-only notes; the GM.");
  assert.equal(adaptPrompt(rulesProfile("dnd2024"), "investigatory work; reinvestigators"), "investigatory work; reinvestigators", "only the whole word");
});

// No prompt this client writes calls the GM by a system's own title, in any rule system.
const OLD_TITLES = /Keeper|\bKP\b|Dungeon Master|\bDM\b|\bMC\b|Master of Ceremonies|Game Master/;
test("every rule system's prompts call the GM \"GM\"", () => {
  for (const id of RULE_SYSTEMS) {
    const profile = rulesProfile(id), pbta = id === "pbta";
    const prompts = {
      director: directorSystem("English", { profile, pbta, improv: true, casual: true, calendar: true, planner: true, forks: true }),
      legacy: directorSystem("English", { profile, pbta, auto: false }),
      coplayer: coplayerSystem("English", { profile, improv: true, casual: true, ...(pbta ? { pbta: { moves: [] } } : {}) }),
    };
    for (const [k, v] of Object.entries(prompts)) {
      assert.doesNotMatch(v, OLD_TITLES, `${id} ${k}`);
      assert.match(v, /\bGM\b/, `${id} ${k} names the GM`);
    }
    assert.match(prompts.director, /^You are the GM \(Game master\) of /, `${id}: the GM is introduced once`);
    assert.equal(prompts.director.match(/Game master/g).length, 1, `${id}: and only once`);
  }
  for (const mode of ["full", "pace"]) for (const final of [false, true]) assert.doesNotMatch(plannerSystem("English", { mode, final, calendar: true, table: true }), OLD_TITLES, `planner ${mode}${final ? " final" : ""}`);
});

test("a CoC table's prompts preserve main's continuity and calendar pacing before D&D support", () => {
  // The fixture is JSON.stringify(got, null, 2) + "\n" of exactly the prompts below. A prompt change rebuilds every
  // CoC table's prompt cache once: regenerate it deliberately, never to make a test pass.
  const snap = JSON.parse(fs.readFileSync(new URL("./fixtures/prompts.coc7e.json", import.meta.url), "utf8"));
  const got = {
    // The snapshot was taken with scene forks; without them (the default) only the scenario rule differs.
    director: { base: directorSystem("English", { forks: true }), improv: directorSystem("English", { improv: true, forks: true }), full: directorSystem("English", { casual: true, calendar: true, planner: true, forks: true }), legacy: directorSystem("English", { auto: false, forks: true }) },
    coplayer: { base: coplayerSystem("English", {}), improvCasual: coplayerSystem("English", { improv: true, casual: true }) },
    planner: { full: plannerSystem("English", { mode: "full" }), paceFinal: plannerSystem("English", { mode: "pace", final: true, calendar: true, table: true }) },
  };
  for (const [group, prompts] of Object.entries(got)) for (const [k, v] of Object.entries(prompts)) assert.equal(v, snap[group][k], `${group}.${k}`);
  const coc = rulesProfile("coc7e");
  assert.equal(directorSystem("English", { profile: coc, forks: true }), snap.director.base, "the CoC profile is the default");
  const lobby = "Decide this only in the primary story scene (which may be a restricted fork). Main Chat becomes a public lobby after the party splits; never narrate a private scene there.";
  assert.equal(directorSystem("English", {}), snap.director.base.replace(lobby, "Decide this only in the Main Chat."), "without scene forks only the scenario rule differs");
});

test("PbtA keeps sourced moves and player choices without CoC or D&D dice", () => {
  const profile = rulesProfile("pbta");
  const director = directorSystem("English", { profile, pbta: true });
  assert.match(director, /^You are the GM \(Game master\) of a Powered by the Apocalypse campaign/);
  assert.match(director, /Narrate only the GM's own decisions\./);
  assert.match(director, /"type":"move","source_id"/);
  assert.match(director, /quote the options and wait for their actual reply/);
  assert.doesNotMatch(director, /Keeper|\bMC\b|Sealdice|"type": "dice"|"type": "request_roll"|undefined/);
  const coplayer = coplayerSystem("English", { profile, pbta: { moves: [] } });
  assert.match(coplayer, /"command": "\.move <move-id>"/);
  assert.doesNotMatch(coplayer, /Keeper|\bMC\b|Sealdice|\.rc |\.ra |undefined/);
});

test("a D&D table's prompts name the GM and the D20 commands, never the Keeper, the Dungeon Master or sanity", () => {
  const dnd = rulesProfile("dnd2024");
  const director = directorSystem("English", { profile: dnd, improv: true });
  assert.match(director, /^You are the GM \(Game master\) of a fifth-edition fantasy campaign \(D&D 2024 rules, SRD 5\.2\), whose genre and tone follow the campaign's world setting, not necessarily fantasy, on an online table\. Human players play their adventurers; some adventurers are AI co-players/);
  assert.doesNotMatch(director, /Keeper|Dungeon Master|\bDM\b|\.sc |Sealdice|investigator/);
  assert.match(director, /"\.rc Stealth dc 15", "\.rc WIS save dc 13", "\.rc attack \+5 ac 14"/);
  assert.match(director, /- Combat: when a fight starts, have everyone roll initiative/); assert.match(director, /Your dice action runs a command as the GM:/);
  assert.match(director, /\{"type": "dice", "command": "\.ri \+2 Goblin \| \.init next/); assert.match(director, /"command": "\.rc <skill \| ABILITY save \| attack \+N> \[dc N \| ac N\]"/);
  assert.match(director, /<GM-only note>/); assert.match(director, /"who": \["<adventurer names>"\]/);
  assert.match(director, /nothing needs the GM now/);
  const coplayer = coplayerSystem("English", { profile: dnd });
  assert.match(coplayer, /^You play one adventurer in a fifth-edition fantasy game \(D&D 2024 rules\) on an online table/);
  assert.doesNotMatch(coplayer, /Keeper|Dungeon Master|Sealdice|\.ra Spot Hidden/);
  assert.match(coplayer, /The GM runs the world\. You are a fellow player, not the GM and not the protagonist\./);
  assert.match(coplayer, /"\.rc Stealth dc 15" for a check, "\.rc WIS save dc 13" for a save/); assert.match(coplayer, /"command": "\.rc <skill> dc N"/);
  assert.match(coplayerSystem("English", { profile: dnd, improv: true }), /a fifth-edition fantasy game \(D&D 2024 rules\) whose genre and tone follow its world setting, on an online table/);
});
