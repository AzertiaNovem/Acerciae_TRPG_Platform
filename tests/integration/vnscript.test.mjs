import { test } from "node:test";
import assert from "node:assert/strict";
// Run against an isolated server with the mock LLM (no LLM_API_KEY): API_BASE=http://127.0.0.1:8080 node --test tests/integration/vnscript.test.mjs
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return; } assert.fail(`expected HTTP ${status}`); };
const wait = async (fn) => {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 300)); }
  throw Error("job timeout");
};

test("visual-novel script: reads every window, keeps lines verbatim, groups parallel windows, respects scope", async () => {
  const suffix = Math.random().toString(36).slice(2);
  const u = {};
  for (const role of ["gm", "p1", "p2"])
    u[role] = await call(null, "POST", "/api/auth/register", { username: role + suffix, password: "password", display_name: role });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "VN script" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Harbour", knowledge_mode: "isolated" })).id;
  const root = `/api/channels/${ch}/studio`;
  for (const role of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: role + suffix, role: "player" });
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada Quill" });
  const mo = await call(p2, "POST", `/api/channels/${ch}/characters`, { name: "Mo Reyes" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const userId = (x) => x.user?.id ?? x.id;
  const priv = (await call(gm, "POST", `/api/channels/${ch}/windows`, { name: "Archive (private)", kind: "private", members: [{ user_id: userId(u.p1), character_id: ada.id }] })).id;
  const say = (token, w, content, extra = {}) => call(token, "POST", `/api/channels/${ch}/windows/${w}/messages`, { content, ...extra });
  // Interleaved: the main table and a private side scene run in parallel.
  await say(gm, main, "Fog rolls over the harbour.", { kind: "narration" });
  await say(gm, priv, "The archive smells of old paper.", { kind: "narration" });
  await say(p2, main, "I keep watch on the pier.", { character_id: mo.id });
  await say(p1, priv, "I pull the 1923 ledger.", { character_id: ada.id });
  await say(p2, main, "brb, coffee", { character_id: mo.id, kind: "ooc" });
  await say(p1, priv, "Someone tore out a page.", { character_id: ada.id });
  await say(p2, main, "A lantern moves on the water.", { character_id: mo.id });

  const status = await call(gm, "GET", root + "/vn-scripts/status");
  assert.equal(status.mock, true, "this suite expects the mock planner");
  const project = await call(gm, "POST", root + "/projects", { title: "Campaign log" });
  await call(gm, "POST", root + `/projects/${project.id}/sync`, { mode: "campaign" });
  const all = await call(gm, "POST", root + `/projects/${project.id}/snapshots`, { title: "All windows", scope: "gm_full" });

  // Only GMs may run it, and templates are validated.
  await rejects(call(p1, "POST", root + "/vn-scripts", { snapshot_id: all.id }), 403);
  await rejects(call(gm, "POST", root + "/vn-scripts", { snapshot_id: all.id, template: { base: "adv", accent_color: "red;}" } }), 400);

  const job = await call(gm, "POST", root + "/vn-scripts", { snapshot_id: all.id, title: "Harbour VN", template: { base: "dossier", letterbox: true } });
  const done = await wait(async () => { const j = await call(gm, "GET", root + `/vn-scripts/${job.id}`); return j.status === "completed" || j.status === "failed" ? j : null; });
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.provider, "mock");
  assert.ok(done.script.notes[0].startsWith("MOCK"));

  const pres = await call(gm, "GET", root + `/presentations/${done.presentation_id}`);
  assert.equal(pres.settings.template.base, "dossier");
  assert.equal(pres.settings.template.letterbox, true);
  assert.equal(pres.settings.generated.job_id, job.id);
  // Two parallel windows → two scenes, each thread continuous.
  assert.equal(pres.scenes.length, 2);
  const byScene = (s) => pres.events.filter((e) => e.scene_id === s.id).map((e) => e.display_text);
  const [first, second] = pres.scenes.map(byScene);
  assert.deepEqual(first.filter((t) => t !== "brb, coffee"), ["Fog rolls over the harbour.", "I keep watch on the pier.", "A lantern moves on the water."]);
  assert.deepEqual(second, ["The archive smells of old paper.", "I pull the 1923 ledger.", "Someone tore out a page."]);
  // Text is verbatim and nothing was dropped; the OOC line is hidden, not deleted.
  const snapEvents = (await call(gm, "GET", root + `/snapshots/${all.id}`)).events;
  assert.equal(pres.events.length, snapEvents.length);
  for (const e of pres.events) assert.ok(snapEvents.some((s) => s.content === e.display_text), e.display_text);
  assert.equal(pres.events.find((e) => e.display_text === "brb, coffee").hidden, true);
  // Mo is staged on the pier with no standee art yet.
  const pier = pres.events.find((e) => e.display_text === "I keep watch on the pier.");
  assert.equal(pier.character_asset_ids[0].character_id, mo.id);

  // The all-windows draft is GM only.
  await rejects(call(p2, "GET", root + `/presentations/${done.presentation_id}`), 403);
  await rejects(call(p1, "GET", root + "/vn-scripts"), 403);

  // Mo's point of view never carries the private archive scene into the script.
  const pub = await call(gm, "POST", root + `/projects/${project.id}/snapshots`, { title: "Mo", scope: "character", scope_character_id: mo.id });
  const pubEvents = (await call(gm, "GET", root + `/snapshots/${pub.id}`)).events;
  assert.ok(pubEvents.length > 0);
  {
    const pj = await call(gm, "POST", root + "/vn-scripts", { snapshot_id: pub.id });
    const pd = await wait(async () => { const j = await call(gm, "GET", root + `/vn-scripts/${pj.id}`); return j.status === "completed" || j.status === "failed" ? j : null; });
    assert.equal(pd.status, "completed", pd.error);
    const pp = await call(p2, "GET", root + `/presentations/${pd.presentation_id}`);
    assert.ok(!pp.events.some((e) => /archive|ledger|page/.test(e.display_text)));
    assert.ok(!JSON.stringify(pd.script).includes("Archive (private)"));
    assert.ok(pp.events.some((e) => e.display_text === "A lantern moves on the water."));
  }
});
