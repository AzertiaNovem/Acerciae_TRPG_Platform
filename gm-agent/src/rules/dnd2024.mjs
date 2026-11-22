// D&D 2024 (System Reference Document 5.2), the platform's second rule system. The game is "a fifth-edition fantasy
// roleplaying game" (the GM is "GM", as in every system); the dice are D20 Tests (.rc), initiative (.ri,
// .init), death saves (.ds) and spell slots (.ss); the role card carries a build in role_card.dnd (dndcard.mjs).
// An improvised campaign is a fifth-edition game whose genre and tone follow the world setting.
import { DND_VOCAB } from "./vocab.mjs";
import { allocateDndBuild, castNoteDnd, checkDnd, findNamed, missingDndDetails, normalizeDnd, rulesSummaryDnd } from "../roles/dndcard.mjs";
import { DND_TRAITS } from "../context/traits.mjs";
import { COC_CARD } from "../roles/cardgen.mjs";

const DND_CARD_SHAPE = `{"name": string, "persona": string (2-4 sentences: temperament, motive, how they play at the table), "speaking_style": string (short), "appearance_prompt": string (visible appearance, max 1000 characters), "role_card": {"basic": {"player", "occupation": "<the class>", "age", "sex", "residence", "birthplace"}, "background": {"personal_description", "ideology": "<ideals>", "significant_people": "<bonds: the people they are tied to>", "meaningful_locations", "treasured_possessions", "traits": "<personality traits and flaws>", "injuries": "<or None>", "phobias": "<fears, or None>", "arcane": "<their magic, or None>", "encounters": "<notable past encounters, or None>"}, "items": [{"name","note","qty"}], "wealth": {"cash","assets","spending_level"}, "dnd": {"class": "<a class from CLASSES>", "subclass": "<optional>", "species": "<from SPECIES>", "background": "<from BACKGROUNDS>", "method": "point_buy", "base": {"STR","DEX","CON","INT","WIS","CHA"}, "increases": {"<ability>": 2, "<ability>": 1}, "skills": {"<skill>": 1}, "ac": number (only when armour in items says so), "features": "<class and species features at this level>", "spells": "<cantrips and prepared spells; empty for non-casters>"}}}`;

const APPEARANCE = "Also write appearance_prompt in the same response: a concise image prompt describing stable visible traits (age, build, face, hair, clothing and gear of the setting, distinguishing accessories), consistent with the card and the campaign's world. No story spoilers, scene actions, framing instructions or text overlays. Fill every basic and background field; use a localized 'None' for absent injuries, fears, magic or notable encounters instead of inventing them. Set basic.player to NPC.";

const COMBAT_RULE = `- Combat: when a fight starts, have everyone roll initiative: request_roll with ".ri" for each player character, and your own dice ".ri +N <monster name>" for each monster (N: its DEX modifier). Then follow the Initiative order in your context: on a monster's turn act for it (an attack with dice ".r 1d20+<its attack bonus>" against the target's AC, damage with dice ".r <dice>"), on a character's turn ask its player for their action, and call dice ".init next" after each turn. Remove the fallen with ".init del <name>", and ".init clr" when the fight is over. Monsters have no sheet: keep their AC and hit points in a note. Ask for saving throws with request_roll (".rc DEX save dc 13") and for a character's attack with ".rc attack +N ac M" (N: its attack bonus, from its sheet in the cast).`;

// The D&D card: the common fields are the CoC card's (basic, background, items, wealth), the build is role_card.dnd.
const paths = (character, { pointsMode, rules } = {}) => [...COC_CARD.missingDetails(character, { pointsMode: false, rules: null }).filter((p) => !p.startsWith("role_card.characteristics.")), ...missingDndDetails(character, rules)];

function normalize(roleCard, { rules, kind = "pc", level = null, pointsMode = true } = {}) {
  const base = COC_CARD.normalize(roleCard, { rules: null, kind });
  const card = { basic: base.basic, background: base.background, items: base.items, wealth: base.wealth };
  card.dnd = normalizeDnd(roleCard?.dnd, { rules, kind, level: level ?? roleCard?.dnd?.level ?? null, pointsMode });
  return card;
}

const CARD = Object.freeze({
  shape: DND_CARD_SHAPE,
  creationHint: (level) => `Build a level ${level} character: a class, a species and a background from the lists, a 27-point array of base scores (8-15), the background's increases, and exactly the skills the class, background and species give.`,
  rulesSummary: (rules, pointsMode, level) => rulesSummaryDnd(rules, pointsMode, level),
  missingDetails: paths,
  normalize,
  check: (card, rules) => checkDnd(card.dnd ?? {}, rules),
  validateGenerated: (x, { rules } = {}) => {
    if (!x || typeof x !== "object" || !String(x.name ?? "").trim() || !x.role_card || typeof x.role_card !== "object") throw new Error("name and role_card are required");
    const missing = paths(x, { rules });
    if (missing.length) throw new Error(`Fill the missing fields: ${missing.join(", ")}`);
    const d = x.role_card.dnd;
    for (const [list, key] of [["classes", "class"], ["species", "species"], ["backgrounds", "background"]]) if (!findNamed(rules?.[list], d?.[key])) throw new Error(`role_card.dnd.${key} must be one of the ${list.toUpperCase()} names; received ${JSON.stringify(d?.[key])}`);
    return x;
  },
  repair: (llm, card, opts) => allocateDndBuild(llm, card, opts),
  appearanceNote: APPEARANCE,
});

export const DND2024 = Object.freeze({
  id: "dnd2024",
  vocab: DND_VOCAB,
  framing: (improv) => `the GM (Game master) of a fifth-edition fantasy campaign (D&D 2024 rules, SRD 5.2)${improv ? ", whose genre and tone follow the campaign's world setting, not necessarily fantasy," : ""}`,
  fetchRules: (api) => api.dndRules(),
  // What the GM may ask a character to roll, or rolls for its own: D20 Tests, initiative, death saves and spell slots
  // against the character's sheet; never the initiative order (.init), a sheet edit (.st) or a hidden roll.
  roll: /^\.(ra|rc|ri|ds|ss|r)(\s|$)/i,
  // The GM's own dice: monsters' initiative, the order, and plain rolls (it has no character, so no .rc).
  gmDice: /^\.(r|rh|ri|rih|init)(\s|$)/i,
  dice: {
    requestRoll: ".rc <skill | ABILITY save | attack +N> [dc N | ac N]",
    gmExamples: 'a dice command the platform rolls (".rc Stealth dc 15", ".rc WIS save dc 13", ".rc attack +5 ac 14": an attack takes the character\'s typed bonus, from its sheet in the cast; "adv" or "dis" for advantage or disadvantage)',
    gmHelp: "- Your dice action runs a command as the GM: \".ri +2 Goblin\" (a monster's initiative), \".init next\", \".init del <name>\", \".init clr\", \".r 1d8+3\". You have no character sheet, so never \".rc\" for yourself.",
  },
  combatRule: COMBAT_RULE,
  card: CARD,
  castNote: castNoteDnd,
  traits: DND_TRAITS,
});
