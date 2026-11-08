import { test } from "node:test";
import assert from "node:assert/strict";
// Illustrations in chat: a member describes a moment, picks characters as references, and the picture is posted in
// the window as their out-of-character line, readable only by those who may read the line.
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body, raw) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { "Content-Type": "application/json" }) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, body: data });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw Error("timeout"); await new Promise((r) => setTimeout(r, 300)); } };
const fileToken = async (token) => (await call(token, "POST", "/api/auth/file-token")).token;
const picture = async (token, ch, mid) => fetch(`${base}/api/channels/${ch}/messages/${mid}/image?token=${encodeURIComponent(await fileToken(token))}`);

test("illustrations: drawn from a description and chosen characters, posted as the requester's line, seen only by its readers", async () => {
  const s = Math.random().toString(36).slice(2, 8); const u = {};
  for (const r of ["gm", "p1", "p2"]) u[r] = await call(null, "POST", "/api/auth/register", { username: `il${r}${s}`, password: "password", display_name: r });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Illustrated" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Harbour", knowledge_mode: "isolated" })).id;
  for (const r of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: `il${r}${s}`, role: "player" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada" });
  const mo = await call(p2, "POST", `/api/channels/${ch}/characters`, { name: "Mo" });
  const npc = await call(gm, "POST", `/api/channels/${ch}/characters`, { name: "Old Tom", kind: "npc" });
  await call(p1, "PUT", `/api/channels/${ch}/characters/${ada.id}/appearance`, { asset_mode: "uploaded", appearance_prompt: "a tall reporter in a green coat" });
  const fd = new FormData(); fd.append("slot", "portrait"); fd.append("subtitle", ""); fd.append("file", new Blob([PNG], { type: "image/png" }), "ada.png");
  await call(p1, "POST", `/api/channels/${ch}/characters/${ada.id}/assets`, undefined, fd);
  const draw = (token, w, body) => call(token, "POST", `/api/channels/${ch}/windows/${w}/illustrations`, { allow_cloud: true, ...body });

  // No image provider yet: refused with the reason.
  await rejects(draw(p1, main, { prompt: "Ada on the pier", character_ids: [ada.id] }), 400);
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { image: { provider: "mock" } });

  // Optional at both levels and on until switched off: the server's maintainers switch it for the server, the GM for
  // the channel under it. Off refuses everyone, the GM included.
  assert.equal((await call(p1, "GET", `/api/servers/${server.id}/settings`)).features.illustrations, true);
  assert.equal((await call(p1, "GET", `/api/channels/${ch}`)).illustrations_enabled, true);
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { illustrations: false } });
  assert.equal((await rejects(draw(p1, main, { prompt: "Ada on the pier" }), 403)).body.error, "feature_disabled");
  await rejects(draw(gm, main, { prompt: "Ada on the pier" }), 403);
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { illustrations: true } });
  await rejects(call(p1, "PUT", `/api/channels/${ch}`, { illustrations_enabled: false }), 403);   // the GM's switch
  assert.equal((await call(gm, "PUT", `/api/channels/${ch}`, { illustrations_enabled: false })).illustrations_enabled, false);
  assert.equal((await rejects(draw(p1, main, { prompt: "Ada on the pier" }), 403)).body.error, "feature_disabled");
  await rejects(draw(gm, main, { prompt: "Ada on the pier" }), 403);
  await call(gm, "PUT", `/api/channels/${ch}`, { illustrations_enabled: true });

  // Bad requests.
  await rejects(draw(p1, main, { prompt: "  ", character_ids: [] }), 400);
  await rejects(draw(p1, main, { prompt: "x".repeat(1501) }), 400);
  await rejects(draw(p1, main, { prompt: "Ada", orientation: "diagonal" }), 400);
  await rejects(draw(p1, main, { prompt: "Ada", character_ids: ["not-a-uuid"] }), 400);
  await rejects(draw(p1, main, { prompt: "Ada", character_ids: [1, 2, 3, 4, 5, 6, 7].map((n) => `00000000-0000-4000-8000-00000000000${n}`) }), 400);   // at most six
  await rejects(draw(p1, main, { prompt: "Ada", character_ids: ["00000000-0000-4000-8000-000000000009"] }), 400);   // not in this channel
  await rejects(draw(p1, main, { prompt: "Tom at the bar", character_ids: [npc.id] }), 403);   // players picture player characters only

  // Ada's player draws Ada and Mo in the Main Chat.
  const job = await draw(p1, main, { prompt: "Ada and Mo whisper on the rainy pier at dusk", character_ids: [ada.id, mo.id, ada.id], orientation: "portrait" });
  assert.equal(job.kind, "illustration"); assert.equal(job.reference_count, 1, "Ada's portrait goes along; Mo has none");
  const done = await waitFor(async () => { const mine = await call(p1, "GET", `/api/channels/${ch}/illustrations`); const j = mine.find((x) => x.id === job.id); return j && ["completed", "failed"].includes(j.status) && (j.status !== "completed" || j.message_id) ? j : null; });
  assert.equal(done.status, "completed", done.error); assert.equal(done.prompt, "Ada and Mo whisper on the rainy pier at dusk");
  assert.deepEqual(done.character_ids, [ada.id, mo.id], "duplicates collapse"); assert.equal(done.orientation, "portrait");
  const line = (await call(p2, "GET", `/api/channels/${ch}/windows/${main}/messages`)).find((m) => m.id === done.message_id);
  assert.ok(line, "Mo's player reads the line"); assert.equal(line.kind, "ooc"); assert.equal(line.author_id, u.p1.user.id);
  assert.match(line.content, /^🖼️ Ada and Mo whisper on the rainy pier at dusk$/); assert.ok(line.media_asset_id);
  const img = await picture(p2, ch, line.id);
  assert.equal(img.status, 200); assert.match(img.headers.get('cache-control'), /no-store/); assert.match(img.headers.get("content-type"), /^image\//);
  assert.equal((await picture(p1, ch, line.id)).status, 200);
  assert.equal((await fetch(`${base}/api/channels/${ch}/messages/${line.id}/image`)).status, 401, "a file token is needed");
  // Saved as a file: the bytes with a readable name, never a redirect.
  const saved = await fetch(`${base}/api/channels/${ch}/messages/${line.id}/image?download=1&token=${encodeURIComponent(await fileToken(p2))}`, { redirect: "manual" });
  assert.equal(saved.status, 200); assert.match(saved.headers.get("content-type"), /^image\//);
  const disposition = saved.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment; filename="illustration-\d{4}-\d{2}-\d{2}-Ada-and-Mo-whisper-on-the-rainy-pier-at\.png"; filename\*=UTF-8''illustration-/);
  assert.ok((await saved.arrayBuffer()).byteLength > 0);
  // The picture is the line's, not the media library's: players do not find it there.
  const library = await call(p2, "GET", `/api/channels/${ch}/media`);
  assert.ok(!(library.assets ?? library).some((a) => a.id === line.media_asset_id));

  // In Ada's private window, only Ada's player and the GM see it.
  const priv = (await call(gm, "POST", `/api/channels/${ch}/windows`, { name: "Ada alone", kind: "private", members: [{ user_id: u.p1.user.id, character_id: ada.id }] })).id;
  await rejects(draw(p2, priv, { prompt: "Mo sneaks in" }), 403);   // not a member of that window
  const secret = await draw(p1, priv, { prompt: "Ada reads the ledger by candlelight", character_ids: [ada.id], orientation: "square" });
  const posted = await waitFor(async () => { const j = (await call(p1, "GET", `/api/channels/${ch}/illustrations`)).find((x) => x.id === secret.id); return j?.message_id ? j : null; });
  assert.equal((await picture(p1, ch, posted.message_id)).status, 200);
  assert.equal((await picture(gm, ch, posted.message_id)).status, 200);
  assert.equal((await picture(p2, ch, posted.message_id)).status, 404, "Mo's player may not read that line, so not its picture");
  assert.equal((await fetch(`${base}/api/channels/${ch}/messages/${posted.message_id}/image?download=1&token=${encodeURIComponent(await fileToken(p2))}`)).status, 404, "nor save it");

  // The GM may picture an NPC; the job list is each requester's own.
  const tom = await draw(gm, main, { prompt: "Old Tom polishes a glass, seen from behind the bar", character_ids: [npc.id] });
  await waitFor(async () => (await call(gm, "GET", `/api/channels/${ch}/illustrations`)).find((x) => x.id === tom.id && x.message_id));
  assert.ok(!(await call(p1, "GET", `/api/channels/${ch}/illustrations`)).some((x) => x.id === tom.id));
  // Someone else's illustration cannot be cancelled; a finished one cannot be either.
  await rejects(call(p2, "POST", `/api/channels/${ch}/illustrations/${job.id}/cancel`), 403);
  await rejects(call(p1, "POST", `/api/channels/${ch}/illustrations/${job.id}/cancel`), 409);
  // A line without a picture has none to serve.
  const plain = await call(p1, "POST", `/api/channels/${ch}/windows/${main}/messages`, { content: "No picture here.", character_id: ada.id });
  assert.equal((await picture(p1, ch, plain.id)).status, 404);

  // Switched off afterwards: no new drawing, but the pictures already posted stay, and so does the job list.
  await call(gm, "PUT", `/api/channels/${ch}`, { illustrations_enabled: false });
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { illustrations: false } });
  await rejects(draw(p1, main, { prompt: "One more" }), 403);
  assert.equal((await picture(p2, ch, line.id)).status, 200, "a posted picture stays");
  assert.ok((await call(p1, "GET", `/api/channels/${ch}/illustrations`)).some((x) => x.id === job.id));
});
