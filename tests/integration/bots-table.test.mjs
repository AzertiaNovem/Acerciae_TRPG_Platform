import { test } from "node:test";
import assert from "node:assert/strict";
// Bots at play (docs/BOTS.md), against a live server with the mock model (scripts/test.sh runs it with
// BOT_TICK_MS=300 BOT_SETTLE_MS=300 BOT_GM_WAIT_MS=2500). Given a character, the bot takes it up; a player's line, then the GM's: the bot plays its character
// as an ordinary player line; named by the GM it rolls its own dice; outside the table a bot answers only when named,
// out of character; the GM can take back a bot's line at any time, the player cannot; with nobody talking, bots stay quiet.
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, body: data });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) assert.fail("timed out"); await sleep(200); } }

test("bots at play: the bot answers a player after the GM, rolls when named, answers outside the table only when named", { timeout: 120000 }, async () => {
  const s = Math.random().toString(36).slice(2, 8); const u = {};
  for (const r of ["gm", "p1"]) u[r] = await call(null, "POST", "/api/auth/register", { username: `bp${r}${s}`, password: "password", display_name: `${r}-${s}` });
  const gm = u.gm.token, p1 = u.p1.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Bots at play" });
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { bots: true } });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Harbour", knowledge_mode: "isolated" })).id;
  await call(gm, "POST", `/api/channels/${ch}/members`, { username: `bpp1${s}`, role: "player" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const wren = await call(gm, "POST", `/api/servers/${server.id}/bots`, { name: "Wren", persona: "A retired sailor." });
  await call(p1, "POST", `/api/channels/${ch}/bots`, { bot_id: wren.id });
  const harriet = await call(gm, "POST", `/api/channels/${ch}/characters`, { name: "Harriet", user_id: wren.user_id });
  await call(gm, "PUT", `/api/channels/${ch}/characters/${harriet.id}/attributes`, { set: { "Spot Hidden": 60 } });
  await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada" });
  await sleep(800);   // the runtime seats the bot at the window's end
  const lines = async (token = gm) => { const h = await call(token, "GET", `/api/channels/${ch}/windows/${main}/messages?limit=80`); return Array.isArray(h) ? h : h.messages; };
  const byBot = async (user = wren.user_id) => (await lines()).filter((m) => m.author_id === user);
  const say = (token, content, kind = "ic") => call(token, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content, kind });

  // Given a character, the bot takes up the part: one line in character.
  const adopted = await until(async () => (await byBot())[0]);
  assert.equal(adopted.character_id, harriet.id);
  // A player's line: the GM answers first; the bot waits, then plays its character.
  const t0 = Date.now();
  await say(p1, "I step onto the pier.");
  await sleep(1000);
  assert.equal((await byBot()).length, 1, "the GM answers first");
  await say(gm, "The fog rolls in.", "narration");
  const first = await until(async () => (await byBot())[1]);
  assert.equal(first.kind, "ic"); assert.equal(first.character_id, harriet.id); assert.equal(first.character_name, "Harriet");
  assert.equal(first.author_is_bot, true); assert.equal(first.author_role, "player");
  assert.match(first.content, /Harriet answers/);
  assert.ok(Date.now() - t0 < 15000);
  // Named by the GM: it rolls its own dice, against its own sheet.
  await say(gm, "Harriet, roll Spot Hidden.", "narration");
  const roll = await until(async () => (await byBot()).find((m) => m.kind === "roll"));
  assert.equal(roll.character_id, harriet.id); assert.ok(roll.dice);

  // Outside the table (no character in this channel), Pip answers only when named, out of character.
  const pip = await call(gm, "POST", `/api/servers/${server.id}/bots`, { name: "Pip" });
  await call(gm, "POST", `/api/channels/${ch}/bots`, { bot_id: pip.id });
  await sleep(800);
  await say(p1, "Lovely weather today.", "ooc");
  await sleep(1500);
  assert.equal((await byBot(pip.user_id)).length, 0, "not named: Pip stays quiet");
  await say(p1, "Pip, how are you?", "ooc");
  const hi = await until(async () => (await byBot(pip.user_id))[0]);
  assert.equal(hi.kind, "ooc"); assert.equal(hi.character_id, null); assert.match(hi.content, /Pip \(mention\)/);

  // Moderation: the GM takes back a bot's line at any time; a player cannot.
  await rejects(call(p1, "POST", `/api/channels/${ch}/messages/${first.id}/recall`), 403);
  await call(gm, "POST", `/api/channels/${ch}/messages/${first.id}/recall`);
  assert.ok((await lines()).find((m) => m.id === first.id).recalled_at);

  // With nobody talking, nobody talks: no bot line appears on its own.
  await sleep(3500);
  const settled = (await lines()).length;
  await sleep(3500);
  assert.equal((await lines()).length, settled);
});
