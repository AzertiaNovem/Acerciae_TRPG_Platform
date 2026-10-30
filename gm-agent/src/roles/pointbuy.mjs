import { completeJson } from "../llm/index.mjs";

export function findCareer(rules, value) {
  const name = typeof value === 'object' ? value?.name : value;
  const id = typeof value === 'object' ? value?.id : undefined;
  const norm = (v) => String(v ?? '').normalize('NFKC').trim().toLowerCase();
  return rules?.careers?.find((c) => (id !== undefined && c.id !== undefined && String(c.id) === String(id))
    || norm(c.name) === norm(name) || Object.values(c.names ?? {}).some((v) => norm(v) === norm(name))
    || (c.names?.en && norm(`${c.name} (${c.names.en})`) === norm(name)));
}

export function careerCatalog(rules) {
  return JSON.stringify((rules?.careers ?? []).map((c) => ({ id: c.id, name: c.name, english: c.names?.en })));
}

export function needsPointBuy(card, rules, report) {
  const entries = Object.values(card?.skill_points ?? {});
  return !findCareer(rules, card?.career?.name) || !entries.length
    || !entries.some((p) => Number(p.career) > 0) || !entries.some((p) => Number(p.hobby) > 0)
    || !!report?.violations?.length || !!report?.warnings?.some((w) => w.code === "credit_rating");
}

// Give the model only the selected career's full rules, rather than 230 full career records.
export async function allocatePointBuy(llm, card, { rules, language, feedback = "" }) {
  const career = findCareer(rules, card.career?.name);
  if (!career) throw new Error("Choose a known career before allocating COC7 skill points");
  const chars = card.characteristics;
  const careerBudget = career.points.reduce((sum, term) => sum + Math.max(...term.attrs.map((k) => Number(chars[k]) || 0)) * term.mult, 0);
  const hobbyBudget = (Number(chars.INT) || 0) * 2;
  const growth = Object.fromEntries(Object.entries(card.skill_points ?? {}).filter(([, p]) => Number(p.growth) > 0).map(([k, p]) => [k, p]));
  const spec = ({ skill, spec, any }) => ({ skill, ...(spec ? { spec } : {}), ...(any ? { any } : {}) });
  const rulesText = JSON.stringify({
    career: { name: career.name, formula: career.formula, points: career.points, fixed: career.fixed.map(spec),
      choices: career.choices.map((g) => ({ pick: g.pick, from: g.from.map(spec) })), free: career.free, credit: career.credit },
    career_budget: careerBudget, hobby_budget: hobbyBudget,
    skills: rules.skills.map(({ name, base }) => ({ name, base })),
    families: rules.families.map(({ name, base }) => ({ name, base })),
  });
  const allocation = await completeJson(llm, {
    system: `Allocate COC7 career and hobby points using the exact platform rules. Keep the character's characteristics and identity unchanged. Reply only with {"career":{"name":"${career.name}","choices":[["skill"]],"specialties":["skill"]},"skill_points":{"<canonical skill>":{"career":integer,"hobby":integer}}}.
Career points are purchased increments, NOT final skill totals. Spend the career budget on fixed skills, the selected option of each choice group, free specialties (at most free), and Credit Rating. Every group has its own array in career.choices, at the same index; choose up to pick entries. Specializations use the supplied skill family and exact spec text, or choose a concrete specialization when any=true. Hobby points may go to other skills. Use canonical skill keys. Do not buy Cthulhu Mythos. Do not invent growth points. Final values (base + career + hobby + existing growth) must not exceed 99. Dodge base is floor(DEX/2); Language (Own) base is EDU. Credit Rating uses base 0 and must lie within the career's credit range. Aim to use both budgets fully, never exceed them. Preserve the concept and existing skill preferences. Narrative language is ${language}.`,
    user: `RULES: ${rulesText}\nEXISTING CARD: ${JSON.stringify(card)}\n${feedback ? `PLATFORM VALIDATION: ${feedback}` : ""}`,
    purpose: "coplayer_points",
  }, (value) => {
    if (!value?.career || !Array.isArray(value.career.choices) || !Array.isArray(value.career.specialties)
      || !value.skill_points || typeof value.skill_points !== "object" || Array.isArray(value.skill_points)) throw new Error("career choices, specialties and skill_points are required");
    let c = 0, h = 0;
    for (const [key, p] of Object.entries(value.skill_points)) {
      if (!p || !Number.isInteger(p.career) || !Number.isInteger(p.hobby) || p.career < 0 || p.hobby < 0) throw new Error(`invalid point increments for ${key}`);
      c += p.career; h += p.hobby;
    }
    if (c <= 0 || c > careerBudget || h <= 0 || h > hobbyBudget) throw new Error(`career spent ${c}/${careerBudget}, hobby spent ${h}/${hobbyBudget}; both must be positive and within budget`);
    if (career.credit) {
      const cr = value.skill_points['Credit Rating'];
      const total = (cr?.career ?? 0) + (cr?.hobby ?? 0) + (growth['Credit Rating']?.growth ?? 0);
      if (total < career.credit[0] || total > career.credit[1]) throw new Error(`Credit Rating must be ${career.credit.join('–')}, got ${total}`);
    }
    return value;
  });
  // Growth is Keeper-authored. Ignore model-supplied growth and preserve recorded growth.
  const points = Object.fromEntries(Object.entries(allocation.skill_points).map(([key, p]) => [key, {
    career: p.career, hobby: p.hobby, growth: growth[key]?.growth ?? 0,
    ...(card.skill_points?.[key]?.base !== undefined ? { base: card.skill_points[key].base } : {}),
  }]));
  for (const [key, p] of Object.entries(growth)) if (!points[key]) points[key] = { career: 0, hobby: 0, growth: p.growth, ...(p.base !== undefined ? { base: p.base } : {}) };
  return { ...card, career: { ...allocation.career, name: career.name }, skill_points: points,
    // The platform recomputes totals from base + purchased points; do not retain unbudgeted LLM totals.
    skills: {} };
}
