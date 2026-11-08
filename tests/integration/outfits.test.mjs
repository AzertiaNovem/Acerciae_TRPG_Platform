import { test } from "node:test";
import assert from "node:assert/strict";
// Outfits: a generated character's other clothes, each with its own portrait, avatar and poses drawn from the base
// portrait. The outfit worn now shows in the chat, each line keeps the outfit it was written in, a visual novel shows
// every line in the clothes worn then (an editor may override a placement), and illustrations draw the worn outfit.
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, body: data });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };
const waitFor = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
const NOT_AN_OUTFIT = "00000000-0000-4000-8000-000000000001";

test("outfits: other clothes with their own images, worn in the chat, remembered by each line, shown in the VN and drawn in illustrations", async () => {
  const s = Math.random().toString(36).slice(2, 8); const u = {};
  for (const r of ["gm", "p1", "p2"]) u[r] = await call(null, "POST", "/api/auth/register", { username: `of${r}${s}`, password: "password", display_name: r });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Outfits" });
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { llm: { provider: "mock" }, image: { provider: "mock" }, tts: { provider: "mock" } });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Grand ball" })).id;
  for (const r of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: `of${r}${s}`, role: "player" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada" });
  const C = `/api/channels/${ch}/characters/${ada.id}`;

  // Only a generated look has outfits.
  await rejects(call(p1, "POST", `${C}/outfits`, { name: "Ball gown", attire: "an emerald silk gown" }), 409);
  await call(p1, "PUT", `${C}/appearance`, { asset_mode: "generated", appearance_prompt: "a tall reporter in a green coat" });
  await call(p1, "POST", `${C}/assets/generate`, { slots: ["portrait", "avatar"], subtitles: ["IDLE"], allow_cloud: true });
  const look = await waitFor(async () => { const sp = await call(p1, "GET", `${C}/space`); return sp.portrait && sp.avatar && sp.subtitles.length === 1 ? sp : null; });

  // Bad requests; only the character's player and the GM manage outfits.
  await rejects(call(p1, "POST", `${C}/outfits`, { name: " ", attire: "x" }), 400);
  await rejects(call(p1, "POST", `${C}/outfits`, { name: "Ball gown", attire: "" }), 400);
  await rejects(call(p2, "POST", `${C}/outfits`, { name: "Ball gown", attire: "an emerald silk gown" }), 403);
  let sp = await call(p1, "POST", `${C}/outfits`, { name: "Ball gown", attire: "an emerald silk gown" });
  assert.equal(sp.max_outfits, 8);
  const gown = sp.outfits[0];
  assert.equal(gown.name, "Ball gown"); assert.equal(gown.portrait, null);
  await rejects(call(gm, "POST", `${C}/outfits`, { name: "ball GOWN", attire: "again" }), 409);
  await rejects(call(p1, "POST", `${C}/outfits/${gown.id}/generate`, { subtitles: ["IDLE"], allow_cloud: true }), 400);   // poses need the outfit's portrait
  sp = await call(gm, "PUT", `${C}/outfits/${gown.id}`, { attire: "an emerald silk ball gown, long white gloves" });
  assert.equal(sp.outfits[0].attire, "an emerald silk ball gown, long white gloves");

  // Its own set: the portrait from the base portrait, the avatar and poses from the outfit's portrait.
  const gen = await call(p1, "POST", `${C}/outfits/${gown.id}/generate`, { slots: ["portrait", "avatar"], subtitles: ["IDLE"], allow_cloud: true });
  assert.deepEqual(gen.jobs.map((j) => [j.attach.slot, j.attach.outfit_id]), [["portrait", gown.id], ["avatar", gown.id], ["subtitle", gown.id]]);
  sp = await waitFor(async () => { const x = await call(p1, "GET", `${C}/space`); const o = x.outfits[0]; return o.portrait && o.avatar && o.subtitles.length === 1 ? x : null; });
  const dressed = sp.outfits[0];
  assert.equal(sp.portrait.id, look.portrait.id, "the base look keeps its images");
  assert.equal(sp.subtitles[0].id, look.subtitles[0].id);
  assert.notEqual(dressed.portrait.id, look.portrait.id);

  // Worn: the chat shows it; each line keeps what was worn when it was written.
  const say = (token, content, extra = {}) => call(token, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content, ...extra });
  await say(gm, "The harbour at dusk.", { kind: "narration" });
  const coatLine = await say(p1, "I wait in my coat.", { character_id: ada.id });
  await rejects(call(p2, "PUT", `${C}/outfit`, { outfit_id: gown.id }), 403);
  await rejects(call(p1, "PUT", `${C}/outfit`, { outfit_id: NOT_AN_OUTFIT }), 404);
  sp = await call(p1, "PUT", `${C}/outfit`, { outfit_id: gown.id });
  assert.equal(sp.character.outfit_id, gown.id);
  const listed = (await call(p2, "GET", `/api/channels/${ch}/characters`)).find((c) => c.id === ada.id);
  assert.equal(listed.avatar_asset_id, dressed.avatar.id, "the list shows the outfit's avatar");
  assert.equal(listed.base_avatar_asset_id, look.avatar.id);
  assert.equal(listed.outfit_name, "Ball gown");
  assert.deepEqual(listed.outfits, [{ id: gown.id, name: "Ball gown" }]);
  await say(gm, "The ballroom glitters.", { kind: "narration" });
  const gownLine = await say(p1, "I sweep into the ballroom.", { character_id: ada.id });
  const lines = await call(p2, "GET", `/api/channels/${ch}/windows/${main}/messages`);
  const coat = lines.find((m) => m.id === coatLine.id), ball = lines.find((m) => m.id === gownLine.id);
  assert.equal(coat.outfit_id, null); assert.equal(coat.character_avatar_asset_id, look.avatar.id);
  assert.equal(ball.outfit_id, gown.id); assert.equal(ball.outfit_name, "Ball gown"); assert.equal(ball.character_avatar_asset_id, dressed.avatar.id);

  // The visual novel shows each line in the clothes worn when it was written.
  const root = `/api/channels/${ch}/studio`;
  const job = await call(gm, "POST", root + "/vn-scripts", {});
  const done = await waitFor(async () => { const j = await call(gm, "GET", root + "/vn-scripts/" + job.id); return ["completed", "failed"].includes(j.status) ? j : null; }, 60000);
  assert.equal(done.status, "completed", done.error);
  const pp = root + "/presentations/" + done.presentation_id;
  const placed = async (re) => { const e = (await call(gm, "GET", pp)).events.find((x) => re.test(x.display_text ?? "")); return { e, pl: e.character_asset_ids.find((x) => x.character_id === ada.id) }; };
  const outfitImages = new Set([dressed.portrait.id, dressed.subtitles[0].id]);
  let { e: inCoat, pl } = await placed(/coat/);
  assert.equal(pl.outfit_id, undefined, "written in the base look");
  assert.ok(!outfitImages.has(pl.asset_id));
  let gownEvent; ({ e: gownEvent, pl } = await placed(/sweep/));
  assert.equal(pl.outfit_id, gown.id); assert.equal(pl.outfit_auto, true);
  assert.ok(outfitImages.has(pl.asset_id), "the gown's pose, else its portrait");
  const pres = await call(gm, "GET", pp);
  assert.deepEqual(pres.character_outfits[ada.id].map((o) => o.name), ["Ball gown"]);
  // Saving an automatic placement keeps it automatic; an editor's choice is kept as chosen.
  await call(gm, "PUT", `${root}/pevents/${gownEvent.id}`, { character_asset_ids: gownEvent.character_asset_ids });
  ({ pl } = await placed(/sweep/));
  assert.equal(pl.outfit_auto, true);
  await call(gm, "PUT", `${root}/pevents/${inCoat.id}`, { character_asset_ids: inCoat.character_asset_ids.map((x) => (x.character_id === ada.id ? { ...x, outfit_id: gown.id } : x)) });
  ({ pl } = await placed(/coat/));
  assert.equal(pl.outfit_id, gown.id); assert.ok(!pl.outfit_auto); assert.ok(outfitImages.has(pl.asset_id));
  await call(gm, "PUT", `${root}/pevents/${gownEvent.id}`, { character_asset_ids: gownEvent.character_asset_ids.map((x) => (x.character_id === ada.id ? { ...x, outfit_id: "", outfit_auto: false } : x)) });
  ({ pl } = await placed(/sweep/));
  assert.equal(pl.outfit_id, ""); assert.ok(!outfitImages.has(pl.asset_id), "back in the base look");
  await rejects(call(gm, "PUT", `${root}/pevents/${gownEvent.id}`, { character_asset_ids: [{ character_id: ada.id, outfit_id: NOT_AN_OUTFIT }] }), 400);

  // Illustrations: drawn in the worn outfit unless another is picked; an unknown one is refused.
  await rejects(call(p1, "POST", `/api/channels/${ch}/windows/${main}/illustrations`, { prompt: "Ada dances", character_ids: [ada.id], outfits: { [ada.id]: NOT_AN_OUTFIT }, allow_cloud: true }), 400);
  const drawn = await call(p1, "POST", `/api/channels/${ch}/windows/${main}/illustrations`, { prompt: "Ada dances", character_ids: [ada.id], allow_cloud: true });
  assert.equal(drawn.reference_count, 1);
  const finished = await waitFor(async () => (await call(p1, "GET", `/api/channels/${ch}/illustrations`)).find((x) => x.id === drawn.id && ["completed", "failed"].includes(x.status)));
  assert.equal(finished.status, "completed", finished.error);

  // Deleting the outfit takes its images; the chat and the lines written in it fall back to the base look.
  await rejects(call(p2, "DELETE", `${C}/outfits/${gown.id}`), 403);
  sp = await call(gm, "DELETE", `${C}/outfits/${gown.id}`);
  assert.deepEqual(sp.outfits, []); assert.equal(sp.character.outfit_id, null);
  assert.equal(sp.portrait.id, look.portrait.id); assert.equal(sp.subtitles.length, 1);
  const after = (await call(p2, "GET", `/api/channels/${ch}/windows/${main}/messages`)).find((m) => m.id === gownLine.id);
  assert.equal(after.outfit_id, null); assert.equal(after.character_avatar_asset_id, look.avatar.id);
  const media = await call(gm, "GET", `/api/channels/${ch}/media`);
  assert.ok(!(media.assets ?? media).some((m) => [dressed.portrait.id, dressed.avatar.id, dressed.subtitles[0].id].includes(m.id)), "its images are gone");

  // At most eight.
  for (let i = 1; i <= 8; i++) await call(p1, "POST", `${C}/outfits`, { name: `Look ${i}`, attire: `outfit number ${i}` });
  await rejects(call(p1, "POST", `${C}/outfits`, { name: "Look 9", attire: "one too many" }), 409);
});
