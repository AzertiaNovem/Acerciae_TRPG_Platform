import { test } from "node:test";
import assert from "node:assert/strict";
// Run against an isolated server with the mock LLM, mock image and mock TTS providers:
// API_BASE=http://127.0.0.1:8080 node --test tests/integration/vnscript.test.mjs
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, code: typeof data.error === "string" ? data.error : data.error?.code ?? data.code });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };
const wait = async (fn) => {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 300)); }
  throw Error("job timeout");
};
const finished = (token, root, id) => wait(async () => { const j = await call(token, "GET", root + `/vn-scripts/${id}`); return j.status === "completed" || j.status === "failed" ? j : null; });

test("visual novel from the campaign log: freeze, time-block script, portraits and backgrounds, dubbing cast, standalone bundle", async () => {
  const suffix = Math.random().toString(36).slice(2);
  const u = {};
  for (const role of ["gm", "p1", "p2"])
    u[role] = await call(null, "POST", "/api/auth/register", { username: role + suffix, password: "password", display_name: role });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "VN script" });
  // Images are the server's own setting (there is no platform provider): use the labelled mock test patterns.
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { image: { provider: "mock" } });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Harbour", knowledge_mode: "isolated" })).id;
  await call(gm, "PUT", `/api/channels/${ch}`, { era: "1920s New England" });
  const root = `/api/channels/${ch}/studio`;
  for (const role of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: role + suffix, role: "player" });
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada Quill" });
  const mo = await call(p2, "POST", `/api/channels/${ch}/characters`, { name: "Mo Reyes" });
  // Ada chose AIGC with an appearance prompt; Mo uploads their own art and has no subtitle yet.
  await call(p1, "PUT", `/api/channels/${ch}/characters/${ada.id}/appearance`, { asset_mode: "generated", appearance_prompt: "red-haired librarian in a grey coat" });
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
  assert.equal(status.images, true, "this suite expects the mock image provider");
  // Templates are validated; the request needs no project or snapshot: it freezes the campaign log itself.
  await rejects(call(gm, "POST", root + "/vn-scripts", { template: { base: "adv", accent_color: "red;}" } }), 400);
  const job = await call(gm, "POST", root + "/vn-scripts", { title: "Harbour VN", template: { base: "dossier", letterbox: true } });
  assert.ok(job.snapshot_id);
  const done = await finished(gm, root, job.id);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.provider, "mock");
  assert.ok(done.script.notes[0].startsWith("MOCK"));
  assert.equal(done.script.blocks, 1, "all lines were posted within the hour");

  const pres = await call(gm, "GET", root + `/presentations/${done.presentation_id}`);
  assert.equal(pres.settings.template.base, "dossier");
  assert.equal(pres.settings.generated.job_id, job.id);
  // Two parallel windows → two backgrounds → two scenes, each thread continuous.
  assert.equal(pres.scenes.length, 2);
  const byScene = (s) => pres.events.filter((e) => e.scene_id === s.id).map((e) => e.display_text);
  const [first, second] = pres.scenes.map(byScene);
  assert.deepEqual(first.filter((t) => t !== "brb, coffee"), ["Fog rolls over the harbour.", "I keep watch on the pier.", "A lantern moves on the water."]);
  assert.deepEqual(second, ["The archive smells of old paper.", "I pull the 1923 ledger.", "Someone tore out a page."]);
  // The mock composer keeps the log's wording; nothing was dropped and the OOC line is hidden, not deleted.
  const snapEvents = (await call(gm, "GET", root + `/snapshots/${job.snapshot_id}`)).events;
  assert.equal(pres.events.length, snapEvents.length);
  for (const e of pres.events) assert.ok(snapEvents.some((s) => s.content === e.display_text), e.display_text);
  assert.equal(pres.events.find((e) => e.display_text === "brb, coffee").hidden, true);
  // Mo is staged on the pier with an IDLE-less uploaded profile → default (no art yet).
  const pier = pres.events.find((e) => e.display_text === "I keep watch on the pier.");
  // The presentation's own wording: shown instead of the log's words, while the log and the raw view keep the original.
  const fog = pres.events.find((e) => e.display_text === "Fog rolls over the harbour.");
  await call(gm, "PUT", root + `/pevents/${fog.id}`, { script_text: "A thick fog rolls in over the harbour." });
  let again = (await call(gm, "GET", root + `/presentations/${done.presentation_id}`)).events.find((e) => e.id === fog.id);
  assert.equal(again.display_text, "A thick fog rolls in over the harbour."); assert.equal(again.content, "Fog rolls over the harbour.");
  await call(gm, "PUT", root + `/pevents/${fog.id}`, { script_text: null });
  again = (await call(gm, "GET", root + `/presentations/${done.presentation_id}`)).events.find((e) => e.id === fog.id);
  assert.equal(again.display_text, "Fog rolls over the harbour."); assert.equal(again.script_text, null);
  assert.equal(pier.character_asset_ids[0].character_id, mo.id);
  // Ada speaks in generated mode: a SAY portrait is requested for her, none for Mo; both scene backgrounds are requested.
  const gen = done.script.generation;
  assert.equal(gen.enabled, true);
  assert.equal(gen.backgrounds.length, 2);
  assert.deepEqual(gen.portraits.map((p) => [p.character_id, p.subtitle]), [[ada.id, "SAY"]]);
  for (const need of done.script.asset_needs) if (need.kind === "background") assert.match(need.brief, /1920s New England/);
  // Generated art lands in the draft: backgrounds on their scenes, the SAY portrait on Ada's placements and in her character space.
  const withArt = await wait(async () => { const p = await call(gm, "GET", root + `/presentations/${done.presentation_id}`); return p.scenes.every((s) => s.background_asset_id) ? p : null; });
  const ledger = await wait(async () => { const p = await call(gm, "GET", root + `/presentations/${done.presentation_id}`); const e = p.events.find((x) => x.display_text === "I pull the 1923 ledger."); return e.character_asset_ids[0].asset_id ? e : null; });
  assert.equal(ledger.character_asset_ids[0].character_id, ada.id);
  assert.equal(ledger.character_asset_ids[0].expression, "SAY");
  const look = await call(p1, "GET", `/api/channels/${ch}/characters/${ada.id}/space`);
  assert.ok(look.subtitles.some((s) => s.subtitle === "SAY" && s.id === ledger.character_asset_ids[0].asset_id));
  assert.ok(withArt.scenes.every((s) => s.background_asset_id));

  // Dubbing cast: one voice per character plus the narrator, then mock Qwen TTS reads every visible line.
  const voices = {};
  for (const [c, v] of [[ada, "mock-cherry"], [mo, "mock-ethan"]]) voices[c.id] = (await call(gm, "POST", root + "/voices", { name: c.name, character_id: c.id, voice_type: "preset", voice_id: v })).id;
  const narrator = (await call(gm, "POST", root + "/voices", { name: "Narrator", voice_type: "preset", voice_id: "mock-serena" })).id;
  // Every member casts from the same voices: a player sees the narrator and other PCs' voices, and may add a narrator voice.
  const shared = await call(p2, "GET", root + "/voices");
  assert.ok([narrator, voices[ada.id], voices[mo.id]].every((id) => shared.some((v) => v.id === id)));
  assert.equal(shared.find((v) => v.id === narrator).editable, false);
  await rejects(call(p2, "PUT", root + `/voices/${narrator}`, { name: "mine now" }), 403);
  const p2Narrator = await call(p2, "POST", root + "/voices", { name: "Mo's narrator", voice_type: "preset", voice_id: "mock-serena" });
  await rejects(call(gm, "POST", root + `/presentations/${done.presentation_id}/cast`, { cast: { narrator: "00000000-0000-0000-0000-000000000001" } }), 400);
  const castPres = await call(gm, "POST", root + `/presentations/${done.presentation_id}/cast`, { cast: { narrator, [ada.id]: voices[ada.id], [mo.id]: voices[mo.id] } });
  assert.equal(castPres.settings.cast.narrator, narrator);
  for (const e of castPres.events.filter((x) => !x.hidden)) assert.ok(e.voice_profile_id, "every visible line has a voice: " + e.display_text);
  const tts = await call(gm, "POST", root + `/presentations/${done.presentation_id}/tts/jobs`, {});
  const voiced = await wait(async () => { const s = await call(gm, "GET", root + `/tts/jobs/${tts.id}`); assert.notEqual(s.status, "failed", JSON.stringify(s)); return s.status === "completed" ? s : null; });
  assert.ok(voiced.done >= 6);

  // The standalone bundle: index.html, the script, every image and every voice line.
  const zipRes = await fetch(base + root + `/presentations/${done.presentation_id}/bundle.zip`, { headers: { Authorization: `Bearer ${gm}` } });
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers.get("content-type"), "application/zip");
  assert.match(zipRes.headers.get("content-disposition"), /Harbour_VN\.zip/);
  const zip = Buffer.from(await zipRes.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "local file header signature");
  const listing = zip.toString("latin1");
  for (const name of ["index.html", "script.json", "assets/", "audio/"]) assert.ok(listing.includes(name), name);
  assert.ok(listing.includes('id="vn-data"') && listing.includes("Fog rolls over the harbour."));
  assert.equal(new Set(listing.match(/audio\/[0-9a-f]{8}\.wav/g)).size, 6, "six voiced lines, one audio file each");

  // The same, file by file (the desktop app): the player and script inline, every image and voice line as a URL whose
  // path names the asset version; each URL serves the file, the zip and the list hold the same files.
  const manifest = await call(gm, "GET", root + `/presentations/${done.presentation_id}/files`);
  assert.equal(manifest.folder, "Harbour_VN");
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths.slice(0, 2), ["index.html", "script.json"]);
  assert.ok(manifest.files[0].content.includes('id="vn-data"'));
  const script = JSON.parse(manifest.files[1].content);
  assert.ok(script.events.filter((e) => e.audio).every((e) => e.audio_ms > 0), "voice lines carry their length");
  const remote = manifest.files.filter((f) => f.url);
  assert.equal(remote.filter((f) => f.path.startsWith("audio/")).length, 6);
  assert.ok(remote.filter((f) => f.path.startsWith("assets/")).every((f) => /-v\d+\.(png|jpg|webp|svg)$/.test(f.path)), "image paths carry the version");
  for (const f of remote) { assert.ok(listing.includes(f.path), `zip has ${f.path}`); }
  for (const f of remote.slice(0, 3)) {
    const r = await fetch(base + f.url, { headers: { Authorization: `Bearer ${gm}` } });
    assert.equal(r.status, 200, f.url);
    assert.equal((await r.arrayBuffer()).byteLength, f.bytes, `${f.path} size`);
  }
  // The desktop app's origins may call the API; other sites may not.
  const cors = await fetch(base + "/api/health", { headers: { Origin: "tauri://localhost" } });
  assert.equal(cors.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.equal((await fetch(base + "/api/health", { headers: { Origin: "https://evil.example" } })).headers.get("access-control-allow-origin"), null);

  // The same bundle prepared in the background: pending → ready, then downloaded until it expires.
  const prepared = await call(gm, "POST", root + `/presentations/${done.presentation_id}/bundle`, {});
  assert.ok(["pending", "running", "ready"].includes(prepared.status));
  const ready = await wait(async () => { const [j] = await call(gm, "GET", root + `/presentations/${done.presentation_id}/bundles`); assert.notEqual(j.status, "failed", JSON.stringify(j)); return j.status === "ready" ? j : null; });
  assert.equal(ready.id, prepared.id); assert.equal(ready.file_name, "Harbour_VN.zip"); assert.ok(new Date(ready.expires_at) > new Date());
  const got = await fetch(base + ready.download_path, { headers: { Authorization: `Bearer ${gm}` } });
  assert.equal(got.status, 200); assert.match(got.headers.get("content-disposition"), /filename\*=UTF-8''Harbour_VN\.zip/);
  const prepZip = Buffer.from(await got.arrayBuffer());
  assert.equal(prepZip.readUInt32LE(0), 0x04034b50); assert.equal(new Set(prepZip.toString("latin1").match(/audio\/[0-9a-f]{8}\.wav/g)).size, 6);
  assert.equal((await call(gm, "POST", root + `/presentations/${done.presentation_id}/bundle`, {})).id, ready.id, "a current bundle is reused");
  assert.equal((await fetch(base + ready.download_path, { headers: { Authorization: `Bearer ${p2}` } })).status, 404, "only the requester downloads it");

  // The all-windows draft is GM only; a player sees their own jobs only.
  await rejects(call(p2, "GET", root + `/presentations/${done.presentation_id}`), 403);
  assert.deepEqual(await call(p1, "GET", root + "/vn-scripts"), []);
  await rejects(call(p1, "GET", root + `/vn-scripts/${job.id}`), 404);

  // A player makes their own visual novel from what they can read: Mo's point of view never carries the private archive.
  await rejects(call(p2, "POST", root + "/vn-scripts", { scope: "gm_full" }), 403);
  await rejects(call(p2, "POST", root + "/vn-scripts", { scope: "character", scope_character_id: ada.id }), 403);
  const pj = await call(p2, "POST", root + "/vn-scripts", { title: "Mo's night", scope: "character", scope_character_id: mo.id });
  const pd = await finished(p2, root, pj.id);
  assert.equal(pd.status, "completed", pd.error);
  const pp0 = await call(p2, "GET", root + `/presentations/${pd.presentation_id}`);
  assert.equal(pp0.can_edit, true);
  await call(p2, "POST", root + `/presentations/${pd.presentation_id}/cast`, { cast: { narrator: p2Narrator.id, [mo.id]: voices[mo.id] } });
  const pp = await call(p2, "GET", root + `/presentations/${pd.presentation_id}`);
  assert.ok(pp.events.filter((e) => !e.hidden).every((e) => e.voice_profile_id));
  assert.ok(!pp.events.some((e) => /archive|ledger|page/.test(e.display_text)));
  assert.ok(!JSON.stringify(pd.script).includes("Archive (private)"));
  assert.ok(pp.events.some((e) => e.display_text === "A lantern moves on the water."));
  assert.equal(pp.can_edit, true);
  assert.equal((await call(p2, "GET", root + "/vn-scripts")).length, 1);
  const pzip = await fetch(base + root + `/presentations/${pd.presentation_id}/bundle.zip`, { headers: { Authorization: `Bearer ${p2}` } });
  assert.equal(pzip.status, 200);

  // The Keeper hides the Studio in this channel: every Studio route closes for everyone, chat and media stay open.
  await call(gm, "PUT", `/api/channels/${ch}`, { studio_visible: false });
  assert.equal((await call(gm, "GET", `/api/channels/${ch}`)).studio_visible, false);
  assert.equal((await rejects(call(p2, "GET", root + "/vn-scripts"), 403)).code, "studio_hidden");
  assert.equal((await rejects(call(gm, "GET", root + "/log"), 403)).code, "studio_hidden");
  assert.equal((await fetch(base + root + `/presentations/${pd.presentation_id}/bundle.zip`, { headers: { Authorization: `Bearer ${p2}` } })).status, 403);
  await call(p2, "GET", `/api/channels/${ch}/windows/${main}/messages`);
  await call(gm, "PUT", `/api/channels/${ch}`, { studio_visible: true });
  await call(p2, "GET", root + "/vn-scripts");
  // The server maintainer turns the feature off for the whole server.
  const settings = await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { log_studio: false } });
  assert.equal(settings.features.log_studio, false);
  assert.equal((await rejects(call(gm, "GET", root + "/vn-scripts"), 403)).code, "studio_disabled");
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { log_studio: true } });
  await call(p2, "GET", root + "/vn-scripts");
});
