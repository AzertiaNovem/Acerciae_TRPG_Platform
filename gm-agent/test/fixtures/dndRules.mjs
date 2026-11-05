// A stand-in for GET /api/dnd/rules, with the SRD 5.2 data the platform serves (backend Dnd2024Rules.cpp), trimmed
// to English and Simplified Chinese names.
const cls = (name, zh, hit_die, saves, skill_count, skills, caster) => ({ name, names: { en: name, "zh-CN": zh }, hit_die, saves, skill_count, skills, caster });
const species = (name, zh, speed, extra_skills, skill_from) => ({ name, names: { en: name, "zh-CN": zh }, speed, extra_skills, skill_from });
const background = (name, zh, abilities, skills) => ({ name, names: { en: name, "zh-CN": zh }, abilities, skills });
const rows = (list) => list.map((r) => r);

const SKILLS = [["Acrobatics", "特技", "DEX"], ["Animal Handling", "驯兽", "WIS"], ["Arcana", "奥秘", "INT"], ["Athletics", "运动", "STR"], ["Deception", "欺瞒", "CHA"], ["History", "历史", "INT"], ["Insight", "洞悉", "WIS"], ["Intimidation", "威吓", "CHA"], ["Investigation", "调查", "INT"], ["Medicine", "医药", "WIS"], ["Nature", "自然", "INT"], ["Perception", "察觉", "WIS"], ["Performance", "表演", "CHA"], ["Persuasion", "游说", "CHA"], ["Religion", "宗教", "INT"], ["Sleight of Hand", "巧手", "DEX"], ["Stealth", "隐匿", "DEX"], ["Survival", "求生", "WIS"]];
const ABILITY_NAMES = { STR: ["Strength", "力量"], DEX: ["Dexterity", "敏捷"], CON: ["Constitution", "体质"], INT: ["Intelligence", "智力"], WIS: ["Wisdom", "感知"], CHA: ["Charisma", "魅力"] };

export const DND_RULES = {
  classes: [
    cls("Barbarian", "野蛮人", 12, ["STR", "CON"], 2, ["Animal Handling", "Athletics", "Intimidation", "Nature", "Perception", "Survival"], "none"),
    cls("Bard", "吟游诗人", 8, ["DEX", "CHA"], 3, [], "full"),
    cls("Cleric", "牧师", 8, ["WIS", "CHA"], 2, ["History", "Insight", "Medicine", "Persuasion", "Religion"], "full"),
    cls("Druid", "德鲁伊", 8, ["INT", "WIS"], 2, ["Animal Handling", "Arcana", "Insight", "Medicine", "Nature", "Perception", "Religion", "Survival"], "full"),
    cls("Fighter", "战士", 10, ["STR", "CON"], 2, ["Acrobatics", "Animal Handling", "Athletics", "History", "Insight", "Intimidation", "Persuasion", "Perception", "Survival"], "none"),
    cls("Monk", "武僧", 8, ["STR", "DEX"], 2, ["Acrobatics", "Athletics", "History", "Insight", "Religion", "Stealth"], "none"),
    cls("Paladin", "圣武士", 10, ["WIS", "CHA"], 2, ["Athletics", "Insight", "Intimidation", "Medicine", "Persuasion", "Religion"], "half"),
    cls("Ranger", "游侠", 10, ["STR", "DEX"], 3, ["Animal Handling", "Athletics", "Insight", "Investigation", "Nature", "Perception", "Stealth", "Survival"], "half"),
    cls("Rogue", "游荡者", 8, ["DEX", "INT"], 4, ["Acrobatics", "Athletics", "Deception", "Insight", "Intimidation", "Investigation", "Perception", "Persuasion", "Sleight of Hand", "Stealth"], "none"),
    cls("Sorcerer", "术士", 6, ["CON", "CHA"], 2, ["Arcana", "Deception", "Insight", "Intimidation", "Persuasion", "Religion"], "full"),
    cls("Warlock", "邪术师", 8, ["WIS", "CHA"], 2, ["Arcana", "Deception", "History", "Intimidation", "Investigation", "Nature", "Religion"], "pact"),
    cls("Wizard", "法师", 6, ["INT", "WIS"], 2, ["Arcana", "History", "Insight", "Investigation", "Medicine", "Nature", "Religion"], "full"),
  ],
  species: [
    species("Dragonborn", "龙裔", 30, 0, []), species("Dwarf", "矮人", 30, 0, []), species("Elf", "精灵", 30, 1, ["Insight", "Perception", "Survival"]),
    species("Gnome", "侏儒", 30, 0, []), species("Goliath", "歌利亚", 35, 0, []), species("Halfling", "半身人", 30, 0, []),
    species("Human", "人类", 30, 1, []), species("Orc", "兽人", 30, 0, []), species("Tiefling", "提夫林", 30, 0, []),
  ],
  backgrounds: [
    background("Acolyte", "侍僧", ["INT", "WIS", "CHA"], ["Insight", "Religion"]), background("Criminal", "罪犯", ["DEX", "CON", "INT"], ["Sleight of Hand", "Stealth"]),
    background("Sage", "贤者", ["CON", "INT", "WIS"], ["Arcana", "History"]), background("Soldier", "士兵", ["STR", "DEX", "CON"], ["Athletics", "Intimidation"]),
  ],
  point_buy: { budget: 27, min: 8, max: 15, costs: { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 } },
  standard_array: [15, 14, 13, 12, 10, 8],
  max_after_background: 20,
  slots: {
    full: rows([[2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]]),
    half: rows([[2], [2], [3], [3], [4, 2], [4, 2], [4, 3], [4, 3], [4, 3, 2], [4, 3, 2], [4, 3, 3], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2]]),
    pact: [[1, 1], [2, 1], [2, 2], [2, 2], [2, 3], [2, 3], [2, 4], [2, 4], [2, 5], [2, 5], [3, 5], [3, 5], [3, 5], [3, 5], [3, 5], [3, 5], [4, 5], [4, 5], [4, 5], [4, 5]].map(([slots, level]) => ({ slots, level })),
  },
  abilities: ["STR", "DEX", "CON", "INT", "WIS", "CHA"],
  skills: SKILLS.map(([name, , ability]) => ({ name, ability })),
  names: { ...Object.fromEntries(SKILLS.map(([name, zh]) => [name, { en: name, "zh-CN": zh }])), ...Object.fromEntries(Object.entries(ABILITY_NAMES).map(([k, [en, zh]]) => [k, { en, "zh-CN": zh }])) },
  source: "System Reference Document 5.2 (CC-BY-4.0)",
};
