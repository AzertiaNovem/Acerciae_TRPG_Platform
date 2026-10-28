import { test } from "node:test";
import assert from "node:assert/strict";
// Run against an isolated server: API_BASE=http://127.0.0.1:8080 node --test tests/integration/character-space.test.mjs
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body, raw) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { "Content-Type": "application/json" }) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return; } assert.fail(`expected HTTP ${status}`); };
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw Error("timeout"); await new Promise((r) => setTimeout(r, 400)); } };

test("character space: role card mirrors into dice attributes, uploads and generated images attach, actors edit, others read, NPCs stay with the Keeper", async () => {
  const s = Math.random().toString(36).slice(2); const u = {};
  for (const r of ["gm", "p1", "p2"]) u[r] = await call(null, "POST", "/api/auth/register", { username: r + s, password: "password", display_name: r });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Space" });
  // Images are the server's own setting (there is no platform provider): use the labelled mock test patterns.
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { image: { provider: "mock" } });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Arkham", knowledge_mode: "isolated" })).id;
  for (const r of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: r + s, role: "player" });
  await call(gm, "PUT", `/api/channels/${ch}`, { era: "1925, Arkham" });
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada Quill" });
  const npc = await call(gm, "POST", `/api/channels/${ch}/characters`, { name: "Sheriff Dunmore", kind: "npc" });
  // The role card.
  const card = { basic: { player: "p1", occupation: "Journalist", age: "34", sex: "F", residence: "Arkham", birthplace: "Boston" }, characteristics: { STR: 55, CON: 60, SIZ: 50, DEX: 70, APP: 65, INT: 80, POW: 60, EDU: 75, LUK: 45 }, derived: { hp: 11, hp_max: 11, mp: 12, san: 60, san_max: 99, mov: 8, build: 0, db: "0" }, skills: { "Spot Hidden": 65, "Library Use": 70, Persuade: 50 }, background: { personal_description: "Gaunt, grey wool coat.", ideology: "Truth above all", significant_people: "", meaningful_locations: "", treasured_possessions: "", traits: "", injuries: "", phobias: "", arcane: "", encounters: "" }, items: [{ name: "Notebook", note: "dog-eared", qty: 1 }, { name: "Revolver", note: ".38", qty: 1 }], wealth: { cash: "$40", assets: "", spending_level: "$10" } };
  const sp = await call(p1, "PUT", `/api/channels/${ch}/characters/${ada.id}/card`, { bio: "A reporter who asks one question too many.", role_card: card });
  assert.equal(sp.character.editable, true); assert.equal(sp.character.role_card.skills["Spot Hidden"], 65); assert.equal(sp.character.bio, "A reporter who asks one question too many."); assert.equal(sp.era, "1925, Arkham");
  const attrs = await call(p1, "GET", `/api/channels/${ch}/characters/${ada.id}/attributes`);
  assert.equal(attrs.attrs["Spot Hidden"], 65); assert.ok(Object.entries(attrs.attrs).some(([k, v]) => k.toLowerCase() === "str" && v === 55));
  // Another player reads but cannot edit; NPC spaces are the Keeper's.
  const seen = await call(p2, "GET", `/api/channels/${ch}/characters/${ada.id}/space`);
  assert.equal(seen.character.editable, false); assert.equal(seen.character.role_card.basic.occupation, "Journalist");
  await rejects(call(p2, "PUT", `/api/channels/${ch}/characters/${ada.id}/card`, { name: "Hijacked" }), 403);
  await rejects(call(p1, "GET", `/api/channels/${ch}/characters/${npc.id}/space`), 404);
  assert.ok((await call(gm, "GET", `/api/channels/${ch}/characters/${npc.id}/space`)).character.editable);
  // Uploaded mode: avatar, portrait and a subtitle image.
  const up = async (slot, subtitle) => { const fd = new FormData(); fd.append("slot", slot); fd.append("subtitle", subtitle); fd.append("file", new Blob([PNG], { type: "image/png" }), "a.png"); return call(p1, "POST", `/api/channels/${ch}/characters/${ada.id}/assets`, undefined, fd); };
  await up("avatar", ""); await up("portrait", ""); const withSub = await up("subtitle", "say");
  assert.ok(withSub.avatar?.id && withSub.portrait?.id); assert.deepEqual(withSub.subtitles.map((x) => x.subtitle), ["SAY"]);
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  await call(p1, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content: "I open my notebook.", character_id: ada.id });
  const msgs = await call(p2, "GET", `/api/channels/${ch}/windows/${main}/messages`);
  assert.equal(msgs.find((m) => m.content === "I open my notebook.").character_avatar_asset_id, withSub.avatar.id, "chat lines carry the character avatar");
  // Generated mode: needs the prompt; the mock image provider attaches the results.
  await rejects(call(p1, "POST", `/api/channels/${ch}/characters/${ada.id}/assets/generate`, { slots: ["portrait"] }), 409);
  const gen = await call(p1, "PUT", `/api/channels/${ch}/characters/${ada.id}/appearance`, { asset_mode: "generated", appearance_prompt: "A gaunt woman in a grey wool coat, cropped dark hair, round spectacles" });
  assert.equal(gen.character.asset_mode, "generated");
  assert.equal(gen.generation_available, true, "the server's mock image provider is on");
  {
    const r = await call(p1, "POST", `/api/channels/${ch}/characters/${ada.id}/assets/generate`, { slots: ["portrait", "avatar"], subtitles: ["IDLE", "fight"], allow_cloud: true });
    assert.equal(r.jobs.length, 4);
    const done = await waitFor(async () => { const x = await call(p1, "GET", `/api/channels/${ch}/characters/${ada.id}/space`); return x.jobs.filter((j) => j.status === "completed").length >= 4 ? x : null; });
    assert.notEqual(done.portrait.id, withSub.portrait.id, "generated portrait replaced the upload"); assert.equal(done.portrait.source_type, "mock");
    assert.deepEqual(done.subtitles.map((x) => x.subtitle).sort(), ["FIGHT", "IDLE", "SAY"]);
    const meta = await call(p2, "GET", `/api/channels/${ch}/media/${done.portrait.id}/meta`);
    assert.equal(meta.approval_status, "approved"); assert.equal(meta.character_id, ada.id); assert.match(meta.prompt, /1925, Arkham/);
    // Removing an image detaches it everywhere.
    const after = await call(p1, "DELETE", `/api/channels/${ch}/characters/${ada.id}/assets/${done.portrait.id}`);
    assert.equal(after.portrait, null);
  }
  await rejects(call(p2, "POST", `/api/channels/${ch}/characters/${ada.id}/assets/generate`, { slots: ["portrait"], allow_cloud: true }), 403);
});
