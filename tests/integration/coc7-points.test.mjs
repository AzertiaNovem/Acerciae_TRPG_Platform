import { test } from "node:test";
import assert from "node:assert/strict";
// API_BASE=http://127.0.0.1:8080 node --test tests/integration/coc7-points.test.mjs
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, code: typeof data.error === "string" ? data.error : data.error?.code, body: data });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };

test("COC7 point-buy: a server feature; careers from the list gate career points, hobby points go anywhere, totals reach the dice", async () => {
  const suffix = Math.random().toString(36).slice(2);
  const gm = (await call(null, "POST", "/api/auth/register", { username: "kp" + suffix, password: "password", display_name: "Keeper" })).token;
  const p1 = (await call(null, "POST", "/api/auth/register", { username: "p1" + suffix, password: "password", display_name: "Sofia" })).token;
  const server = await call(gm, "POST", "/api/servers", { name: "Point buy" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Arkham", knowledge_mode: "isolated" })).id;
  await call(gm, "POST", `/api/channels/${ch}/members`, { username: "p1" + suffix, role: "player" });
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada Quill" });
  const space = () => call(p1, "GET", `/api/channels/${ch}/characters/${ada.id}/space`);
  const save = (role_card) => call(p1, "PUT", `/api/channels/${ch}/characters/${ada.id}/card`, { role_card });

  // Off by default: the card takes skill totals directly and no report is produced.
  assert.equal((await call(gm, "GET", `/api/servers/${server.id}/settings`)).features.coc7_points, false);
  assert.equal((await space()).points.enabled, false);
  const chars = { STR: 50, CON: 60, SIZ: 50, DEX: 70, APP: 60, INT: 80, POW: 60, EDU: 75, LUK: 45 };
  const free = await save({ characteristics: chars, skills: { "Spot Hidden": 90, Stealth: 80 }, career: { name: "星际海盗" }, skill_points: { Stealth: { career: 500 } } });
  assert.equal(free.character.role_card.skills["Spot Hidden"], 90);
  assert.equal(free.character.role_card.career.name, "星际海盗", "the card keeps the fields; only the mode enforces them");

  // The maintainer turns the mode on.
  const settings = await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { coc7_points: true } });
  assert.equal(settings.features.coc7_points, true);
  const rules = await call(p1, "GET", "/api/coc7/rules");
  assert.equal(rules.careers.length, 230);
  assert.ok(rules.skills.some((s) => s.name === "Spot Hidden" && s.base === 25) && rules.skills.some((s) => s.name === "Dodge" && s.base === "DEX/2"));
  const accountant = rules.careers.find((c) => c.name === "会计师");
  assert.deepEqual(accountant.credit, [30, 70]); assert.equal(accountant.free, 2); assert.equal(accountant.formula, "教育×4");
  assert.ok(accountant.fixed.some((f) => f.skill === "Spot Hidden" && f.label === "侦查"));
  const hunter = rules.careers.find((c) => c.name === "猎人");
  assert.equal(hunter.choices.length, 2); assert.deepEqual(hunter.points, [{ attrs: ["EDU"], mult: 2 }, { attrs: ["STR", "DEX"], mult: 2 }]);

  // The report on an unsaved-but-stored card: the old card now violates the rules, so the page can show why.
  const stale = (await space()).points;
  assert.equal(stale.enabled, true); assert.equal(stale.hobby_budget, 160);
  assert.ok(stale.violations.some((v) => v.code === "unknown_career"));

  // A valid build: accountant, EDU 75 → 300 career points, INT 80 → 160 hobby points.
  const card = { characteristics: chars, career: { name: "会计师", choices: [], specialties: ["Fighting (Brawl)"] },
    skill_points: { "Spot Hidden": { career: 40 }, "Library Use": { career: 50, hobby: 10 }, "Credit Rating": { career: 40 }, "Fighting (Brawl)": { career: 20 }, Dodge: { hobby: 30 }, "Science (Biology)": { hobby: 19 }, Stealth: { growth: 5 } },
    skills: { "Spot Hidden": 1 } };
  const saved = await save(card);
  const rc = saved.character.role_card;
  assert.equal(rc.skills["Spot Hidden"], 65, "base 25 + 40 career; the direct total sent was ignored");
  assert.equal(rc.skills["Library Use"], 80); assert.equal(rc.skills["Dodge"], 65); assert.equal(rc.skills["Science (Biology)"], 20);
  assert.equal(rc.skills["Stealth"], 20, "a player cannot grant themselves growth points");
  assert.equal(saved.points.career_budget, 300); assert.equal(saved.points.career_spent, 150); assert.equal(saved.points.hobby_spent, 59); assert.equal(saved.points.characteristics_total, 505);
  assert.deepEqual(saved.points.violations, []); assert.deepEqual(saved.points.warnings, []);
  assert.equal(saved.attrs["Spot Hidden"], 65, "dice attributes mirror the computed totals");
  assert.equal(saved.attrs["Dodge"], 65);
  // Growth is the Keeper's to record (improvement checks); the player's next save keeps it.
  const grown = await call(gm, "PUT", `/api/channels/${ch}/characters/${ada.id}/card`, { role_card: card });
  assert.equal(grown.character.role_card.skills["Stealth"], 25);
  const kept = await save({ ...card, skill_points: { ...card.skill_points, Stealth: { growth: 40 } } });
  assert.equal(kept.character.role_card.skills["Stealth"], 25);

  // Limits: career points on a skill outside the career, overspending, too many specialties, a career not in the list.
  const e1 = await rejects(save({ ...card, skill_points: { ...card.skill_points, Stealth: { career: 10 } } }), 400);
  assert.equal(e1.code, "points_rule"); assert.match(e1.body.message, /Stealth is not one of the career's skills/);
  const e2 = await rejects(save({ ...card, skill_points: { ...card.skill_points, "Library Use": { career: 70 }, Law: { career: 60 }, Listen: { career: 60 }, Persuade: { career: 40 } } }), 400);
  assert.match(e2.body.message, /career points 330 exceed the budget 300/);
  const e3 = await rejects(save({ ...card, skill_points: { ...card.skill_points, Dodge: { hobby: 161 } } }), 400);
  assert.match(e3.body.message, /exceed 99|hobby points/);
  await rejects(save({ ...card, career: { name: "会计师", choices: [], specialties: ["Fighting (Brawl)", "Swim", "Climb"] } }), 400);
  await rejects(save({ ...card, career: { name: "星际海盗" } }), 400);
  // The Keeper is held to the same rules in this mode.
  await rejects(call(gm, "PUT", `/api/channels/${ch}/characters/${ada.id}/card`, { role_card: { ...card, skill_points: { ...card.skill_points, Stealth: { career: 10 } } } }), 400);
  // Credit Rating outside the career's range is a warning, not a block.
  const low = await save({ ...card, skill_points: { ...card.skill_points, "Credit Rating": { career: 10 } } });
  assert.ok(low.points.warnings.some((w) => w.code === "credit_rating"));
  // Option groups: a hunter chooses Survival over Language and Listen over Spot Hidden.
  const hunterCard = { characteristics: chars, career: { name: "猎人", choices: [["Survival (Sea)"], ["Listen"]], specialties: [] }, skill_points: { "Survival (Sea)": { career: 20 }, Listen: { career: 10 }, "Firearms (Rifle/Shotgun)": { career: 30 } } };
  const h = await save(hunterCard);
  assert.equal(h.points.career_budget, 290); assert.equal(h.character.role_card.skills["Survival (Sea)"], 30);
  await rejects(save({ ...hunterCard, career: { ...hunterCard.career, choices: [["Survival (Sea)", "Language (Other)"], ["Listen"]] } }), 400);
  const unchosen = await rejects(save({ ...hunterCard, skill_points: { ...hunterCard.skill_points, "Spot Hidden": { career: 10 } } }), 400);
  assert.match(unchosen.body.message, /Spot Hidden is not one of the career's skills/);
  // Off again: the same over-limit card saves without complaint.
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { coc7_points: false } });
  await save({ ...card, skill_points: { ...card.skill_points, Stealth: { career: 10 } } });
});

test("COC7 skill names follow the server language: the sheet gets the names, .ra takes English or that language", async () => {
  const suffix = Math.random().toString(36).slice(2);
  const gm = (await call(null, "POST", "/api/auth/register", { username: "kpja" + suffix, password: "password", display_name: "Keeper" })).token;
  const server = await call(gm, "POST", "/api/servers", { name: "Names" });
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { language: "ja", features: { coc7_points: true } });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Innsmouth" })).id;
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const npc = await call(gm, "POST", `/api/channels/${ch}/characters`, { name: "Aki" });

  const rules = await call(gm, "GET", "/api/coc7/rules");
  const names = (n) => rules.skills.find((s) => s.name === n).names;
  assert.equal(names("Spot Hidden").ja, "目星"); assert.equal(names("Spot Hidden")["zh-CN"], "侦查"); assert.equal(Object.keys(names("Dodge")).length, 10);
  assert.equal(rules.families.find((f) => f.name === "Fighting").names.ja, "近接戦闘");
  const space = await call(gm, "PUT", `/api/channels/${ch}/characters/${npc.id}/card`, { role_card: { characteristics: { DEX: 60, EDU: 70, INT: 70 }, skill_points: { "Spot Hidden": { hobby: 35 } } } });
  assert.equal(space.points.language, "ja");

  const roll = async (content) => (await call(gm, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content, kind: "ic", character_id: npc.id })).dice;
  const ja = await roll(".ra 目星");
  assert.equal(ja.attr, "Spot Hidden"); assert.equal(ja.value, 60); assert.match(ja.text, /目星/);
  const en = await roll(".ra spot hidden");
  assert.equal(en.attr, "Spot Hidden"); assert.match(en.text, /目星/);
  const set = await roll(".st 図書館55");
  assert.match(set.text, /図書館 55/);
  const attrs = await call(gm, "GET", `/api/channels/${ch}/characters/${npc.id}/attributes`);
  assert.equal(attrs.attrs["Library Use"], 55, "stored under the English name");
  // Names of another language are not skills here.
  await rejects(roll(".ra Trouver objet caché"), 400);
});
