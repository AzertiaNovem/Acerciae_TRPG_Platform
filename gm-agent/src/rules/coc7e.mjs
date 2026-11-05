// Call of Cthulhu 7th edition (BRP): the system this client was written for. Everything here is the text and the
// behaviour the client had before D&D support, so a CoC table is unchanged.
import { COC_VOCAB } from "./vocab.mjs";
import { COC_CARD } from "../roles/cardgen.mjs";
import { COC_TRAITS } from "../context/traits.mjs";

const cardSummary = (card) => {
  if (!card) return "(not available)";
  const ch = Object.entries(card.characteristics ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  const sk = Object.entries(card.skills ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${v}`).join(", ");
  const d = card.derived ?? {};
  const b = card.basic ?? {};
  return [
    `occupation: ${b.occupation ?? ""}, age ${b.age ?? ""}, ${b.sex ?? ""}, from ${b.birthplace ?? ""}, lives in ${b.residence ?? ""}`,
    `characteristics: ${ch}`,
    `HP ${d.hp ?? "?"}/${d.hp_max ?? "?"}, SAN ${d.san ?? "?"}, MP ${d.mp ?? "?"}, MOV ${d.mov ?? "?"}, damage bonus ${d.db ?? "0"}`,
    `skills: ${sk}`,
    `background: ${Object.entries(card.background ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ")}`,
    `carrying: ${(card.items ?? []).map((i) => i.name).join(", ")}`,
  ].join("\n");
};

export const COC7E = Object.freeze({
  id: "coc7e",
  vocab: COC_VOCAB,
  // Improvised campaigns are Basic Roleplaying (BRP) games on the Call of Cthulhu 7th edition presets: rules, skills
  // and dice are CoC's, the genre and tone are the world's. A module-led campaign is Call of Cthulhu as such.
  framing: (improv) => (improv
    ? "the Keeper (Game Master) of a Basic Roleplaying (BRP) campaign that uses the Call of Cthulhu 7th edition presets (characteristics, skills, dice, sanity); its genre and tone follow the campaign's world setting, not necessarily horror,"
    : "the Keeper (Game Master) of a Call of Cthulhu 7th edition campaign"),
  coplayerGame: (improv) => (improv ? "a Basic Roleplaying (BRP) game using the Call of Cthulhu 7th edition presets, whose genre and tone follow its world setting," : "a Call of Cthulhu 7th edition game"),
  fetchRules: (api) => api.coc7Rules(),
  // Co-players may roll checks and sanity against their own sheet; they never edit sheets (.st / .en) or roll hidden.
  roll: /^\.(ra|rc|r|sc)(\s|$)/i,
  gmDice: null,
  dice: {
    requestRoll: ".ra <skill>",
    gmExamples: 'a Sealdice command the platform rolls (".ra Spot Hidden", ".ra hard Library Use", ".sc 1/1d6" for sanity)',
    coplayerHelp: 'a Sealdice command such as ".ra Spot Hidden"',
    coplayerShape: ".ra <skill>",
    gmHelp: "",
  },
  combatRule: "",
  card: COC_CARD,
  cardSummary,
  castNote: () => "",
  traits: COC_TRAITS,
});
