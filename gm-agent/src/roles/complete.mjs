import { completeJson } from '../llm/index.mjs';
import { derived, missingDetails, putCardWithPoints } from './cardgen.mjs';
import { allocatePointBuy, careerCatalog, findCareer, needsPointBuy } from './pointbuy.mjs';

const get = (value, path) => path.split('.').reduce((v, key) => v?.[key], value);
function set(value, path, next) {
  const keys = path.split('.');
  for (const key of keys.slice(0, -1)) {
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) value[key] = {};
    value = value[key];
  }
  value[keys.at(-1)] = next;
}

// Check the platform's saved card, not just the local roster. This also resumes
// a previous setup that created an NPC but failed before finishing its card.
export async function completeExistingCharacter(api, llm, channelId, characterId, { rules, language, era, pointsMode, log = () => {} }) {
  let space = await api.characterSpace(channelId, characterId);
  let current = space.character;
  const missing = missingDetails(current);
  if (pointsMode && !findCareer(rules, current.role_card?.career?.name)) missing.push('role_card.career');
  let patch;
  if (missing.length) {
    log(`checking ${current.name}: filling ${missing.join(', ')}`);
    patch = await completeJson(llm, {
      system: `Complete ONLY the requested missing fields of this existing COC7 investigator. Preserve the existing identity, appearance, background, characteristic values and occupation. Write text in ${language}. Reply with {"appearance_prompt":"...", "role_card":{"basic":{...},"characteristics":{...},"background":{...},"career":{"id":123,"name":"...","choices":[],"specialties":[]}}}, including the missing fields only. appearance_prompt describes stable visible age, build, face, hair, clothing and accessories consistent with the card and era (max 1000 characters). Missing characteristics use COC7 creation ranges (15–90; SIZ/INT/EDU 40–90). Use a localized 'None' for absent injuries, phobias, magic and Mythos encounters; do not invent them. basic.player is AI co-player. If a career is requested, choose a matching entry from CAREERS and copy its numeric id and exact name field; do not invent a synonym for the name.`,
      user: `ERA: ${era || '1920s'}\nMISSING: ${JSON.stringify(missing)}\nEXISTING: ${JSON.stringify({ name: current.name, bio: current.bio, appearance_prompt: current.appearance_prompt, role_card: current.role_card })}\n${missing.includes('role_card.career') ? `CAREERS: ${careerCatalog(rules)}` : ''}`,
      purpose: 'coplayer_repair',
    }, (value) => {
      for (const path of missing) {
        const v = get(value, path);
        if (path === 'role_card.career') {
          const career = findCareer(rules, v);
          if (!career) throw new Error(`Choose role_card.career with a numeric id and exact name from CAREERS; received ${JSON.stringify(v)}`);
          value.role_card.career.name = career.name;
        } else if (path.startsWith('role_card.characteristics.')) {
          const minimum = ['SIZ', 'INT', 'EDU'].includes(path.split('.').at(-1)) ? 40 : 15;
          if (!Number.isInteger(v) || v < minimum || v > 90) throw new Error(`${path} must be ${minimum}–90`);
        } else if (typeof v !== 'string' || !v.trim()) throw new Error(`Missing text: ${path}`);
      }
      return value;
    });
    // A human may have filled fields during a long model call. Re-read and retain them.
    space = await api.characterSpace(channelId, characterId);
    current = space.character;
  }
  const baseline = JSON.stringify(current.role_card);
  const next = structuredClone(current);
  const stillMissing = new Set(missingDetails(current));
  if (pointsMode && !findCareer(rules, current.role_card?.career?.name)) stillMissing.add('role_card.career');
  for (const path of missing) if (stillMissing.has(path)) set(next, path, get(patch, path));
  next.role_card ??= {};
  let card = next.role_card;
  // Fill derived defaults only; preserve current HP/SAN and other in-play values.
  if (card.characteristics && ['STR', 'DEX', 'SIZ', 'CON', 'POW'].every((k) => Number.isFinite(card.characteristics[k]))) {
    card.derived ??= {};
    for (const [key, value] of Object.entries(derived(card.characteristics))) {
      if (card.derived[key] === undefined || card.derived[key] === null || card.derived[key] === '') card.derived[key] = value;
    }
  }
  if (pointsMode && needsPointBuy(card, rules, space.points)) {
    log(`checking ${current.name}: choosing career skills and allocating points`);
    card = await allocatePointBuy(llm, card, { rules, language, feedback: JSON.stringify(space.points ?? {}) });
  }
  const cardChanged = JSON.stringify(card) !== baseline;
  const appearanceChanged = next.appearance_prompt !== current.appearance_prompt;
  if (!cardChanged && !appearanceChanged) { log(`checked ${current.name}: complete, skipped`); return false; }
  const latest = (await api.characterSpace(channelId, characterId)).character;
  if (JSON.stringify(latest.role_card) !== baseline) throw new Error(`${current.name}'s card changed during generation; run setup again to preserve those edits`);
  if (cardChanged) await putCardWithPoints(api, channelId, characterId, card, { rules, llm, language, pointsMode });
  if (appearanceChanged && !String(latest.appearance_prompt ?? '').trim()) {
    await api.putAppearance(channelId, characterId, { appearance_prompt: next.appearance_prompt.trim().slice(0, 1000) });
  }
  log(`completed missing fields for ${current.name}`);
  return true;
}
