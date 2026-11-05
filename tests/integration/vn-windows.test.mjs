import { test } from "node:test";
import assert from "node:assert/strict";
// A visual novel tells the chat windows its author picks: the others are left out. The point of view still decides who
// may watch it and which lines anyone may read; the window list narrows it further, and a continuation keeps it.
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, body: data });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };
const wait = async (fn) => {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 300)); }
  throw Error("job timeout");
};

test("visual novel windows: pick the chat windows to tell, counted per point of view, kept by a continuation", async () => {
  const sfx = Math.random().toString(36).slice(2, 8);
  const u = {};
  for (const role of ["gm", "p1", "p2"]) u[role] = await call(null, "POST", "/api/auth/register", { username: `vw${role}${sfx}`, password: "password", display_name: role });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "VN windows" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Harbour", knowledge_mode: "isolated" })).id;
  for (const role of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: `vw${role}${sfx}`, role: "player" });
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada" });
  const mo = await call(p2, "POST", `/api/channels/${ch}/characters`, { name: "Mo" });
  const root = `/api/channels/${ch}/studio`;
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const archive = (await call(gm, "POST", `/api/channels/${ch}/windows`, { name: "Archive", kind: "private", members: [{ user_id: u.p1.user.id, character_id: ada.id }] })).id;
  const pier = (await call(gm, "POST", `/api/channels/${ch}/windows`, { name: "Pier", kind: "private", members: [{ user_id: u.p2.user.id, character_id: mo.id }] })).id;
  const say = (token, w, content, extra = {}) => call(token, "POST", `/api/channels/${ch}/windows/${w}/messages`, { content, ...extra });
  await say(gm, main, "Fog rolls over the harbour.", { kind: "narration" });
  await say(gm, archive, "The archive smells of old paper.", { kind: "narration" });
  await say(p1, archive, "I pull the 1923 ledger.", { character_id: ada.id });
  await say(gm, pier, "Rain drums on the pier.", { kind: "narration" });
  await say(p2, pier, "I wait by the bollard.", { character_id: mo.id });
  await say(p2, main, "Anyone seen the boat?", { character_id: mo.id });

  // The windows and their lines, per point of view. The Keeper sees every window.
  const all = await call(gm, "GET", root + "/vn-scripts/windows?scope=gm_full");
  const count = (r, id) => r.windows.find((w) => w.id === id)?.line_count;
  assert.equal(all.scope, "gm_full");
  assert.deepEqual([count(all, main), count(all, archive), count(all, pier)], [2, 2, 2]);
  assert.equal(typeof all.unwindowed, "number");
  // Lines every player can read: only the main table's.
  const pub = await call(gm, "GET", root + "/vn-scripts/windows?scope=pl_public");
  assert.deepEqual([count(pub, main), count(pub, archive), count(pub, pier)], [2, 0, 0]);
  // Ada's player: the main table and her own window; Mo's private window is not even named to her.
  const hers = await call(p1, "GET", root + `/vn-scripts/windows?scope=character&scope_character_id=${ada.id}`);
  assert.equal(count(hers, archive), 2); assert.equal(count(hers, main), 2);
  assert.equal(hers.windows.some((w) => w.id === pier), false);
  // A player cannot ask for the Keeper's view or another character's.
  await rejects(call(p1, "GET", root + "/vn-scripts/windows?scope=gm_full"), 403);
  await rejects(call(p1, "GET", root + `/vn-scripts/windows?scope=character&scope_character_id=${mo.id}`), 403);
  await rejects(call(p1, "GET", root + "/vn-scripts/windows?scope=everyone"), 400);

  // Bad window lists are refused.
  await rejects(call(gm, "POST", root + "/vn-scripts", { windows: [] }), 400);
  await rejects(call(gm, "POST", root + "/vn-scripts", { windows: ["not-a-uuid"] }), 400);
  await rejects(call(gm, "POST", root + "/vn-scripts", { windows: ["00000000-0000-0000-0000-000000000000"] }), 400);
  await rejects(call(gm, "POST", root + "/vn-scripts", { windows: "main" }), 400);
  // Windows with nothing in the point of view: nothing to tell.
  const empty = await rejects(call(gm, "POST", root + "/vn-scripts", { scope: "pl_public", windows: [pier] }), 400);
  assert.match(JSON.stringify(empty.body), /chosen chat windows have no lines/);

  // The Keeper tells the main table and the archive, and leaves the pier out.
  const job = await call(gm, "POST", root + "/vn-scripts", { title: "Two windows", windows: [main, archive, main] });
  assert.deepEqual([...job.params.windows].sort(), [main, archive].sort(), "duplicates collapse");
  const snap = await call(gm, "GET", root + `/snapshots/${job.snapshot_id}?events=1`);
  const contents = (snap.events ?? []).map((e) => e.content);
  assert.ok(contents.includes("I pull the 1923 ledger.") && contents.includes("Anyone seen the boat?"));
  assert.ok(!contents.some((c) => /pier|bollard/i.test(c)), "the pier is left out");
  const done = await wait(async () => { const j = await call(gm, "GET", root + `/vn-scripts/${job.id}`); return j.status === "completed" || j.status === "failed" ? j : null; });
  assert.equal(done.status, "completed", done.error);
  const listed = (await call(gm, "GET", root + "/vn-scripts")).find((j) => j.id === job.id);
  assert.deepEqual([...listed.windows].sort(), [main, archive].sort(), 'the job list names the windows it tells');

  // A continuation tells the same windows: new lines in the pier stay out.
  await say(gm, main, "The boat comes in at dawn.", { kind: "narration" });
  await say(gm, pier, "The rain stops.", { kind: "narration" });
  const cont = await call(gm, "POST", root + "/vn-scripts", { continue_presentation_id: done.presentation_id });
  assert.deepEqual([...cont.params.windows].sort(), [main, archive].sort());
  assert.equal(cont.params.new_lines, 1, "only the main table's new line");
  // An existing snapshot already holds its lines: no window list on top.
  await rejects(call(gm, "POST", root + "/vn-scripts", { snapshot_id: job.snapshot_id, windows: [main] }), 400);

  // A player tells their own window from their character's point of view.
  const own = await call(p1, "POST", root + "/vn-scripts", { scope: "character", scope_character_id: ada.id, windows: [archive] });
  const ownSnap = await call(p1, "GET", root + `/snapshots/${own.snapshot_id}?events=1`);
  assert.ok((ownSnap.events ?? []).every((e) => !/harbour|boat/i.test(e.content)), "only the archive");
  assert.ok((ownSnap.events ?? []).some((e) => e.content === "I pull the 1923 ledger."));
});
