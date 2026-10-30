// Role cards written by the model: co-players (fellow investigators) at setup, real NPCs on demand. The model's card is
// checked against COC7 before it is saved: characteristics clamped to the creation ranges, derived values computed,
// skill names matched to the platform's list (GET /api/coc7/rules), so the platform's dice read it correctly.
import { completeJson } from "../llm/index.mjs";
import { markStyle } from "./roster.mjs";
import { allocatePointBuy, careerCatalog, findCareer } from "./pointbuy.mjs";

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

// One co-player: a fellow investigator who plays alongside the real players.
export async function generateCoplayer(llm, { language, era, rules, pointsMode, takenNames, partyNotes, index, total }) {
  const system = `You create investigator characters for a Call of Cthulhu 7th edition campaign. They are co-players: AI-played investigators who join the human players' party as equals. Make them distinct, playable and grounded in the era; no Mythos knowledge beyond a trace. Write every text field in ${language}. Reply with only one JSON object of this shape: ${CARD_SHAPE}`;
  const user = [
    `CAMPAIGN ERA: ${era || "1920s"}`,
    `CO-PLAYER: ${index + 1} of ${total}`,
    `TAKEN NAMES: ${takenNames.join(", ")}`,
    partyNotes ? `THE PARTY SO FAR:\n${partyNotes}` : "",
    "Use COC7 creation values: STR CON DEX APP POW LUK 15-90, SIZ INT EDU 40-90, occupation skills at 40-75, a few hobby skills at 20-50.",
    rulesSummary(rules, pointsMode),
  ].filter(Boolean).join("\n");
  const generated = await completeJson(llm, { system: system + '\n' + APPEARANCE, user, purpose: "coplayer_card" }, (x) => {
    validateCard(x);
    if (pointsMode) {
      const career = findCareer(rules, x.role_card.career);
      if (!career) throw new Error(`Choose role_card.career.id and name from CAREERS; received ${JSON.stringify(x.role_card.career)}`);
      x.role_card.career.name = career.name;
    }
    return x;
  });
  if (pointsMode) generated.role_card = await allocatePointBuy(llm, normalizeCard(generated.role_card, { rules }), { rules, language });
  return generated;
}

// A real NPC the Keeper introduces in play; it is written from the GM's brief and the GM context.
export async function generateNpc(llm, { language, era, rules, name, brief, gmContext }) {
  const system = `You are the Keeper's assistant in a Call of Cthulhu 7th edition campaign. Write the role card of a non-player character the Keeper is introducing. Keep it consistent with the Keeper's notes. Write every text field in ${language}. Reply with only one JSON object of this shape: ${CARD_SHAPE}`;
  const user = [`CAMPAIGN ERA: ${era || "1920s"}`, `NPC NAME: ${name}`, `KEEPER'S BRIEF: ${brief || "(none)"}`, gmContext ? `KEEPER CONTEXT:\n${gmContext}` : "", rulesSummary(rules, false)].filter(Boolean).join("\n");
  return completeJson(llm, { system: system + '\n' + APPEARANCE, user, purpose: "npc_card" }, validateCard);
}

// The server is authoritative for career options, specialty bases and point budgets.
// Repair rejected allocations twice, but never silently discard career/point data.
export async function putCardWithPoints(api, channelId, characterId, card, { head = {}, llm, rules, language, pointsMode } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const saved = await api.putCard(channelId, characterId, { ...head, role_card: card });
      return saved?.character?.role_card ?? card;
    } catch (e) {
      if (e.code !== 'points_rule' || !pointsMode || !llm || attempt >= 2) throw e;
      card = await allocatePointBuy(llm, card, { rules, language, feedback: e.message });
    }
  }
}

export async function saveCharacter(api, channelId, generated, { kind, rules, llm, language, pointsMode = false }) {
  const card = normalizeCard(generated.role_card, { rules, kind });
  const style = kind === "coplayer" ? markStyle(generated.speaking_style) : s(generated.speaking_style, 300);
  const bio = s(generated.persona ?? generated.brief, 6000);
  const ch = await api.createCharacter(channelId, { name: s(generated.name), kind: "npc", speaking_style: style, description: bio.slice(0, 500) });
  const savedCard = await putCardWithPoints(api, channelId, ch.id, card, {
    head: { name: s(generated.name), speaking_style: style, bio }, rules, llm, language, pointsMode,
  });
  await api.putAppearance(channelId, ch.id, { appearance_prompt: s(generated.appearance_prompt, 1000) });
  return { id: ch.id, name: s(generated.name), persona: bio, speakingStyle: s(generated.speaking_style, 300), card: savedCard };
}
