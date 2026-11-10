import { test } from "node:test";
import assert from "node:assert/strict";
// Pictures uploaded into chat: a member posts an image of their own (a handout, a map, a photo) as their line, like a
// text line would be, with an optional caption. Only those who may read the line may load the picture; a recalled
// line takes its picture with it. No image AI is involved, so the illustration switches do not apply.
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body, raw) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { "Content-Type": "application/json" }) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status, body: data });
  return data;
}
const rejects = async (p, status) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail(`expected HTTP ${status}`); };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0"), Buffer.alloc(64)]);
const fileToken = async (token) => (await call(token, "POST", "/api/auth/file-token")).token;
const picture = async (token, ch, mid, query = "") => fetch(`${base}/api/channels/${ch}/messages/${mid}/image?token=${encodeURIComponent(await fileToken(token))}${query}`);

test("uploaded pictures: posted as the sender's line with a caption, served to its readers only, gone with a recalled line", async () => {
  const s = Math.random().toString(36).slice(2, 8); const u = {};
  for (const r of ["gm", "p1", "p2"]) u[r] = await call(null, "POST", "/api/auth/register", { username: `im${r}${s}`, password: "password", display_name: r });
  const gm = u.gm.token, p1 = u.p1.token, p2 = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Pictures" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Study", knowledge_mode: "isolated" })).id;
  for (const r of ["p1", "p2"]) await call(gm, "POST", `/api/channels/${ch}/members`, { username: `im${r}${s}`, role: "player" });
  const main = (await call(gm, "GET", `/api/channels/${ch}/windows`))[0].id;
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada" });
  const mo = await call(p2, "POST", `/api/channels/${ch}/characters`, { name: "Mo" });
  const upload = (token, w, fields = {}, bytes = PNG, name = "letter.png", type = "image/png") => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (bytes) fd.append("file", new Blob([bytes], { type }), name);
    return call(token, "POST", `/api/channels/${ch}/windows/${w}/images`, undefined, fd);
  };
  const library = async () => (await call(gm, "GET", `/api/channels/${ch}/media`)).filter((m) => m.source_type === "upload" && m.asset_type === "illustration");

  // The image AI is neither configured nor allowed here: uploading does not depend on it.
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { features: { illustrations: false } });
  await rejects(call(p1, "POST", `/api/channels/${ch}/windows/${main}/illustrations`, { prompt: "Ada reads", character_ids: [], allow_cloud: true }), 403);

  // The GM posts a handout as narration: the caption follows the picture mark; everyone in the window gets the line.
  const handout = await upload(gm, main, { kind: "narration", content: "  A torn page: \"Meet me at the pier at midnight.\"  " });
  assert.equal(handout.kind, "narration"); assert.equal(handout.content, "🖼️ A torn page: \"Meet me at the pier at midnight.\"");
  assert.ok(handout.media_asset_id); assert.equal(handout.visibility, "window"); assert.equal(handout.author_id, u.gm.user.id);
  for (const t of [gm, p1, p2]) {
    const line = (await call(t, "GET", `/api/channels/${ch}/windows/${main}/messages`)).find((m) => m.id === handout.id);
    assert.equal(line.media_asset_id, handout.media_asset_id);
    const r = await picture(t, ch, handout.id);
    assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("cache-control"), /no-store/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  }
  // Saved as a file it is named after its caption (its first 40 characters), as an uploaded picture.
  const saved = await picture(p1, ch, handout.id, "&download=1");
  assert.match(saved.headers.get("content-disposition"), /^attachment; filename="picture-\d{4}-\d{2}-\d{2}-A-torn-page-Meet-me-at-the-pier-at-mid\.png"/);
  // The story's record carries the caption, so the AI and the log read what the picture shows.
  const event = (await call(gm, "GET", `/api/channels/${ch}/events?limit=20`)).find((e) => e.payload.media_asset_id === handout.media_asset_id);
  assert.equal(event.payload.content, handout.content); assert.equal(event.payload.message_kind, "narration");

  // A player posts in character; no caption is fine (the line is the mark alone); other formats are told by content.
  const shown = await upload(p1, main, { kind: "ic", character_id: ada.id, content: "I lay the photograph on the desk." }, JPEG, "IMG_0001.JPG", "image/jpeg");
  assert.equal(shown.kind, "ic"); assert.equal(shown.character_id, ada.id); assert.equal(shown.character_name, "Ada"); assert.equal(shown.content, "🖼️ I lay the photograph on the desk.");
  assert.equal((await picture(p2, ch, shown.id)).headers.get("content-type"), "image/jpeg");
  const bare = await upload(p2, main, { kind: "ooc" }, GIF, "wrongly-named.png", "image/png");
  assert.equal(bare.content, "🖼️"); assert.equal(bare.kind, "ooc");
  const gif = await picture(p1, ch, bare.id, "&download=1");
  assert.equal(gif.headers.get("content-type"), "image/gif"); assert.match(gif.headers.get("content-disposition"), /filename="picture-\d{4}-\d{2}-\d{2}\.gif"/);
  // A caption that looks like a dice command is a caption: nothing is rolled.
  const dotted = await upload(p1, main, { kind: "ooc", content: ".ra Spot Hidden" });
  assert.equal(dotted.kind, "ooc"); assert.equal(dotted.dice, null); assert.equal(dotted.content, "🖼️ .ra Spot Hidden");
  // The GM finds the pictures in the media library (private chat art); players do not.
  assert.equal((await library()).length, 4);
  assert.ok(!(await call(p1, "GET", `/api/channels/${ch}/media`)).some((m) => m.id === handout.media_asset_id));
  await rejects(fetch(`${base}/api/channels/${ch}/media/${handout.media_asset_id}/file?token=${encodeURIComponent(await fileToken(p1))}`).then((r) => { if (!r.ok) throw Object.assign(Error("refused"), { status: r.status }); }), 404);

  // What is refused, leaving nothing stored: no file, an empty one, not an image (whatever it is called), an SVG, too
  // large, a roll, someone else's character, a player's whisper, a whisper to nobody, a caption beyond the limit.
  await rejects(upload(p1, main, { kind: "ic" }, null), 400);
  await rejects(upload(p1, main, {}, Buffer.alloc(0)), 400);
  await rejects(upload(p1, main, {}, Buffer.from("just text, called a picture"), "notes.png"), 400);
  await rejects(upload(p1, main, {}, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "x.svg", "image/svg+xml"), 400);
  await rejects(upload(p1, main, {}, Buffer.from("%PDF-1.4 not a picture"), "scan.pdf", "application/pdf"), 400);
  assert.equal((await rejects(upload(p1, main, {}, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)])), 413)).body.error, "too_large");
  await rejects(upload(p1, main, { kind: "roll" }), 400);
  await rejects(upload(p1, main, { kind: "ic", character_id: mo.id }), 403);
  await rejects(upload(p1, main, { visibility: "gm_only" }), 403);
  await rejects(upload(gm, main, { visibility: "whisper" }), 400);
  await rejects(upload(p1, main, { content: "x".repeat(2001) }), 400);
  await rejects(upload(p1, "00000000-0000-4000-8000-000000000001", {}), 404);
  assert.equal((await library()).length, 4, "a refused picture leaves no file behind");

  // The GM's whisper and note carry pictures too: only their readers get the line and the picture.
  const secret = await upload(gm, main, { kind: "narration", visibility: "whisper", whisper_to: ` ${ada.id} , `, content: "Only you notice the seal." });
  assert.equal(secret.visibility, "whisper"); assert.deepEqual(secret.whisper_to, [ada.id]);
  assert.equal((await picture(p1, ch, secret.id)).status, 200);
  assert.equal((await picture(p2, ch, secret.id)).status, 404);
  assert.ok(!(await call(p2, "GET", `/api/channels/${ch}/windows/${main}/messages`)).some((m) => m.id === secret.id));
  const note = await upload(gm, main, { kind: "ooc", visibility: "gm_only", content: "The real map, for me." });
  assert.equal((await picture(gm, ch, note.id)).status, 200);
  assert.equal((await picture(p1, ch, note.id)).status, 404);

  // A private window: the picture stays with its members. Someone outside cannot post there either.
  const den = await call(gm, "POST", `/api/channels/${ch}/windows`, { name: "The den", kind: "private", members: [{ user_id: u.p1.user.id, character_id: ada.id }] });
  const inDen = await upload(p1, den.id, { kind: "ic", content: "A sketch of the cellar." });
  assert.equal((await picture(gm, ch, inDen.id)).status, 200);
  assert.equal((await picture(p2, ch, inDen.id)).status, 404);
  await rejects(upload(p2, den.id, {}), 403);

  // Recalled by its author: the line becomes a tombstone, the picture is no longer served and its file is deleted.
  const before = (await library()).length;
  const wrong = await upload(p1, main, { kind: "ooc", content: "wrong file, sorry" });
  assert.equal((await library()).length, before + 1);
  const taken = await call(p1, "POST", `/api/channels/${ch}/messages/${wrong.id}/recall`);
  assert.ok(taken.message.recalled_at); assert.equal(taken.content, "🖼️ wrong file, sorry");
  assert.equal((await picture(p1, ch, wrong.id)).status, 404);
  assert.equal((await library()).length, before, "the uploaded file went with the line");
  assert.ok(!(await library()).some((m) => m.id === wrong.media_asset_id));
  await call(p1, "POST", `/api/channels/${ch}/messages/${wrong.id}/recall`);   // again: nothing more to do
  // An archived window takes no pictures.
  await call(gm, "PUT", `/api/channels/${ch}/windows/${den.id}`, { archived: true });
  await rejects(upload(p1, den.id, {}), 409);
});
