// How each rule system names things in the prompts this client writes: the game, the GM, the player characters. The
// GM is "GM" in every system; the CoC values are the words the prompts are written with (adaptPrompt leaves a CoC
// table's text untouched).
export const COC_VOCAB = Object.freeze({
  game: "Call of Cthulhu 7th edition",
  campaign: "a Call of Cthulhu 7th edition campaign",
  gm: "GM", gmShort: "GM",
  pc: "investigator", pcs: "investigators",
  losses: "injuries, sanity and items gained or lost",
});

export const DND_VOCAB = Object.freeze({
  game: "a fifth-edition fantasy roleplaying game (D&D 2024 rules, System Reference Document 5.2)",
  campaign: "a fifth-edition fantasy campaign (D&D 2024 rules, SRD 5.2)",
  gm: "GM", gmShort: "GM",
  pc: "adventurer", pcs: "adventurers",
  losses: "injuries, hit points, spell slots, conditions and items gained or lost",
});
