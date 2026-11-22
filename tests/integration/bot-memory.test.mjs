import { test } from "node:test";
import assert from "node:assert/strict";
// What a bot remembers (docs/BOTS.md), against a live server with the mock model (scripts/test.sh runs it with
// BOT_TICK_MS=300 BOT_SETTLE_MS=300 BOT_GM_WAIT_MS=2500). Leaving a table, a bot writes down what it saw there: an
// account with the moment that struck it most, and notes on the people. Elsewhere it brings that up only with people
// who were there too, unless its maintainers let it share between tables. Maintainers read and correct its memory; the
// table's GM reads what it remembers of the table, gives it a private briefing, and can make it forget.
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

test("bots remember a table, bring it up only where they may, and their memory can be read, corrected and forgotten", { timeout: 120000 }, async () => {
  const s = Math.random().toString(36).slice(2, 8); const u = {};
  for (const r of ["gm", "p1", "p2"]) u[r] = await call(null, "POST", "/api/auth/register", { username: `bm${r}${s}`, password: "password", display_name: `${r}-${s}` });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Bot memory" });
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { bots: true } });
  const channel = async (name, player) => {
    const id = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name, knowledge_mode: "isolated" })).id;
    await call(gm, "POST", `/api/channels/${id}/members`, { username: `bm${player}${s}`, role: "player" });
    return { id, main: (await call(gm, "GET", `/api/channels/${id}/windows`))[0].id };
  };
  const a = await channel("Lighthouse", "p1"), b = await channel("Harbour", "p2");
  const echo = await call(gm, "POST", `/api/servers/${server.id}/bots`, { name: "Echo", persona: "Collects ghost stories." });
  const lines = async (ch, token = gm) => { const h = await call(token, "GET", `/api/channels/${ch.id}/windows/${ch.main}/messages?limit=60`); return Array.isArray(h) ? h : h.messages; };
  const byEcho = async (ch) => (await lines(ch)).filter((m) => m.author_id === echo.user_id);
  const say = (token, ch, content, kind = "ic") => call(token, "POST", `/api/channels/${ch.id}/windows/${ch.main}/messages`, { content, kind });

  // A table: Echo plays Ivo there.
  await call(p1, "POST", `/api/channels/${a.id}/bots`, { bot_id: echo.id });
  await sleep(800);
  await call(gm, "POST", `/api/channels/${a.id}/characters`, { name: "Ivo", user_id: echo.user_id });
  await until(async () => (await byEcho(a)).length === 1);
  await say(p1, a, "We climb the lighthouse stairs.");
  await say(gm, a, "The lamp flickers.", "narration");
  await until(async () => (await byEcho(a)).length === 2);
  // Removed from the table, it writes down what it saw there.
  await call(gm, "DELETE", `/api/channels/${a.id}/bots/${echo.id}`);
  const remembered = await until(async () => (await call(gm, "GET", `/api/servers/${server.id}/bots/${echo.id}/memories`)).memories.find((m) => m.kind === "table" && m.channel_id === a.id));
  assert.match(remembered.text, /We climb the lighthouse stairs/);
  assert.ok(remembered.highlight);
  const all = (await call(gm, "GET", `/api/servers/${server.id}/bots/${echo.id}/memories`)).memories;
  assert.ok(all.some((m) => m.kind === "person" && m.user_id === u.p1.user.id));
  await rejects(call(p1, "GET", `/api/servers/${server.id}/bots/${echo.id}/memories`), 403);

  // Another table, with someone who was not at the lighthouse: Echo keeps that story to itself.
  await call(p2, "POST", `/api/channels/${b.id}/bots`, { bot_id: echo.id });
  await sleep(800);
  await say(p2, b, "Echo, any stories?", "ooc");
  const first = await until(async () => (await byEcho(b))[0]);
  assert.doesNotMatch(first.content, /I remember/);
  // Its maintainers let it share between tables: now it brings up the moment that struck it most.
  await call(gm, "PUT", `/api/servers/${server.id}/bots/${echo.id}`, { share_tables: true });
  await say(p2, b, "Echo, tell us more.", "ooc");
  const second = await until(async () => (await byEcho(b))[1]);
  assert.match(second.content, /I remember:/);

  // Maintainers correct it and add notes; the GM of the lighthouse sees what it remembers there, briefs it, makes it forget.
  const fixed = await call(gm, "PUT", `/api/servers/${server.id}/bots/${echo.id}/memories/${remembered.id}`, { text: "A quiet night at the lighthouse.", highlight: "The lamp." });
  assert.equal(fixed.memories.find((m) => m.id === remembered.id).source, "edited");
  const noted = await call(gm, "POST", `/api/servers/${server.id}/bots/${echo.id}/memories`, { text: "Owes p1 a song." });
  assert.ok(noted.memories.some((m) => m.kind === "note" && m.text === "Owes p1 a song."));
  await rejects(call(p1, "GET", `/api/channels/${a.id}/bots/${echo.id}/memory`), 403);
  const atLighthouse = await call(gm, "GET", `/api/channels/${a.id}/bots/${echo.id}/memory`);
  assert.equal(atLighthouse.table.text, "A quiet night at the lighthouse.");
  const briefed = await call(gm, "PUT", `/api/channels/${a.id}/bots/${echo.id}/briefing`, { text: "Ivo owes the keeper a debt." });
  assert.equal(briefed.briefing.text, "Ivo owes the keeper a debt.");
  const forgot = await call(gm, "DELETE", `/api/channels/${a.id}/bots/${echo.id}/memory`);
  assert.equal(forgot.table, null); assert.equal(forgot.briefing.text, "Ivo owes the keeper a debt.");

  // The GM's switch for bots joining in on their own.
  await call(gm, "PUT", `/api/channels/${b.id}`, { bot_chatter_enabled: false });
  assert.equal((await call(gm, "GET", `/api/channels/${b.id}`)).bot_chatter_enabled, false);
});
