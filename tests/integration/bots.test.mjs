import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
// Bots (docs/BOTS.md): a server's maintainers set them up while the server's bots feature is on; any member of a
// channel invites one (it joins at once, as a player, and a system line says who brought it); the GM removes it and
// can turn invitations off. A bot never signs in, never shows up where people are looked up, and every line and
// character of its own says it is a bot.
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, body: data });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };
async function socket(token, channelId) {
  const { token: fileToken } = await call(token, "POST", "/api/auth/file-token");
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/chat?token=${encodeURIComponent(fileToken)}`);
  const received = [];
  ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { ws.on("error", reject); ws.on("message", (raw) => { if (JSON.parse(raw.toString()).type === "hello") { ws.send(JSON.stringify({ type: "subscribe", channel_id: channelId })); setTimeout(resolve, 200); } }); });
  const next = async (pred) => { for (let i = 0; i < 100; i++) { const hit = received.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 100)); } assert.fail("no such event"); };
  return { ws, next };
}

test("bots: set up by maintainers, invited by any member, removed by the GM, tagged everywhere, never signed in", async (t) => {
  const s = Math.random().toString(36).slice(2, 8); const u = {};
  for (const r of ["gm", "p1", "p2"]) u[r] = await call(null, "POST", "/api/auth/register", { username: `bt${r}${s}`, password: "password", display_name: `${r}-${s}` });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Bots" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Library", knowledge_mode: "isolated" })).id;
  for (const r of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: `bt${r}${s}`, role: "player" });

  // Off by default: nothing to invite, and maintainers cannot create one yet.
  assert.equal((await call(p1, "GET", `/api/channels/${ch}/bots`)).feature, false);
  await rejects(call(gm, "POST", `/api/servers/${server.id}/bots`, { name: "Mina" }), 403);
  const settings = await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { bots: true }, bots_per_channel: 2 });
  assert.equal(settings.features.bots, true); assert.equal(settings.bots_per_channel, 2);

  const mina = await call(gm, "POST", `/api/servers/${server.id}/bots`, { name: "Mina", persona: "A librarian who loves riddles.", speaking_style: "Warm and brief.", unprompted_per_hour: 3 });
  assert.equal(mina.unprompted_per_hour, 3); assert.equal(mina.share_tables, false);
  await rejects(call(p1, "POST", `/api/servers/${server.id}/bots`, { name: "Mine" }), 403);
  const ken = await call(gm, "POST", `/api/servers/${server.id}/bots`, { name: "Ken" });
  const lu = await call(gm, "POST", `/api/servers/${server.id}/bots`, { name: "Lu" });
  const asMember = await call(p1, "GET", `/api/servers/${server.id}/bots`);
  assert.deepEqual(asMember.map((b) => b.name).sort(), ["Ken", "Lu", "Mina"]);
  assert.ok(asMember.every((b) => !("persona" in b)), "members see names, not personas");
  await rejects(call(null, "POST", "/api/auth/register", { username: `bot-${s}`, password: "password" }), 400);
  const members = await call(gm, "GET", `/api/servers/${server.id}/members`);
  const botUser = members.find((m) => m.id === mina.user_id);
  assert.equal(botUser.is_bot, true);
  await rejects(call(null, "POST", "/api/auth/login", { username: botUser.username, password: "!" }), 401);
  assert.ok(!(await call(gm, "GET", `/api/users/search?q=Mina`)).some((x) => x.id === mina.user_id));

  // A player invites Mina: she joins at once, as a player, and the table hears about it.
  const sock = await socket(p2, ch);
  t.after(() => sock.ws.close());   // even when an assertion fails, so the file does not hang
  const view = await call(p1, "GET", `/api/channels/${ch}/bots`);
  assert.equal(view.can_invite, true); assert.equal(view.can_remove, false); assert.equal(view.invitable.length, 3);
  const after = await call(p1, "POST", `/api/channels/${ch}/bots`, { bot_id: mina.id });
  assert.deepEqual(after.present.map((b) => [b.name, b.invited_by_name]), [["Mina", `p1-${s}`]]);
  await sock.next((m) => m.type === "bots.changed" && m.channel_id === ch);
  const notice = await sock.next((m) => m.type === "message.posted" && m.message?.kind === "system" && m.message.content.includes("Mina"));
  assert.match(notice.message.content, new RegExp(`p1-${s} invited Mina \\(bot\\)`));
  const roster = await call(gm, "GET", `/api/channels/${ch}/members`);
  assert.equal(roster.find((m) => m.id === mina.user_id)?.role, "player");
  assert.equal(roster.find((m) => m.id === mina.user_id)?.is_bot, true);
  await rejects(call(p2, "POST", `/api/channels/${ch}/bots`, { bot_id: mina.id }), 409);
  // Only the GM gives a bot a character, and its lines and character carry the bot flag.
  const sleuth = await call(gm, "POST", `/api/channels/${ch}/characters`, { name: "Mina's sleuth", user_id: mina.user_id });
  assert.equal((await call(p1, "GET", `/api/channels/${ch}/characters`)).find((c) => c.id === sleuth.id).player_is_bot, true);
  await rejects(call(gm, "POST", `/api/channels/${ch}/characters`, { name: "Stray", user_id: ken.user_id }), 400);
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const history = await call(p1, "GET", `/api/channels/${ch}/windows/${main}/messages`);
  const lines = Array.isArray(history) ? history : history.messages;
  // Given a character, Mina takes the part up with a line of her own (docs/BOTS.md): flagged as a bot's; nobody else's is.
  assert.ok(lines.every((m) => m.author_is_bot === (m.author_id === mina.user_id)), "only the bot's lines carry the bot flag");

  // The GM turns invitations off: players are refused; the limit per channel holds for the GM too.
  await call(gm, "PUT", `/api/channels/${ch}`, { bot_invites_enabled: false });
  await rejects(call(p2, "POST", `/api/channels/${ch}/bots`, { bot_id: ken.id }), 403);
  await call(gm, "POST", `/api/channels/${ch}/bots`, { bot_id: ken.id });
  await rejects(call(gm, "POST", `/api/channels/${ch}/bots`, { bot_id: lu.id }), 409);
  // Only the GM removes a bot; retiring it removes it everywhere.
  await rejects(call(p1, "DELETE", `/api/channels/${ch}/bots/${mina.id}`), 403);
  const left = await call(gm, "DELETE", `/api/channels/${ch}/bots/${mina.id}`);
  assert.deepEqual(left.present.map((b) => b.name), ["Ken"]);
  await call(gm, "DELETE", `/api/servers/${server.id}/bots/${ken.id}`);
  assert.deepEqual((await call(gm, "GET", `/api/channels/${ch}/bots`)).present, []);
  assert.deepEqual((await call(gm, "GET", `/api/servers/${server.id}/bots`)).map((b) => b.name).sort(), ["Lu", "Mina"]);
});
