import { test } from "node:test";
import assert from "node:assert/strict";
// Private chats with a bot (docs/BOTS.md), against a live server with the mock model (scripts/test.sh runs it with
// BOT_TICK_MS=300 BOT_SETTLE_MS=300 BOT_GM_WAIT_MS=2500): a person opens one chat per bot; it is in no channel list,
// nobody else can read or join it; every line of theirs is for the bot, which answers out of character; the person
// deletes it.
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

test("private chats: one per person and bot, hidden from everyone else, every line answered, deleted by its person", { timeout: 120000 }, async () => {
  const s = Math.random().toString(36).slice(2, 8); const u = {};
  for (const r of ["gm", "p1", "p2"]) u[r] = await call(null, "POST", "/api/auth/register", { username: `bk${r}${s}`, password: "password", display_name: `${r}-${s}` });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Bot chats" });
  for (const r of ["p1", "p2"]) await call(gm, "POST", `/api/servers/${server.id}/members`, { username: `bk${r}${s}`, role: "member" });
  const echo = await call(gm, "POST", `/api/servers/${server.id}/bots`, { name: "Echo" }).catch((e) => e);
  assert.equal(echo.status, 403, "no bots while the feature is off");
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { bots: true } });
  const bot = await call(gm, "POST", `/api/servers/${server.id}/bots`, { name: "Echo", persona: "Likes rain." });
  const chat = await call(p1, "POST", `/api/servers/${server.id}/bots/${bot.id}/chat`, {});
  assert.equal(chat.created, true); assert.equal(chat.bot_name, "Echo");
  assert.equal((await call(p1, "POST", `/api/servers/${server.id}/bots/${bot.id}/chat`, {})).channel_id, chat.channel_id, "one chat per person and bot");
  assert.deepEqual((await call(p1, "GET", `/api/servers/${server.id}/bot-chats`)).map((c) => c.channel_id), [chat.channel_id]);
  assert.deepEqual(await call(p2, "GET", `/api/servers/${server.id}/bot-chats`), []);
  // In no channel list, readable by nobody else.
  assert.ok(!(await call(p1, "GET", `/api/servers/${server.id}/channels`)).some((c) => c.id === chat.channel_id));
  assert.ok(!(await call(gm, "GET", `/api/servers/${server.id}/channels`)).some((c) => c.id === chat.channel_id));
  await rejects(call(p2, "GET", `/api/channels/${chat.channel_id}/windows/${chat.window_id}/messages`), 403);
  await rejects(call(gm, "GET", `/api/channels/${chat.channel_id}`), 403);
  const mine = await call(p1, "GET", `/api/channels/${chat.channel_id}`);
  assert.equal(mine.kind, "bot_chat");
  await rejects(call(p1, "POST", `/api/channels/${chat.channel_id}/characters`, { name: "Stray" }), 403);
  await rejects(call(p1, "POST", `/api/channels/${chat.channel_id}/bots`, { bot_id: bot.id }), 403);
  // Every line of theirs is for the bot.
  await sleep(800);
  await call(p1, "POST", `/api/channels/${chat.channel_id}/windows/${chat.window_id}/messages`, { content: "Rainy day here.", kind: "ooc" });
  const answer = await until(async () => { const h = await call(p1, "GET", `/api/channels/${chat.channel_id}/windows/${chat.window_id}/messages?limit=20`); return (Array.isArray(h) ? h : h.messages).find((m) => m.author_id === bot.user_id); });
  assert.equal(answer.kind, "ooc"); assert.equal(answer.author_is_bot, true); assert.match(answer.content, /Rainy day here/);
  // Only its person deletes it.
  await rejects(call(gm, "DELETE", `/api/channels/${chat.channel_id}`, {}), 404);
  assert.equal((await call(p1, "DELETE", `/api/channels/${chat.channel_id}`, {})).ok, true);
  assert.deepEqual(await call(p1, "GET", `/api/servers/${server.id}/bot-chats`), []);
});
