// The investigators' basic details and backgrounds, as written on their role cards (and the character's bio). The GM
// and the real NPCs read every investigator's profile; a co-player reads its companions' profiles, the way a human
// player can open any player character's page. Real NPCs are never investigators, and characteristics and skills are
// not part of a profile.

const BASIC = ["player", "occupation", "age", "sex", "residence", "birthplace"];
const BACKGROUND = ["personal_description", "ideology", "significant_people", "meaningful_locations", "treasured_possessions", "traits", "injuries", "phobias", "arcane", "encounters"];
const FIELD_MAX = 400;
const PROFILE_MAX = 2000;

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const label = (k) => k.replace(/_/g, " ");

// The profile lines under a character's name: empty fields are left out, so a blank card gives no lines.
export function investigatorProfile(character) {
  const card = character?.role_card && typeof character.role_card === "object" ? character.role_card : {};
  const lines = [];
  const basic = BASIC.map((k) => [k, clip(card.basic?.[k], FIELD_MAX)]).filter(([, v]) => v);
  if (basic.length) lines.push(basic.map(([k, v]) => `${label(k)}: ${v}`).join("; "));
  const bio = clip(character?.bio, FIELD_MAX);
  if (bio) lines.push(`bio: ${bio}`);
  for (const k of BACKGROUND) { const v = clip(card.background?.[k], FIELD_MAX); if (v) lines.push(`${label(k)}: ${v}`); }
  let total = 0;
  return lines.filter((l) => (total += l.length) <= PROFILE_MAX);
}

// Renders a list entry: "- Name (note)" followed by its indented profile lines.
export function renderProfile(character, note = "") {
  return [`- ${character.name}${note ? ` (${note})` : ""}`, ...investigatorProfile(character).map((l) => `    ${l}`)].join("\n");
}

// The investigators at the table: player characters first, then co-players; never real NPCs.
export function investigatorsFor(characters, roster, { except } = {}) {
  const others = characters.filter((c) => c.id !== except);
  return [...others.filter((c) => c.kind === "pc"), ...others.filter((c) => c.kind !== "pc" && roster.isCoplayer(c.id))];
}
