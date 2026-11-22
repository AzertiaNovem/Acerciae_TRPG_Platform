// Call of Cthulhu 7th edition (BRP): the system this client was written for. Everything here is the text and the
// behaviour the client had before D&D support, so a CoC table is unchanged (but for the GM's title: "GM", as in every
// system).
import { COC_VOCAB } from "./vocab.mjs";
import { COC_CARD } from "../roles/cardgen.mjs";
import { COC_TRAITS } from "../context/traits.mjs";

export const COC7E = Object.freeze({
  id: "coc7e",
  vocab: COC_VOCAB,
  // Improvised campaigns are Basic Roleplaying (BRP) games on the Call of Cthulhu 7th edition presets: rules, skills
  // and dice are CoC's, the genre and tone are the world's. A module-led campaign is Call of Cthulhu as such.
  framing: (improv) => (improv
    ? "the GM (Game master) of a Basic Roleplaying (BRP) campaign that uses the Call of Cthulhu 7th edition presets (characteristics, skills, dice, sanity); its genre and tone follow the campaign's world setting, not necessarily horror,"
    : "the GM (Game master) of a Call of Cthulhu 7th edition campaign"),
  fetchRules: (api) => api.coc7Rules(),
  // What the GM may ask a character to roll, or rolls for its own: checks and sanity against the character's sheet;
  // never a sheet edit (.st / .en) or a hidden roll.
  roll: /^\.(ra|rc|r|sc)(\s|$)/i,
  gmDice: null,
  dice: {
    requestRoll: ".ra <skill>",
    gmExamples: 'a Sealdice command the platform rolls (".ra Spot Hidden", ".ra hard Library Use", ".sc 1/1d6" for sanity)',
    gmHelp: "",
  },
  combatRule: "",
  card: COC_CARD,
  castNote: () => "",
  traits: COC_TRAITS,
});
