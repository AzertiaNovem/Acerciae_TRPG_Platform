// A D&D 2024 character's build (role_card.dnd), as the platform stores it (backend Dnd2024Rules.cpp): class, species,
// background, the six ability scores (base + background increases + later improvements), proficiencies, AC, HP,
// speed, spell slots. The model chooses the character; the client computes the rest (saves, HP, speed, hit dice,
// slots, the spellcasting ability), checks the build against the same rules the platform applies under point buy
// (27 points, 8–15, the background's increases, the class's saves, the right number of skills) and repairs it once
// before saving. The rest of the card (basic details, background text, items, wealth) is the CoC card's, reused.
import { completeJson } from "../llm/index.mjs";

export const ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];
const CASTING = { Bard: "CHA", Paladin: "CHA", Sorcerer: "CHA", Warlock: "CHA", Cleric: "WIS", Druid: "WIS", Ranger: "WIS", Wizard: "INT" };
const s = (v, n = 60) => String(v ?? "").trim().slice(0, n);
const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt; };
const norm = (v) => String(v ?? "").normalize("NFKC").trim().toLowerCase();

export const mod = (score) => Math.floor((Number(score) - 10) / 2);
export const proficiencyBonus = (level) => Math.floor((Math.max(1, Number(level) || 1) - 1) / 4) + 2;

// An entry of rules.classes / species / backgrounds by its name or any localized name (the platform matches the same way).
export function findNamed(list, name) {
  const n = norm(name);
  if (!n) return null;
  return (list ?? []).find((x) => norm(x.name) === n || Object.values(x.names ?? {}).some((v) => norm(v) === n)) ?? null;
}

// A skill name the model wrote → the SRD name (any of the platform's localized names), else null.
export function skillIndex(rules) {
  const map = new Map();
  for (const sk of rules?.skills ?? []) {
    map.set(norm(sk.name), sk.name);
    for (const v of Object.values(rules?.names?.[sk.name] ?? {})) if (v) map.set(norm(v), sk.name);
  }
  return (raw) => map.get(norm(raw)) ?? null;
}

// Spell slots of a class at a level, from the tables ({} for a class without spellcasting).
export function classSlots(rules, cls, level) {
  const c = findNamed(rules?.classes, cls);
  const i = Math.max(1, Math.min(20, Number(level) || 1)) - 1;
  const out = {};
  if (!c || c.caster === "none" || !c.caster) return out;
  if (c.caster === "pact") { const p = rules?.slots?.pact?.[i]; if (p) out[String(p.level)] = p.slots; return out; }
  for (const [n, v] of (rules?.slots?.[c.caster]?.[i] ?? []).entries()) if (v) out[String(n + 1)] = v;
  return out;
}

// The final scores: base + increases + improvements, at most 30.
export function scores(dnd) {
  const out = {};
  for (const ab of ABILITIES) out[ab] = Math.min(30, (Number(dnd?.base?.[ab]) || 10) + (Number(dnd?.increases?.[ab]) || 0) + (Number(dnd?.improvements?.[ab]) || 0));
  return out;
}

// Fills what the model leaves out or sets to 0: saves (always the class's), speed, hit dice, HP, AC, slots, the
// spellcasting ability. Existing non-zero values are kept, so a card from play is never overwritten.
export function deriveDnd(dnd, rules) {
  const c = findNamed(rules?.classes, dnd.class);
  const sp = findNamed(rules?.species, dnd.species);
  const sc = scores(dnd);
  const level = Math.max(1, Math.min(20, Number(dnd.level) || 1));
  if (c) dnd.saves = [...c.saves];
  if (!dnd.speed) dnd.speed = sp?.speed ?? 30;
  if (c) {
    if (!dnd.hit_dice) dnd.hit_dice = `${level}d${c.hit_die}`;
    if (!dnd.hp_max) {
      let hp = Math.max(1, c.hit_die + mod(sc.CON));
      for (let l = 2; l <= level; l++) hp += Math.max(1, Math.floor(c.hit_die / 2) + 1 + mod(sc.CON));
      dnd.hp_max = hp;
    }
    if (!dnd.spellcasting_ability && CASTING[c.name]) dnd.spellcasting_ability = CASTING[c.name];
    if (!Object.keys(dnd.slots ?? {}).length) dnd.slots = classSlots(rules, c.name, level);
  }
  if (!dnd.ac) dnd.ac = 10 + mod(sc.DEX);
  dnd.initiative = Number(dnd.initiative) || 0;
  return dnd;
}

// The build as the platform keeps it. A co-player (and an NPC under point buy) is a point-buy build with scores 8–15;
// an NPC with point buy off may have any scores and the manual method.
export function normalizeDnd(src, { rules, kind = "coplayer", level = null, pointsMode = true } = {}) {
  const x = src && typeof src === "object" ? src : {};
  const loose = kind === "npc" && !pointsMode;
  const d = { class: s(x.class), subclass: s(x.subclass), species: s(x.species), background: s(x.background) };
  for (const list of ["classes", "species", "backgrounds"]) {
    const key = list === "classes" ? "class" : list === "species" ? "species" : "background";
    const hit = findNamed(rules?.[list], d[key]);
    if (hit) d[key] = hit.name;
  }
  d.level = clamp(level ?? x.level, 1, 20, 1);
  d.method = x.method === "standard_array" || (x.method === "manual" && loose) ? x.method : "point_buy";
  d.base = {}; d.increases = {}; d.improvements = {};
  for (const ab of ABILITIES) {
    d.base[ab] = clamp(x.base?.[ab], loose ? 1 : 8, loose ? 30 : 15, loose ? 10 : 8);
    const inc = clamp(x.increases?.[ab], 0, 2, 0); if (inc) d.increases[ab] = inc;
    const imp = clamp(x.improvements?.[ab], 0, 10, 0); if (imp) d.improvements[ab] = imp;
  }
  d.saves = ABILITIES.filter((ab) => (Array.isArray(x.saves) ? x.saves : []).some((v) => norm(v) === norm(ab)));
  const skillName = skillIndex(rules);
  d.skills = {};
  for (const [k, v] of Object.entries(x.skills && typeof x.skills === "object" ? x.skills : {})) {
    const name = skillName(k);
    const n = clamp(v, 0, 2, 0);
    if (name && n) d.skills[name] = Math.max(d.skills[name] ?? 0, n);
  }
  d.ac = clamp(x.ac, 0, 40, 0);
  d.hp_max = clamp(x.hp_max, 0, 999, 0);
  d.speed = clamp(x.speed, 0, 200, 0);
  d.initiative = clamp(x.initiative, -10, 20, 0);
  d.hit_dice = s(x.hit_dice, 16);
  d.spellcasting_ability = ABILITIES.includes(x.spellcasting_ability) ? x.spellcasting_ability : "";
  d.slots = {};
  for (let lv = 1; lv <= 9; lv++) { const v = clamp(x.slots?.[lv], 0, 9, 0); if (v) d.slots[String(lv)] = v; }
  d.features = s(x.features, 4000);
  d.spells = s(x.spells, 4000);
  return deriveDnd(d, rules);
}

// The platform's point-buy check, applied here first so a bad build is repaired before it is saved: the same codes,
// in the same order, plus two of this client's own (an unknown species or background).
export function checkDnd(dnd, rules) {
  const violations = [];
  const V = (code, message) => violations.push({ code, message });
  const pb = rules?.point_buy ?? { budget: 27, costs: { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 } };
  const base = (ab) => (dnd.base?.[ab] === undefined ? 8 : Number(dnd.base[ab]));
  let spent = 0;
  if (dnd.method === "manual") V("method", "Point buy is on: choose point buy or the standard array for the ability scores.");
  else if (dnd.method === "standard_array") {
    const got = ABILITIES.map((ab) => (dnd.base?.[ab] === undefined ? 0 : Number(dnd.base[ab]))).sort((a, b) => b - a);
    if (JSON.stringify(got) !== JSON.stringify(rules?.standard_array ?? [15, 14, 13, 12, 10, 8])) V("standard_array", "Assign the standard array 15, 14, 13, 12, 10, 8: each value once.");
  } else {
    for (const ab of ABILITIES) {
      const v = base(ab);
      if (v < 8 || v > 15) { V("score_range", `${ab} must be between 8 and 15 before background increases.`); continue; }
      spent += Number(pb.costs?.[v] ?? 0);
    }
    if (spent > Number(pb.budget ?? 27)) V("budget", `The scores cost ${spent} points; the budget is ${pb.budget ?? 27}.`);
  }
  const bg = findNamed(rules?.backgrounds, dnd.background);
  let sum = 0, twos = 0;
  for (const ab of ABILITIES) {
    const v = Number(dnd.increases?.[ab]) || 0;
    if (!v) continue;
    sum += v; twos += v === 2 ? 1 : 0;
    if (bg && !bg.abilities.includes(ab)) V("increase_ability", `${ab} is not one of the ${bg.name} background's abilities.`);
    if (base(ab) + v > Number(rules?.max_after_background ?? 20)) V("increase_cap", `${ab} cannot rise above 20.`);
  }
  if (sum > 3 || twos > 1) V("increases", "Background increases are +2 and +1, or +1 to three abilities.");
  const c = findNamed(rules?.classes, dnd.class);
  if (dnd.class && !c) V("class", "Choose a class from the System Reference Document.");
  if (c) {
    const want = [...c.saves].sort().join(","), got = [...(dnd.saves ?? [])].sort().join(",");
    if (want !== got) V("saves", `A ${c.name} is proficient in ${c.saves.join(" and ")} saving throws.`);
  }
  let left = Object.keys(dnd.skills ?? {});
  if (bg) left = left.filter((k) => !bg.skills.includes(k));
  const sp = findNamed(rules?.species, dnd.species);
  const inList = (arr, k) => !arr?.length || arr.includes(k);
  let speciesLeft = sp ? Number(sp.extra_skills) || 0 : 0;
  // A species pick first goes to a skill the class cannot give, then the class picks, then any species pick left.
  if (sp && c) left = left.filter((k) => { if (speciesLeft > 0 && inList(sp.skill_from, k) && !inList(c.skills, k)) { speciesLeft--; return false; } return true; });
  let classLeft = c ? Number(c.skill_count) || 0 : 0;
  left = left.filter((k) => { if (classLeft > 0 && c && inList(c.skills, k)) { classLeft--; return false; } return true; });
  left = left.filter((k) => { if (speciesLeft > 0 && sp && inList(sp.skill_from, k)) { speciesLeft--; return false; } return true; });
  if (left.length) V("skills", `More skill proficiencies than the class, background and species give: ${left.join(", ")}.`);
  if (dnd.species && !sp) V("species", "Choose a species from the System Reference Document.");
  if (dnd.background && !bg) V("background", "Choose a background from the System Reference Document.");
  return { spent, violations };
}

// What the model is told about the system when it writes a card.
export function rulesSummaryDnd(rules, pointsMode, level = 1) {
  const classes = (rules?.classes ?? []).map((c) => `${c.name} (d${c.hit_die}; saves ${c.saves.join("/")}; ${c.skill_count} skills from ${c.skills?.length ? c.skills.join(", ") : "any"}${c.caster && c.caster !== "none" ? `; ${c.caster === "pact" ? "pact magic" : `${c.caster} caster`}` : ""})`).join("\n- ");
  const species = (rules?.species ?? []).map((x) => `${x.name} (speed ${x.speed}${x.extra_skills ? `; +${x.extra_skills} skill from ${x.skill_from?.length ? x.skill_from.join(", ") : "any"}` : ""})`).join(", ");
  const backgrounds = (rules?.backgrounds ?? []).map((b) => `${b.name} (abilities ${b.abilities.join("/")}; skills ${b.skills.join(", ")})`).join("; ");
  const pb = rules?.point_buy ?? {};
  return [
    "DND BUILD RULES (D&D 2024, SRD 5.2; use these exact English names):",
    `LEVEL: ${level}.`,
    `CLASSES:\n- ${classes}`,
    `SPECIES: ${species}`,
    `BACKGROUNDS: ${backgrounds}`,
    `POINT BUY: ${pb.budget ?? 27} points; each base score 8-15, costing ${Object.entries(pb.costs ?? {}).map(([k, v]) => `${k}:${v}`).join(" ")}; the six costs add up to at most ${pb.budget ?? 27}. Then the background's increases: +2 and +1, or +1 to each of its three abilities, never above 20.`,
    "SKILLS: exactly the background's two, plus the class's count from its list, plus the species' extra skill from its list (Human: any). Write 1 for proficiency, 2 for Expertise (Rogues: two skills).",
    `Write only class, subclass, species, background, method "point_buy", base, increases, skills, ac (only when armour in items says so), features and spells in role_card.dnd. Do not write level, saves, hp_max, speed, initiative, hit_dice, slots or spellcasting_ability: they are computed.${pointsMode ? " POINT-BUY IS ON: the platform refuses any build that breaks these rules." : ""}`,
  ].join("\n");
}

// The paths an existing D&D character still needs (besides the common card fields).
export function missingDndDetails(character, rules) {
  const d = character?.role_card?.dnd;
  const out = [];
  if (!d || !findNamed(rules?.classes, d.class)) out.push("role_card.dnd.class");
  if (!d || !findNamed(rules?.species, d.species)) out.push("role_card.dnd.species");
  if (!d || !findNamed(rules?.backgrounds, d.background)) out.push("role_card.dnd.background");
  if (!d || ABILITIES.filter((ab) => Number.isFinite(Number(d.base?.[ab]))).length < 6) out.push("role_card.dnd.base");
  return out;
}

// One repair round: the model fixes the build against the violations, keeping the character.
export async function allocateDndBuild(llm, card, { rules, language, level = card.dnd?.level ?? 1, feedback = "" }) {
  const system = `Fix the D&D 2024 build of an existing character so that it follows the rules below, changing as little as possible: keep the class, species and background unless the violations name them, rearrange the base scores to a legal point buy, keep the increases on the background's abilities, and trim the skills to what the class, background and species give. Write text in ${language}. Reply with only {"dnd": {"class", "subclass", "species", "background", "method": "point_buy", "base": {"STR","DEX","CON","INT","WIS","CHA"}, "increases": {}, "skills": {}, "features", "spells"}}.`;
  const user = `${rulesSummaryDnd(rules, true, level)}\nEXISTING CARD: ${JSON.stringify(card)}\nVIOLATIONS: ${feedback || JSON.stringify(checkDnd(card.dnd ?? {}, rules).violations)}`;
  const fixed = await completeJson(llm, { system, user, purpose: "coplayer_build" }, (x) => {
    if (!x || typeof x !== "object" || !x.dnd || typeof x.dnd !== "object") throw new Error("expected {dnd: {...}}");
    return x;
  });
  const dnd = normalizeDnd({ ...card.dnd, ...fixed.dnd, improvements: card.dnd?.improvements, ac: fixed.dnd.ac ?? card.dnd?.ac, hp_max: 0, slots: {} }, { rules, level, pointsMode: true });
  return { ...card, dnd };
}

// The co-player's own sheet, for its prompt: the build, abilities with modifiers, combat values, proficiencies, spells.
export function cardSummaryDnd(card, attrs = {}) {
  const d = card?.dnd;
  if (!d) return "(not available)";
  const sc = scores(d);
  const pb = proficiencyBonus(d.level);
  const b = card.basic ?? {};
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const skills = Object.entries(d.skills ?? {}).map(([k, v]) => `${k} ${sign(mod(sc[(SKILL_ABILITY[k] ?? "INT")]) + pb * v)}${v === 2 ? " (expertise)" : ""}`).join(", ");
  const slots = Object.entries(d.slots ?? {}).map(([lv, max]) => `level ${lv}: ${attrs[`Slot ${lv}`] ?? max}/${max}`).join(", ");
  const spell = d.spellcasting_ability ? `spellcasting: ${d.spellcasting_ability}, save DC ${8 + pb + mod(sc[d.spellcasting_ability])}, attack ${sign(pb + mod(sc[d.spellcasting_ability]))}${slots ? `; slots ${slots}` : ""}` : "";
  return [
    `level ${d.level} ${d.species} ${d.class}${d.subclass ? ` (${d.subclass})` : ""}, ${d.background} background; age ${b.age ?? ""}, ${b.sex ?? ""}, from ${b.birthplace ?? ""}, lives in ${b.residence ?? ""}`,
    `abilities: ${ABILITIES.map((ab) => `${ab} ${sc[ab]} (${sign(mod(sc[ab]))})`).join(", ")}; proficiency bonus ${sign(pb)}`,
    `HP ${attrs.HP ?? d.hp_max}/${d.hp_max}${attrs["Temp HP"] ? ` (+${attrs["Temp HP"]} temp)` : ""}, AC ${d.ac}, speed ${d.speed}, initiative ${sign(mod(sc.DEX) + (d.initiative || 0))}, hit dice ${d.hit_dice}`,
    `saving throws: ${d.saves.map((ab) => `${ab} ${sign(mod(sc[ab]) + pb)}`).join(", ")}`,
    `skills: ${skills || "(none)"}`,
    spell,
    d.features ? `features: ${d.features}` : "",
    d.spells ? `spells: ${d.spells}` : "",
    `background: ${Object.entries(card.background ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ")}`,
    `carrying: ${(card.items ?? []).map((i) => i.name).join(", ")}`,
  ].filter(Boolean).join("\n");
}
const SKILL_ABILITY = { Acrobatics: "DEX", "Animal Handling": "WIS", Arcana: "INT", Athletics: "STR", Deception: "CHA", History: "INT", Insight: "WIS", Intimidation: "CHA", Investigation: "INT", Medicine: "WIS", Nature: "INT", Perception: "WIS", Performance: "CHA", Persuasion: "CHA", Religion: "INT", "Sleight of Hand": "DEX", Stealth: "DEX", Survival: "WIS" };

// "level 3 Elf Rogue (Criminal)" for the Keeper's cast list; "" for a card without a build.
export const castNoteDnd = (card) => (card?.dnd?.class ? `level ${card.dnd.level} ${card.dnd.species} ${card.dnd.class}${card.dnd.background ? ` (${card.dnd.background})` : ""}` : "");
