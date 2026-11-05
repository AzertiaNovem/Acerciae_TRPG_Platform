import { completeJson } from '../llm/index.mjs';
import { COC_CARD, derived, putCardWithPoints } from './cardgen.mjs';
import { careerCatalog } from './pointbuy.mjs';
import { COC_VOCAB } from '../rules/vocab.mjs';
import { deriveDnd } from './dndcard.mjs';

const get = (value, path) => path.split('.').reduce((v, key) => v?.[key], value);
function set(value, path, next) {
  const keys = path.split('.');
  for (const key of keys.slice(0, -1)) {
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) value[key] = {};
    value = value[key];
  }
  value[keys.at(-1)] = next;
}
const DEFAULT = { id: "coc7e", vocab: COC_VOCAB, card: COC_CARD };
// JSON with sorted keys: the platform returns a card's keys in its own order, so a card is "changed" only by its values.
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

// The lists the completion prompt gives the model for the paths it must fill (CoC: the careers; D&D: the build lists).
function lists(profile, rules, missing) {
  if (profile.id === "coc7e") return missing.includes('role_card.career') ? `CAREERS: ${careerCatalog(rules)}` : '';
  return missing.some((p) => p.startsWith('role_card.dnd.')) ? profile.card.rulesSummary(rules, false, 1) : '';
}

// Check the platform's saved card, not just the local roster. This also resumes
// a previous setup that created an NPC but failed before finishing its card.
// `profile` is the rules profile (rules/*.mjs); `level` is only read for a D&D card that has none.
export async function completeExistingCharacter(api, llm, channelId, characterId, { rules, language, era, pointsMode, world = "", profile = DEFAULT, level = 1, log = () => {} }) {
  const C = profile.card;
  let space = await api.characterSpace(channelId, characterId);
  let current = space.character;
  const missing = C.missingDetails(current, { pointsMode, rules });
  let patch;
  if (missing.length) {
    log(`checking ${current.name}: filling ${missing.join(', ')}`);
    patch = await completeJson(llm, {
      system: C.completion.system(language),
      user: `ERA: ${era || (profile.id === "coc7e" ? '1920s' : '(not set)')}\n${world ? `WORLD SETTING (write missing background into this world):\n${world}\n` : ''}MISSING: ${JSON.stringify(missing)}\nEXISTING: ${JSON.stringify({ name: current.name, bio: current.bio, appearance_prompt: current.appearance_prompt, role_card: current.role_card })}\n${lists(profile, rules, missing)}`,
      purpose: 'coplayer_repair',
    }, (value) => {
      for (const path of missing) {
        const v = get(value, path);
        C.completion.check(path, v, rules);
      }
      return value;
    });
    // A human may have filled fields during a long model call. Re-read and retain them.
    space = await api.characterSpace(channelId, characterId);
    current = space.character;
  }
  const baseline = stable(current.role_card);
  const next = structuredClone(current);
  const stillMissing = new Set(C.missingDetails(current, { pointsMode, rules }));
  for (const path of missing) if (stillMissing.has(path)) set(next, path, get(patch, path));
  next.role_card ??= {};
  let card = next.role_card;
  if (profile.id === "coc7e") {
    // Fill derived defaults only; preserve current HP/SAN and other in-play values.
    if (card.characteristics && ['STR', 'DEX', 'SIZ', 'CON', 'POW'].every((k) => Number.isFinite(card.characteristics[k]))) {
      card.derived ??= {};
      for (const [key, value] of Object.entries(derived(card.characteristics))) {
        if (card.derived[key] === undefined || card.derived[key] === null || card.derived[key] === '') card.derived[key] = value;
      }
    }
  } else {
    // D&D: the build's computed values (saves, HP, AC, speed, hit dice, slots) are filled only where missing or 0,
    // so a character shaped by play keeps its own. Live HP, slots and death saves are sheet attributes, never here.
    card.dnd = { ...(card.dnd ?? {}) };
    if (!(Number(card.dnd.level) >= 1)) card.dnd.level = level;
    // With point buy off, an existing character's own scores and method stand (the "npc" ranges allow any).
    card.dnd = deriveDnd(C.normalize({ ...card, dnd: card.dnd }, { rules, kind: pointsMode ? "coplayer" : "npc", level: card.dnd.level, pointsMode }).dnd, rules);
  }
  if (pointsMode && C.needsRepair(card, rules, space.points)) {
    log(`checking ${current.name}: ${profile.id === "coc7e" ? "choosing career skills and allocating points" : "repairing the build"}`);
    card = await C.repair(llm, card, { rules, language, level: card.dnd?.level, feedback: JSON.stringify(space.points ?? {}) });
  }
  const cardChanged = stable(card) !== baseline;
  const appearanceChanged = next.appearance_prompt !== current.appearance_prompt;
  if (!cardChanged && !appearanceChanged) { log(`checked ${current.name}: complete, skipped`); return false; }
  const latest = (await api.characterSpace(channelId, characterId)).character;
  if (stable(latest.role_card) !== baseline) throw new Error(`${current.name}'s card changed during generation; run setup again to preserve those edits`);
  if (cardChanged) await putCardWithPoints(api, channelId, characterId, card, { rules, llm, language, pointsMode, profile, level: card.dnd?.level });
  if (appearanceChanged && !String(latest.appearance_prompt ?? '').trim()) {
    await api.putAppearance(channelId, characterId, { appearance_prompt: next.appearance_prompt.trim().slice(0, 1000) });
  }
  log(`completed missing fields for ${current.name}`);
  return true;
}
