import { test } from "node:test";
import assert from "node:assert/strict";
// Bots make their own characters (docs/BOTS.md), against a live server with the mock model (scripts/test.sh runs it
// with BOT_TICK_MS=300 BOT_SETTLE_MS=300 BOT_GM_WAIT_MS=2500). Asked at the table, a bot with no character there makes
// one through the same card routes a player uses, so the channel's rules apply: Call of Cthulhu within point buy,
// a legal D&D 2024 build, a PbtA playbook nobody else holds. It says so out of character; a second ask makes nothing.
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, body: data });
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) assert.fail("timed out"); await sleep(200); } }

// A table of the given rules with a player who asks the bot Sable to make its character; returns what came of it.
async function askForCharacter(rules, setup = async () => {}) {
  const s = Math.random().toString(36).slice(2, 8); const u = {};
  for (const r of ["gm", "p1"]) u[r] = await call(null, "POST", "/api/auth/register", { username: `bc${r}${s}`, password: "password", display_name: `${r}-${s}` });
  const gm = u.gm.token, p1 = u.p1.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Bot cards" });
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { bots: true } });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Archive", knowledge_mode: "isolated", rule_system: rules, point_buy: true })).id;
  await call(gm, "POST", `/api/channels/${ch}/members`, { username: `bcp1${s}`, role: "player" });
  await setup({ gm, p1, ch });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const sable = await call(gm, "POST", `/api/servers/${server.id}/bots`, { name: "Sable", persona: "Loves old books." });
  await call(p1, "POST", `/api/channels/${ch}/bots`, { bot_id: sable.id });
  await sleep(800);   // the runtime seats the bot at the window's end
  const ask = () => call(p1, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content: "Sable, make your character!", kind: "ooc" });
  const lines = async () => { const h = await call(p1, "GET", `/api/channels/${ch}/windows/${main}/messages?limit=60`); return Array.isArray(h) ? h : h.messages; };
  await ask();
  const pc = await until(async () => (await call(gm, "GET", `/api/channels/${ch}/characters`)).find((c) => c.user_id === sable.user_id));
  assert.equal(pc.player_is_bot, true);
  const ready = await until(async () => (await lines()).find((m) => m.author_id === sable.user_id && /character is ready/.test(m.content)));
  assert.equal(ready.kind, "ooc");
  const space = await call(gm, "GET", `/api/channels/${ch}/characters/${pc.id}/space`);
  return { gm, p1, ch, main, sable, pc, space, ask, lines };
}

test("bots make their own Call of Cthulhu character when asked, within the channel's point buy", { timeout: 120000 }, async () => {
  const { gm, ch, sable, space, ask, lines } = await askForCharacter("coc7e");
  assert.equal(space.character.role_card.career.name, "自定义职业");
  assert.deepEqual(space.points.violations, []);
  // One character per bot and channel: asked again, it makes nothing new.
  const before = (await lines()).length;
  await ask();
  await sleep(3000);
  assert.equal((await call(gm, "GET", `/api/channels/${ch}/characters`)).filter((c) => c.user_id === sable.user_id).length, 1);
  assert.ok(!(await lines()).slice(before).some((m) => m.author_id === sable.user_id && /character is ready/.test(m.content)));
});

test("bots make a legal D&D 2024 character: standard array, the background's increases, the class's saves and skills", { timeout: 120000 }, async () => {
  const { space } = await askForCharacter("dnd2024");
  const d = space.character.role_card.dnd;
  assert.equal(d.class, "Wizard"); assert.equal(d.species, "Elf"); assert.equal(d.background, "Sage"); assert.equal(d.level, 1);
  assert.equal(d.method, "standard_array");
  assert.deepEqual(Object.values(d.base).sort((a, b) => b - a), [15, 14, 13, 12, 10, 8]);
  assert.deepEqual(d.increases, { INT: 2, CON: 1 });
  assert.deepEqual([...d.saves].sort(), ["INT", "WIS"]);
  assert.ok(d.skills.Arcana && d.skills.History && d.skills.Investigation, JSON.stringify(d.skills));
  assert.equal(d.spellcasting_ability, "INT"); assert.equal(d.slots["1"], 2);
  assert.deepEqual(space.points.violations, []);
});

test("bots make a PbtA character with a playbook nobody at the table holds", { timeout: 120000 }, async () => {
  let taken;
  const { space } = await askForCharacter("pbta", async ({ p1, ch }) => {
    const { pack, revision } = await call(p1, "GET", `/api/channels/${ch}/pbta`);
    taken = pack.books[0].id;
    const hero = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Morgan" });
    await call(p1, "PUT", `/api/channels/${ch}/characters/${hero.id}/card`, { pack_revision: revision, role_card: { pbta: { book: taken, stats: {}, resources: {}, conditions: {} } } });
  });
  const p = space.character.role_card.pbta;
  assert.ok(p.book && p.book !== taken, `took ${p.book}`);
  const stats = space.pbta_rules.pack.stats.map((x) => x.id);
  assert.deepEqual(Object.keys(p.stats).sort(), [...stats].sort());
  assert.equal(p.stats[stats[0]], 2);
});
