import { test } from "node:test";
import assert from "node:assert/strict";
// Continuing a visual novel as the story goes on. Run against a server with the mock LLM, image and TTS providers:
// API_BASE=http://127.0.0.1:8080 node --test tests/integration/vn-continue.test.mjs
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
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };
const wait = async (fn) => {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 300)); }
  throw Error("timeout");
};
const finished = (token, root, id) => wait(async () => { const j = await call(token, "GET", root + `/vn-scripts/${id}`); return j.status === "completed" || j.status === "failed" ? j : null; });

test("a visual novel continues after its last line: old scenes stay, the ending scene goes on, its picture and voices are reused", async () => {
  const suffix = Math.random().toString(36).slice(2);
  const gmUser = await call(null, "POST", "/api/auth/register", { username: "gm" + suffix, password: "password", display_name: "gm" });
  const p1User = await call(null, "POST", "/api/auth/register", { username: "p1" + suffix, password: "password", display_name: "p1" });
  const gm = gmUser.token, p1 = p1User.token;
  const server = await call(gm, "POST", "/api/servers", { name: "VN continue" });
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { image: { provider: "mock" } });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Harbour", knowledge_mode: "isolated" })).id;
  const root = `/api/channels/${ch}/studio`;
  await call(gm, "POST", `/api/channels/${ch}/members`, { username: "p1" + suffix, role: "player" });
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada Quill" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const say = (token, content, extra = {}) => call(token, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content, ...extra });
  await say(gm, "Fog rolls over the harbour.", { kind: "narration" });
  await say(p1, "Who's there?", { character_id: ada.id });

  const job = await call(gm, "POST", root + "/vn-scripts", { title: "Harbour VN" });
  const done = await finished(gm, root, job.id);
  assert.equal(done.status, "completed", done.error);
  const pid = done.presentation_id;
  // The scene's background lands; a dubbing cast is chosen.
  const before = await wait(async () => { const p = await call(gm, "GET", root + `/presentations/${pid}`); return p.scenes.every((s) => s.background_asset_id) ? p : null; });
  const narrator = (await call(gm, "POST", root + "/voices", { name: "Narrator", voice_type: "preset", voice_id: "mock-serena" })).id;
  const adaVoice = (await call(gm, "POST", root + "/voices", { name: "Ada", character_id: ada.id, voice_type: "preset", voice_id: "mock-cherry" })).id;
  await call(gm, "POST", root + `/presentations/${pid}/cast`, { cast: { narrator, [ada.id]: adaVoice } });

  // Nothing to continue yet; only the draft's author or the GM may continue it.
  await rejects(call(gm, "POST", root + "/vn-scripts", { continue_presentation_id: pid }), 400);
  await say(gm, "The fog lifts over the water.", { kind: "narration" });
  await say(p1, "Look, the lighthouse!", { character_id: ada.id });
  await rejects(call(p1, "POST", root + "/vn-scripts", { continue_presentation_id: pid }), 403);

  const next = await call(gm, "POST", root + "/vn-scripts", { continue_presentation_id: pid });
  assert.notEqual(next.snapshot_id, job.snapshot_id, "the log is frozen again");
  const cont = await finished(gm, root, next.id);
  assert.equal(cont.status, "completed", cont.error);
  assert.equal(cont.presentation_id, pid, "the same visual novel, not a new draft");
  assert.equal(cont.params.continues_presentation_id, pid);
  assert.equal(cont.script.continues_presentation_id, pid);
  const listed = (await call(gm, "GET", root + "/vn-scripts")).find((j) => j.id === next.id);
  assert.equal(listed.continues_presentation_id, pid);

  const after = await call(gm, "GET", root + `/presentations/${pid}`);
  // The old lines keep their events, in order; the new ones follow them.
  assert.deepEqual(after.events.slice(0, before.events.length).map((e) => e.id), before.events.map((e) => e.id));
  assert.deepEqual(after.events.slice(before.events.length).map((e) => e.display_text), ["The fog lifts over the water.", "Look, the lighthouse!"]);
  // Same window, same scene: the story goes on in the scene it ended on, on the same picture, and asks for none.
  assert.equal(after.scenes.length, before.scenes.length);
  const last = after.scenes[after.scenes.length - 1];
  assert.ok(after.events.slice(before.events.length).every((e) => e.scene_id === last.id));
  assert.equal(last.background_asset_id, before.scenes[before.scenes.length - 1].background_asset_id);
  assert.equal(cont.script.generation.backgrounds.length, 0);
  // The dubbing cast voices the new lines too.
  const fresh = after.events.slice(before.events.length);
  assert.equal(fresh.find((e) => e.display_text === "Look, the lighthouse!").voice_profile_id, adaVoice);
  assert.equal(fresh.find((e) => e.display_text === "The fog lifts over the water.").voice_profile_id, narrator);
  assert.equal(after.snapshot_id, next.snapshot_id, "the presentation reads the newer snapshot");

  // Everything is in the visual novel again: nothing more to continue.
  await rejects(call(gm, "POST", root + "/vn-scripts", { continue_presentation_id: pid }), 400);
});
