// Role cards written by the model: co-players (fellow investigators) at setup, real NPCs on demand. The model's card is
// checked against the rule system before it is saved; for COC7 (this file): characteristics clamped to the creation
// ranges, derived values computed, skill names matched to the platform's list (GET /api/coc7/rules), so the
// platform's dice read it correctly. A rules profile (rules/*.mjs) names the system's words and card functions; the
// CoC ones live here as COC_CARD and are the default, so the D&D ones (dndcard.mjs) never touch this path.
import { completeJson } from "../llm/index.mjs";
import { allocatePointBuy, careerCatalog, findCareer, needsPointBuy } from "./pointbuy.mjs";
import { COC_VOCAB } from "../rules/vocab.mjs";

const CHARS = ["STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUK"];
const BASIC = ["player", "occupation", "age", "sex", "residence", "birthplace"];
const BACKGROUND = ["personal_description", "ideology", "significant_people", "meaningful_locations", "treasured_possessions", "traits", "injuries", "phobias", "arcane", "encounters"];
const APPEARANCE = "Also write appearance_prompt in the same response: a concise image prompt describing stable visible traits (age, build, face, hair, period clothing, distinguishing accessories), consistent with the card and campaign era. No story spoilers, scene actions, framing instructions or text overlays. Fill every basic and background field; use a localized 'None' for absent injuries, phobias, magic or Mythos encounters instead of inventing them. Set basic.player to AI co-player (or NPC).";

export function missingDetails(character) {
  const paths = [];
  if (!String(character.appearance_prompt ?? "").trim()) paths.push("appearance_prompt");
  for (const key of BASIC) if (!String(character.role_card?.basic?.[key] ?? "").trim()) paths.push(`role_card.basic.${key}`);
  for (const key of CHARS) if (typeof character.role_card?.characteristics?.[key] !== 'number' || !Number.isFinite(character.role_card.characteristics[key])) paths.push(`role_card.characteristics.${key}`);
  for (const key of BACKGROUND) if (!String(character.role_card?.background?.[key] ?? "").trim()) paths.push(`role_card.background.${key}`);
  return paths;
}
// COC7 creation ranges: 3D6×5 for STR CON DEX APP POW LUK, (2D6+6)×5 for SIZ INT EDU.
const RANGE = { STR: [15, 90], CON: [15, 90], DEX: [15, 90], APP: [15, 90], POW: [15, 90], LUK: [15, 90], SIZ: [40, 90], INT: [40, 90], EDU: [40, 90] };
const NPC_RANGE = [1, 200];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));
const s = (v, n = 80) => String(v ?? "").trim().slice(0, n);

export function buildAndDamage(str, siz) {
  const t = str + siz;
  if (t <= 64) return { build: -2, db: "-2" };
  if (t <= 84) return { build: -1, db: "-1" };
  if (t <= 124) return { build: 0, db: "0" };
  if (t <= 164) return { build: 1, db: "+1D4" };
  if (t <= 204) return { build: 2, db: "+1D6" };
  const extra = Math.floor((t - 205) / 80);
  return { build: 3 + extra, db: `+${2 + extra}D6` };
}

export function derived(ch) {
  const mov = ch.DEX < ch.SIZ && ch.STR < ch.SIZ ? 7 : ch.DEX > ch.SIZ && ch.STR > ch.SIZ ? 9 : 8;
  const hp = Math.floor((ch.CON + ch.SIZ) / 10);
  const mp = Math.floor(ch.POW / 5);
  return { hp, hp_max: hp, mp, mp_max: mp, san: ch.POW, san_max: 99, mov, ...buildAndDamage(ch.STR, ch.SIZ) };
}

// Maps a skill name the model wrote to the platform's name: exact, case-insensitive, or any localized name; family
// specialisations such as "Fighting (Brawl)" or "Science (Chemistry)" are kept when their family is known.
export function skillIndex(rules) {
  const map = new Map();
  for (const sk of rules?.skills ?? []) {
    map.set(sk.name.toLowerCase(), sk.name);
    for (const n of Object.values(sk.names ?? {})) if (n) map.set(String(n).toLowerCase(), sk.name);
  }
  const families = (rules?.families ?? []).map((f) => f.name);
  return (raw) => {
    const name = s(raw, 60);
    if (!name) return null;
    const hit = map.get(name.toLowerCase());
    if (hit) return hit;
    const fam = name.match(/^([^()]+?)\s*\(([^)]+)\)$/);
    if (fam) {
      const family = families.find((f) => f.toLowerCase() === fam[1].trim().toLowerCase());
      const specialty = fam[2].trim();
      if (family) return `${family} (${specialty.charAt(0).toUpperCase()}${specialty.slice(1)})`;
    }
    return map.size === 0 ? name : null;
  };
}

export function normalizeCard(input, { rules, kind = "coplayer" } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const ch = {};
  for (const k of CHARS) {
    const [lo, hi] = kind === "npc" ? NPC_RANGE : RANGE[k];
    const v = Number(src.characteristics?.[k]);
    ch[k] = clamp(Number.isFinite(v) ? v : 50, lo, hi);
  }
  const skillName = skillIndex(rules);
  const skills = {};
  for (const [k, v] of Object.entries(src.skills ?? {})) {
    const name = skillName(k);
    if (!name || !Number.isFinite(Number(v))) continue;
    skills[name] = clamp(v, 0, kind === "npc" ? 200 : 99);
  }
  if (skills["Cthulhu Mythos"] && kind !== "npc") skills["Cthulhu Mythos"] = Math.min(skills["Cthulhu Mythos"], 10);
  const d = derived(ch);
  if (skills["Cthulhu Mythos"]) d.san_max = 99 - skills["Cthulhu Mythos"];
  const basic = {};
  for (const k of ["player", "occupation", "age", "sex", "residence", "birthplace"]) basic[k] = s(src.basic?.[k]);
  const background = {};
  for (const k of ["personal_description", "ideology", "significant_people", "meaningful_locations", "treasured_possessions", "traits", "injuries", "phobias", "arcane", "encounters"]) background[k] = s(src.background?.[k], 2000);
  const items = (Array.isArray(src.items) ? src.items : []).slice(0, 30)
    .map((it) => (typeof it === "string" ? { name: s(it), note: "", qty: 1 } : { name: s(it?.name), note: s(it?.note, 300), qty: clamp(it?.qty ?? 1, 0, 9999) }))
    .filter((it) => it.name);
  const wealth = {};
  for (const k of ["cash", "assets", "spending_level"]) wealth[k] = s(src.wealth?.[k], 120);
  const card = { basic, characteristics: ch, derived: d, skills, background, items, wealth };
  if (src.career && typeof src.career === "object" && src.career.name) card.career = { name: s(src.career.name), choices: src.career.choices ?? [], specialties: src.career.specialties ?? [] };
  if (src.skill_points && typeof src.skill_points === "object") card.skill_points = src.skill_points;
  return card;
}

function rulesSummary(rules, pointsMode) {
  const skills = (rules?.skills ?? []).map((x) => `${x.name} (${x.base})`).join(", ");
  const families = (rules?.families ?? []).map((x) => `${x.name} (…)`).join(", ");
  let out = `PLATFORM SKILL NAMES (use exactly these, with base values): ${skills}\nSKILL FAMILIES (write "Family (Specialty)"): ${families}`;
  if (pointsMode) {
    out += `\nPOINT-BUY IS ON: choose a career matching the investigator and give role_card.career: {"id": its numeric id from CAREERS, "name": its exact name field from CAREERS, "choices": [], "specialties": []}. Career skill allocation will be requested separately with that career's full formula and options.\nCAREERS: ${careerCatalog(rules)}`;
  }
  return out;
}

const CARD_SHAPE = `{"name": string, "persona": string (2-4 sentences: temperament, motive, how they play at the table), "speaking_style": string (short), "appearance_prompt": string (visible appearance, max 1000 characters), "role_card": {"basic": {"player","occupation","age","sex","residence","birthplace"}, "characteristics": {"STR","CON","SIZ","DEX","APP","INT","POW","EDU","LUK"}, "skills": {"<skill name>": number}, "background": {"personal_description","ideology","significant_people","meaningful_locations","treasured_possessions","traits","injuries","phobias","arcane","encounters"}, "items": [{"name","note","qty"}], "wealth": {"cash","assets","spending_level"}}}`;

function validateCard(x) {
  if (!x || typeof x !== "object" || !s(x.name) || !x.role_card || typeof x.role_card !== "object") throw new Error("name and role_card are required");
  const missing = missingDetails(x);
  if (missing.length) throw new Error(`Fill the missing fields: ${missing.join(', ')}`);
  return x;
}

// The CoC card functions as a rules profile sees them (rules/coc7e.mjs): the shape the model is asked for, the
// creation hint, the rules summary, what is missing, normalisation, the local check (none: the platform owns the
// COC7 point formula), the generated card's validation, the point-buy repair and the completion prompt.
export const COC_CARD = Object.freeze({
  shape: CARD_SHAPE,
  creationHint: () => "Use COC7 creation values: STR CON DEX APP POW LUK 15-90, SIZ INT EDU 40-90, occupation skills at 40-75, a few hobby skills at 20-50.",
  rulesSummary: (rules, pointsMode) => rulesSummary(rules, pointsMode),
  missingDetails: (character, { pointsMode = false, rules = null } = {}) => [...missingDetails(character), ...(pointsMode && !findCareer(rules, character?.role_card?.career?.name) ? ["role_card.career"] : [])],
  normalize: (roleCard, { rules, kind }) => normalizeCard(roleCard, { rules, kind }),
  check: () => ({ violations: [], spent: 0 }),
  validateGenerated: (x, { rules, pointsMode } = {}) => {
    validateCard(x);
    if (pointsMode) {
      const career = findCareer(rules, x.role_card.career);
      if (!career) throw new Error(`Choose role_card.career.id and name from CAREERS; received ${JSON.stringify(x.role_card.career)}`);
      x.role_card.career.name = career.name;
    }
    return x;
  },
  needsRepair: (card, rules, report) => needsPointBuy(card, rules, report),
  repair: (llm, card, { rules, language, feedback }) => allocatePointBuy(llm, card, { rules, language, feedback }),
  completion: {
    system: (language) => `Complete ONLY the requested missing fields of this existing COC7 investigator. Preserve the existing identity, appearance, background, characteristic values and occupation. Write text in ${language}. Reply with {"appearance_prompt":"...", "role_card":{"basic":{...},"characteristics":{...},"background":{...},"career":{"id":123,"name":"...","choices":[],"specialties":[]}}}, including the missing fields only. appearance_prompt describes stable visible age, build, face, hair, clothing and accessories consistent with the card and era (max 1000 characters). Missing characteristics use COC7 creation ranges (15–90; SIZ/INT/EDU 40–90). Use a localized 'None' for absent injuries, phobias, magic and Mythos encounters; do not invent them. basic.player is AI co-player. If a career is requested, choose a matching entry from CAREERS and copy its numeric id and exact name field; do not invent a synonym for the name.`,
    check: (path, v, rules) => {
      if (path === 'role_card.career') {
        const career = findCareer(rules, v);
        if (!career) throw new Error(`Choose role_card.career with a numeric id and exact name from CAREERS; received ${JSON.stringify(v)}`);
        if (v && typeof v === 'object') v.name = career.name;   // the canonical name, whatever synonym the model wrote
        return;
      }
      if (path.startsWith('role_card.characteristics.')) {
        const minimum = ['SIZ', 'INT', 'EDU'].includes(path.split('.').at(-1)) ? 40 : 15;
        if (!Number.isInteger(v) || v < minimum || v > 90) throw new Error(`${path} must be ${minimum}–90`);
      } else if (typeof v !== 'string' || !v.trim()) throw new Error(`Missing text: ${path}`);
    },
  },
  appearanceNote: APPEARANCE,
});
// The default profile for the functions below when none is given (tests, older callers): the CoC words and card.
const DEFAULT = { id: "coc7e", vocab: COC_VOCAB, card: COC_CARD };
const brief = (profile) => profile.vocab.gmShort.toUpperCase();

// One co-player: a fellow investigator who plays alongside the real players.
// `world` (improvisation mode) is the setting the investigator comes from: their persona and background are written
// into it. `profile` is the rules profile; `level` the level of a new D&D character.
export async function generateCoplayer(llm, { language, era, rules, pointsMode, takenNames, partyNotes, index, total, world = "", profile = DEFAULT, level = 1, log = () => {} }) {
  const { vocab, card: C } = profile;
  const system = `You create ${vocab.pc} characters for ${vocab.campaign}. They are co-players: AI-played ${vocab.pcs} who join the human players' party as equals. Make them distinct, playable and grounded in the ${profile.id === "coc7e" ? "era; no Mythos knowledge beyond a trace" : "world"}. Write every text field in ${language}. Reply with only one JSON object of this shape: ${C.shape}`;
  const user = [
    `CAMPAIGN ERA: ${era || (profile.id === "coc7e" ? "1920s" : "(not set)")}`,
    `CO-PLAYER: ${index + 1} of ${total}`,
    `TAKEN NAMES: ${takenNames.join(", ")}`,
    partyNotes ? `THE PARTY SO FAR:\n${partyNotes}` : "",
    world ? `WORLD SETTING (there is no module: the story is improvised in this world). Make the ${vocab.pc} someone from it: a full personality in the persona and a background story rooted in its places, people and tensions:\n${world}` : "",
    C.creationHint(level),
    C.rulesSummary(rules, pointsMode, level),
  ].filter(Boolean).join("\n");
  const generated = await completeJson(llm, { system: system + '\n' + C.appearanceNote, user, purpose: "coplayer_card" }, (x) => C.validateGenerated(x, { rules, pointsMode }));
  if (profile.id === "coc7e") { if (pointsMode) generated.role_card = await allocatePointBuy(llm, normalizeCard(generated.role_card, { rules }), { rules, language }); return generated; }
  generated.role_card = await checkedBuild(llm, C.normalize(generated.role_card, { rules, kind: "coplayer", level, pointsMode }), { profile, rules, language, pointsMode, level, log, who: generated.name });
  return generated;
}

// A D&D build checked locally against the platform's rules, repaired once by the model when it breaks them; a build
// that still breaks them is refused under point buy (the platform would), and saved as it is otherwise.
async function checkedBuild(llm, card, { profile, rules, language, pointsMode, level, log, who }) {
  let { violations } = profile.card.check(card, rules);
  if (!violations.length) return card;
  log(`${who}: the build breaks the rules (${violations.map((v) => v.code).join(", ")}); asking for a repair`);
  const fixed = await profile.card.repair(llm, card, { rules, language, level, feedback: JSON.stringify(violations) });
  violations = profile.card.check(fixed, rules).violations;
  if (!violations.length) return fixed;
  if (pointsMode) throw new Error(`${who}'s build still breaks the rules: ${violations.map((v) => v.message).join(" ")}`);
  log(`${who}: saved with a build outside the rules (${violations.map((v) => v.code).join(", ")}); point buy is off`);
  return fixed;
}

// A real NPC the GM introduces in play; it is written from the GM's brief and the GM context.
export async function generateNpc(llm, { language, era, rules, name, brief: gmBrief, gmContext, profile = DEFAULT, pointsMode = false, log = () => {} }) {
  const { vocab, card: C } = profile;
  const system = `You are the ${vocab.gm}'s assistant in ${vocab.campaign}. Write the role card of a non-player character the ${vocab.gm} is introducing. Keep it consistent with the ${vocab.gm}'s notes. Write every text field in ${language}. Reply with only one JSON object of this shape: ${C.shape}`;
  const user = [`CAMPAIGN ERA: ${era || (profile.id === "coc7e" ? "1920s" : "(not set)")}`, `NPC NAME: ${name}`, `${brief(profile)}'S BRIEF: ${gmBrief || "(none)"}`, gmContext ? `${brief(profile)} CONTEXT:\n${gmContext}` : "", ...(profile.id === "coc7e" ? [] : [C.creationHint(1)]), C.rulesSummary(rules, profile.id === "coc7e" ? false : pointsMode, 1)].filter(Boolean).join("\n");
  const generated = await completeJson(llm, { system: system + '\n' + C.appearanceNote, user, purpose: "npc_card" }, (x) => C.validateGenerated(x, { rules, pointsMode: false }));
  if (profile.id !== "coc7e") generated.role_card = await checkedBuild(llm, C.normalize(generated.role_card, { rules, kind: "npc", level: null, pointsMode }), { profile, rules, language, pointsMode, level: 1, log, who: generated.name });
  return generated;
}

// The server is authoritative for career options, specialty bases and point budgets.
// Repair rejected allocations twice, but never silently discard career/point data.
export async function putCardWithPoints(api, channelId, characterId, card, { head = {}, llm, rules, language, pointsMode, profile = DEFAULT, level } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const saved = await api.putCard(channelId, characterId, { ...head, role_card: card });
      return saved?.character?.role_card ?? card;
    } catch (e) {
      if (e.code !== 'points_rule' || !pointsMode || !llm || attempt >= 2) throw e;
      card = await profile.card.repair(llm, card, { rules, language, level, feedback: e.message });
    }
  }
}

export async function saveCharacter(api, channelId, generated, { kind, rules, llm, language, pointsMode = false, profile = DEFAULT, level }) {
  // A D&D card was normalised and checked when it was generated; a CoC card is normalised here.
  const card = profile.id === "coc7e" ? normalizeCard(generated.role_card, { rules, kind }) : generated.role_card;
  // A co-player is a GM-cast PC: a PC the GM account owns (the platform makes the creator the owner).
  const style = s(generated.speaking_style, 300);
  const bio = s(generated.persona ?? generated.brief, 6000);
  const ch = await api.createCharacter(channelId, { name: s(generated.name), kind: kind === "coplayer" ? "pc" : "npc", speaking_style: style, description: bio.slice(0, 500) });
  const savedCard = await putCardWithPoints(api, channelId, ch.id, card, {
    head: { name: s(generated.name), speaking_style: style, bio }, rules, llm, language, pointsMode, profile, level,
  });
  await api.putAppearance(channelId, ch.id, { appearance_prompt: s(generated.appearance_prompt, 1000) });
  return { id: ch.id, name: s(generated.name), persona: bio, speakingStyle: s(generated.speaking_style, 300), card: savedCard };
}
