import { test } from "node:test";
import assert from "node:assert/strict";
// Run against an isolated server: API_BASE=http://127.0.0.1:8080 node --test tests/integration/asset-cache.test.mjs
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body, raw) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { "Content-Type": "application/json" }) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const get = (token, path, headers = {}) => fetch(base + path, { headers: { Authorization: `Bearer ${token}`, ...headers }, redirect: "manual" });

test("asset caching: versioned player-visible assets may be kept for good, the rest revalidate by ETag, GM-private never kept", async () => {
  const s = Math.random().toString(36).slice(2); const u = {};
  for (const r of ["gm", "p1"]) u[r] = await call(null, "POST", "/api/auth/register", { username: r + s, password: "password", display_name: r });
  const gm = u.gm.token, p1 = u.p1.token;
  const server = await call(gm, "POST", "/api/servers", { name: "Cache" });
  const ch = (await call(gm, "POST", `/api/servers/${server.id}/channels`, { name: "Arkham", knowledge_mode: "isolated" })).id;
  await call(gm, "POST", `/api/channels/${ch}/members`, { username: "p1" + s, role: "player" });
  const ada = await call(p1, "POST", `/api/channels/${ch}/characters`, { name: "Ada Quill" });
  const fd = new FormData(); fd.append("slot", "avatar"); fd.append("subtitle", ""); fd.append("file", new Blob([PNG], { type: "image/png" }), "a.png");
  const space = await call(p1, "POST", `/api/channels/${ch}/characters/${ada.id}/assets`, undefined, fd);
  const asset = space.avatar;

  // A named version: kept for good, with an ETag; a revalidation is a 304 without a body.
  const pinned = await get(p1, `/api/channels/${ch}/media/${asset.id}?v=${asset.version ?? 1}`);
  assert.equal(pinned.status, 200);
  assert.equal(pinned.headers.get("cache-control"), "private, max-age=31536000, immutable");
  const etag = pinned.headers.get("etag");
  assert.match(etag, /^".+"$/);
  const again = await get(p1, `/api/channels/${ch}/media/${asset.id}?v=${asset.version ?? 1}`, { "If-None-Match": etag });
  assert.equal(again.status, 304); assert.equal((await again.arrayBuffer()).byteLength, 0);
  // The current version (no ?v=) may change: it revalidates.
  const current = await get(p1, `/api/channels/${ch}/media/${asset.id}`);
  assert.equal(current.headers.get("cache-control"), "private, no-cache"); assert.equal(current.headers.get("etag"), etag);

  // GM-private material is never marked for keeping, even for the Keeper.
  const gmFd = new FormData(); gmFd.append("gm_only", "true"); gmFd.append("file", new Blob([PNG], { type: "image/png" }), "secret.png");
  const secret = await call(gm, "POST", `/api/channels/${ch}/media`, undefined, gmFd);
  const gmView = await get(gm, `/api/channels/${ch}/media/${secret.id}?v=1`);
  assert.equal(gmView.status, 200);
  assert.ok(!/immutable/.test(gmView.headers.get("cache-control")), gmView.headers.get("cache-control"));
  assert.equal((await get(p1, `/api/channels/${ch}/media/${secret.id}?v=1`)).status, 404, "and players cannot read it");

  // User avatars: ?v= is kept, a bare URL revalidates; both carry an ETag.
  await call(p1, "PUT", "/api/auth/me", { avatar_data: `data:image/png;base64,${PNG.toString("base64")}` });
  const av = await get(p1, `/api/users/${u.p1.user.id}/avatar?v=1`);
  assert.equal(av.status, 200); assert.equal(av.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal((await get(p1, `/api/users/${u.p1.user.id}/avatar?v=1`, { "If-None-Match": av.headers.get("etag") })).status, 304);
  assert.equal((await get(p1, `/api/users/${u.p1.user.id}/avatar`)).headers.get("cache-control"), "private, no-cache");
});
