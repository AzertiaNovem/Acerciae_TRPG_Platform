import { test } from "node:test";
import assert from "node:assert/strict";
// Run against an isolated server with the mock LLM: API_BASE=http://127.0.0.1:8080 node --test tests/integration/reminders.test.mjs
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return; } assert.fail(`expected HTTP ${status}`); };

test("reminder bubbles: raised from readable chat only, quoted verbatim, opened with highlights, invisible to other groups", async () => {
  const s = Math.random().toString(36).slice(2); const u = {};
  for (const r of ["gm", "p1", "p2"]) u[r] = await call(null, "POST", "/api/auth/register", { username: r + s, password: "password", display_name: r });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Reminders" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Hale house", knowledge_mode: "isolated" })).id;
  for (const r of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: r + s, role: "player" });
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada Quill" });
  await call(p2, "POST", `/api/channels/${ch}/characters`, { name: "Mo Reyes" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const priv = (await call(gm, "POST", `/api/channels/${ch}/windows`, { name: "Ada alone", kind: "private", members: [{ user_id: u.p1.user?.id ?? u.p1.id, character_id: ada.id }] })).id;
  const say = (t, w, content, extra = {}) => call(t, "POST", `/api/channels/${ch}/windows/${w}/messages`, { content, ...extra });
  const observe = () => call(gm, "POST", `/api/channels/${ch}/ai/observe-now`);
  // Earlier: a clue in Ada's private window, then filler so it is no longer "recent".
  const clue = await say(gm, priv, "On the mantel you notice a tarnished badge; it bears a lantern sigil instead of the county seal.", { kind: "narration" });
  for (let i = 0; i < 9; i++) await say(gm, priv, `The fire crackles and the rain keeps falling (${i}).`, { kind: "narration" });
  await observe();
  // A GM-only note mentioning the same words must never be quoted.
  await say(gm, priv, "KEEPER NOTE: the lantern sigil marks members of the Society.", { kind: "narration", visibility: "gm_only" });
  // Now Ada brings it up again.
  await say(p1, priv, "Wait, that lantern sigil on the badge: does it match the one we saw at the docks?", { character_id: ada.id });
  await observe();
  const mine = await call(p1, "GET", `/api/channels/${ch}/reminders`);
  assert.ok(mine.length >= 1, "Ada's group got a reminder");
  const r = mine[0];
  assert.ok(["forgotten", "needed"].includes(r.kind)); assert.ok(r.citations.length >= 1);
  for (const c of r.citations) {
    const original = await call(p1, "GET", `/api/channels/${ch}/messages/${c.message_id}`);
    for (const q of c.quotes) assert.ok(original.content.includes(q), `quote is verbatim: ${q}`);
    assert.ok(!original.content.includes("members of the Society"), "GM-only line never quoted");
  }
  assert.ok(r.citations.some((c) => c.message_id === clue.id), "the earlier clue line is what the reminder points at");
  const ctx = await call(p1, "GET", `/api/channels/${ch}/reminders/${r.id}/context?limit=20`);
  assert.ok(ctx.events.some((e) => e.cited && e.quotes.length >= 1), "the quoted line is marked for highlighting");
  assert.ok(!JSON.stringify(ctx).includes("members of the Society"));
  // Mo's group cannot see or open it; the Keeper's own list holds no player bubbles.
  assert.ok(!(await call(p2, "GET", `/api/channels/${ch}/reminders`)).some((x) => x.id === r.id));
  await rejects(call(p2, "GET", `/api/channels/${ch}/reminders/${r.id}/context`), 404);
  assert.ok((await call(gm, "GET", `/api/channels/${ch}/reminders`)).every((x) => x.player_group_id === null));
  // Dismissal is per user.
  await call(p1, "POST", `/api/channels/${ch}/reminders/${r.id}/dismiss`);
  assert.ok(!(await call(p1, "GET", `/api/channels/${ch}/reminders`)).some((x) => x.id === r.id));
});
