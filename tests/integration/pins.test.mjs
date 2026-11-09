import { test } from "node:test";
import assert from "node:assert/strict";
// Pinned lines: a member marks a chat line as important and it joins their group's context bubbles (the GM's for the
// GM) as a reminder of kind 'pinned', outside the AI's maintenance, until its pinner or the GM unpins it.
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, body: data });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("pinned lines: a member pins a line they can read, their group sees it first among the bubbles, the pinner or the GM unpins it, the AI leaves it alone", async () => {
  const s = Math.random().toString(36).slice(2, 8); const u = {};
  for (const r of ["gm", "p1", "p2"]) u[r] = await call(null, "POST", "/api/auth/register", { username: `pn${r}${s}`, password: "password", display_name: r });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Pins" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Parlour", knowledge_mode: "isolated" })).id;
  for (const r of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: `pn${r}${s}`, role: "player" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada" });
  const mo = await call(p2, "POST", `/api/channels/${ch}/characters`, { name: "Mo" });
  const say = (token, content, extra = {}) => call(token, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content, ...extra });
  const clue = await say(gm, "The butler sets down the tray. \"The master saw no one last night,\" he says, not meeting your eyes.", { kind: "narration" });
  const secret = await say(gm, "GM note: the butler lies; the key is under the clock.", { kind: "narration", visibility: "gm_only" });
  await say(p1, "I watch his hands.", { character_id: ada.id });

  // Ada's player pins the butler's line: it heads her group's bubbles, quoted verbatim, named after its pinner.
  const pin = await call(p1, "POST", `/api/channels/${ch}/messages/${clue.id}/pin`);
  assert.equal(pin.kind, "pinned"); assert.equal(pin.status, "active"); assert.equal(pin.priority, 4);
  assert.equal(pin.pinned_by, u.p1.user.id); assert.equal(pin.pinned_message_id, clue.id);
  assert.ok(clue.content.startsWith(pin.title), "the title is the line's beginning");
  assert.equal(pin.citations[0].message_id, clue.id); assert.ok(clue.content.includes(pin.citations[0].quotes[0]), "the quote is verbatim");
  assert.equal(pin.why, "Pinned by p1"); assert.equal(pin.llm_mode, "user");
  const mine = await call(p1, "GET", `/api/channels/${ch}/reminders`);
  assert.equal(mine[0].id, pin.id, "pins come first"); assert.equal(mine[0].pinned_by_name, "p1");
  assert.ok(!(await call(p2, "GET", `/api/channels/${ch}/reminders`)).some((r) => r.id === pin.id), "another group does not see it");
  assert.ok(!(await call(gm, "GET", `/api/channels/${ch}/reminders`)).some((r) => r.id === pin.id), "the GM's bubbles are the GM's own");
  // Pinning it again returns the same pin; Mo's player may pin the same line for their own group.
  assert.equal((await call(p1, "POST", `/api/channels/${ch}/messages/${clue.id}/pin`)).id, pin.id);
  const theirs = await call(p2, "POST", `/api/channels/${ch}/messages/${clue.id}/pin`);
  assert.notEqual(theirs.id, pin.id);
  // Opening the pin shows the chat around the line, with the line cited.
  const ctx = await call(p1, "GET", `/api/channels/${ch}/reminders/${pin.id}/context`);
  assert.ok(ctx.events.some((e) => e.message_id === clue.id && e.cited));
  assert.equal(ctx.reminder.pinned_by_name, "p1", "the viewer names the pinner");
  assert.ok(!JSON.stringify(ctx).includes("under the clock"), "a GM-only line never shows");

  // What cannot be pinned: a line one cannot read, a line that is not there, a recalled line.
  await rejects(call(p1, "POST", `/api/channels/${ch}/messages/${secret.id}/pin`), 404);
  await rejects(call(p1, "POST", `/api/channels/${ch}/messages/00000000-0000-4000-8000-000000000001/pin`), 404);
  const slip = await say(p2, "I spill the tea.", { character_id: mo.id });
  await call(p2, "POST", `/api/channels/${ch}/messages/${slip.id}/recall`);
  await rejects(call(p2, "POST", `/api/channels/${ch}/messages/${slip.id}/pin`), 409);

  // The AI's planner runs over the new lines and leaves the pins as they are.
  await call(gm, "POST", `/api/channels/${ch}/ai/observe-now`);
  await sleep(2500);
  assert.ok((await call(p1, "GET", `/api/channels/${ch}/reminders`)).some((r) => r.id === pin.id && r.status === "active" && r.version === pin.version), "untouched by the planner");

  // Unpinning: not another group's member (it is not theirs to see), the pinner yes; the GM may take any down.
  await rejects(call(p2, "DELETE", `/api/channels/${ch}/reminders/${pin.id}`), 404);
  await rejects(call(p1, "DELETE", `/api/channels/${ch}/reminders/${theirs.id}`), 404);
  assert.equal((await call(p1, "DELETE", `/api/channels/${ch}/reminders/${pin.id}`)).unpinned, true);
  assert.ok(!(await call(p1, "GET", `/api/channels/${ch}/reminders`)).some((r) => r.id === pin.id));
  await rejects(call(p1, "DELETE", `/api/channels/${ch}/reminders/${pin.id}`), 404);   // gone already
  const again = await call(p1, "POST", `/api/channels/${ch}/messages/${clue.id}/pin`);
  assert.notEqual(again.id, pin.id, "pinned anew after an unpin");
  assert.equal((await call(gm, "DELETE", `/api/channels/${ch}/reminders/${theirs.id}`)).unpinned, true, "the GM unpins Mo's");
  assert.ok(!(await call(p2, "GET", `/api/channels/${ch}/reminders`)).some((r) => r.id === theirs.id));

  // The GM's own pins live in the GM's bubbles.
  const own = await call(gm, "POST", `/api/channels/${ch}/messages/${secret.id}/pin`);
  assert.equal(own.player_group_id, null);
  assert.ok((await call(gm, "GET", `/api/channels/${ch}/reminders`)).some((r) => r.id === own.id));
  assert.ok(!(await call(p1, "GET", `/api/channels/${ch}/reminders`)).some((r) => r.id === own.id));
  // A dismissal still hides a pin for one person only.
  await call(p1, "POST", `/api/channels/${ch}/reminders/${again.id}/dismiss`);
  assert.ok(!(await call(p1, "GET", `/api/channels/${ch}/reminders`)).some((r) => r.id === again.id));
});
