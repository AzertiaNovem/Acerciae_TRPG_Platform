// How each rule system names things in the prompts this client writes: the game, the GM, the player characters. The
// CoC values are the words the prompts were written with, so a CoC table's prompts stay byte for byte the same.
export const COC_VOCAB = Object.freeze({
  game: "Call of Cthulhu 7th edition",
  campaign: "a Call of Cthulhu 7th edition campaign",
  gm: "Keeper", gmShort: "KP",
  pc: "investigator", pcs: "investigators",
  losses: "injuries, sanity and items gained or lost",
});

export const DND_VOCAB = Object.freeze({
  game: "a fifth-edition fantasy roleplaying game (D&D 2024 rules, System Reference Document 5.2)",
  campaign: "a fifth-edition fantasy campaign (D&D 2024 rules, SRD 5.2)",
  gm: "Dungeon Master", gmShort: "DM",
  pc: "adventurer", pcs: "adventurers",
  losses: "injuries, hit points, spell slots, conditions and items gained or lost",
});
