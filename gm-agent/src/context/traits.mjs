// What anyone who knows a character would notice: its most distinctive characteristics, in words, never numbers
// ("extremely good-looking", "slow-witted"). Only the extremes are named. Call of Cthulhu: 80 and above, or near the
// bottom of the range (25 for the 3d6×5 characteristics, 45 for SIZ, INT and EDU, which start at 40); Luck is not
// something one sees, so it is left out. D&D (a card with a build in role_card.dnd): final ability scores of 18 and
// above, or 7 and below.
import { ABILITIES, scores } from "../roles/dndcard.mjs";

const TRAITS = {
  APP: ["extremely good-looking, striking", "very plain, unattractive", 25],
  INT: ["extremely intelligent", "slow-witted", 45],
  STR: ["extremely strong", "physically weak", 25],
  SIZ: ["very large, imposing build", "very small, slight build", 45],
  DEX: ["extremely agile and quick", "clumsy and slow", 25],
  CON: ["extremely robust, hardly ever ill", "frail and sickly", 25],
  POW: ["extremely strong-willed, a forceful presence", "weak-willed, easily swayed", 25],
  EDU: ["extremely well educated, erudite", "little formal education", 45],
};
export const COC_TRAITS = Object.freeze({ high: 80, table: TRAITS });
export const DND_TRAITS = Object.freeze({
  high: 18,
  table: {
    STR: ["extremely strong", "physically weak", 7],
    DEX: ["extremely agile and quick", "clumsy and slow", 7],
    CON: ["extremely tough, hardly ever ill", "frail and sickly", 7],
    INT: ["extremely intelligent", "slow-witted", 7],
    WIS: ["extremely wise and perceptive", "oblivious, poor judgement", 7],
    CHA: ["extremely charismatic, magnetic", "awkward, off-putting", 7],
  },
});

// Up to `max` traits, the most extreme first. `card` is a role card (characteristics as numbers or numeric strings).
export function distinctiveTraits(card, { max = 3 } = {}) {
  const dnd = card?.dnd && typeof card.dnd === "object" && card.dnd.base && typeof card.dnd.base === "object" && ABILITIES.some((ab) => Number.isFinite(Number(card.dnd.base[ab])));
  const { high: HIGH, table } = dnd ? DND_TRAITS : COC_TRAITS;
  const ch = dnd ? scores(card.dnd) : card?.characteristics && typeof card.characteristics === "object" ? card.characteristics : {};
  const found = [];
  for (const [key, [high, low, floor]] of Object.entries(table)) {
    const raw = ch[key] ?? ch[key.toLowerCase()];
    const v = Number(typeof raw === "object" && raw !== null ? raw.value : raw);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (v >= HIGH) found.push({ text: high, weight: v - HIGH + 1 });
    else if (v <= floor) found.push({ text: low, weight: floor - v + 1 });
  }
  return found.sort((a, b) => b.weight - a.weight).slice(0, max).map((t) => t.text);
}

// "female, 31" from a role card's basic details (gender and age; empty when neither is known).
export function genderAge(card) {
  const b = card?.basic ?? {};
  return [String(b.sex ?? b.gender ?? "").trim(), String(b.age ?? "").trim()].filter(Boolean).join(", ");
}

// "(female, 31; extremely good-looking, striking)" or "".
export function impression(card) {
  const ga = genderAge(card);
  const traits = distinctiveTraits(card).join("; ");
  const inner = [ga, traits].filter(Boolean).join("; ");
  return inner ? `(${inner})` : "";
}
