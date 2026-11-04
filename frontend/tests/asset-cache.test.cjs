const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// A minimal in-memory IndexedDB: the calls assetCache.ts and cachePolyfill.ts make.
function fakeIndexedDB() {
  const stores = new Map();
  const req = (fn) => { const r = {}; setTimeout(() => { try { r.result = fn(); r.onsuccess && r.onsuccess(); } catch (e) { r.error = e; r.onerror && r.onerror(); } }, 0); return r; };
  const objectStore = (name) => {
    const rows = stores.get(name);
    return {
      get: (k) => req(() => rows.get(k)),
      put: (v) => req(() => { rows.set(v.key, v); return v.key; }),
      delete: (k) => req(() => { rows.delete(k); }),
      clear: () => req(() => rows.clear()),
      getAll: () => req(() => [...rows.values()]),
      index: () => ({ getAll: () => req(() => [...rows.values()].sort((a, b) => (a.lastUsed ?? a.used) - (b.lastUsed ?? b.used))) }),
    };
  };
  const db = { objectStoreNames: { contains: (n) => stores.has(n) }, deleteObjectStore: (n) => stores.delete(n), createObjectStore: (n) => { stores.set(n, new Map()); return { createIndex() {} }; }, transaction: () => ({ objectStore }) };
  let created = false;   // like a real database, upgraded only the first time it is opened
  return { stores, open: () => { const r = {}; setTimeout(() => { r.result = db; if (!created) { created = true; r.onupgradeneeded && r.onupgradeneeded(); } r.onsuccess(); }, 0); return r; } };
}

// localStorage stand-in shared by every page (module instance) of one test: it is the browser profile.
const stored = new Map();
function load(file, globals) {
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  const require = (name) => name === './storage' ? { readStorage: (k) => stored.get(k) ?? null, writeStorage: (k, v) => (v === null ? stored.delete(k) : stored.set(k, v)) } : {};
  new Function('require', 'module', 'exports', ...Object.keys(globals), js)(require, module, module.exports, ...Object.values(globals));
  return module.exports;
}
const response = (body, headers = {}, init = {}) => ({ type: init.type ?? 'basic', ok: init.ok ?? true, headers: new Headers(headers), blob: async () => new Blob([body]), json: async () => JSON.parse(body) });
const tick = () => new Promise((r) => setTimeout(r, 50));   // generous: the whole suite runs in parallel
test.beforeEach(() => stored.clear());
const DAY = 24 * 60 * 60 * 1000;
const H = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('assets are keyed by content hash when the server names one, else by the URL without its token, and per account', () => {
  const c = load('lib/assetCache.ts', { indexedDB: fakeIndexedDB(), fetch: async () => response(''), location: { href: 'http://app.test/' } });
  c.setAssetScope('http://api.test|u1');
  const a = 'http://api.test/api/channels/c/media/m1?token=T1&v=2';
  assert.equal(c.assetKey(a), c.assetKey('http://api.test/api/channels/c/media/m1?v=2&token=T2'), 'a new token is the same asset');
  assert.equal(c.assetKey(a, H), c.assetKey('http://api.test/api/users/u9/avatar?v=7&token=X', H), 'the same bytes are one entry whatever shows them');
  assert.notEqual(c.assetKey(a, H), c.assetKey(a, 'f'.repeat(64)), 'a changed hash is a new entry');
  assert.notEqual(c.assetKey(a, H), c.assetKey(a), 'hash and URL keys never collide');
  assert.equal(c.assetKey('data:image/png;base64,AA'), ''); assert.equal(c.assetKey('blob:http://x/1'), '');
  assert.equal(c.contentKey(null), null); assert.equal(c.contentKey(''), null);
  const u1 = c.assetKey(a, H); c.setAssetScope('http://api.test|u2');
  assert.notEqual(c.assetKey(a, H), u1, 'another account is another scope');
});

test('eviction drops what was not shown for 30 days, then the least recently used until the budget fits', () => {
  const c = load('lib/assetCache.ts', { indexedDB: fakeIndexedDB(), fetch: async () => response(''), location: { href: 'http://app.test/' } });
  const now = 100 * DAY;
  assert.ok(c.ASSET_CACHE_MAX_AGE_MS >= 30 * DAY);
  const entries = [
    { key: 'fresh', bytes: 10, lastUsed: now - 1 * DAY, storedAt: now - 60 * DAY },   // stored long ago but shown yesterday: stays
    { key: 'stale', bytes: 10, lastUsed: now - 31 * DAY, storedAt: now - 31 * DAY },  // not shown for 31 days: goes
    { key: 'edge', bytes: 10, lastUsed: now - 30 * DAY, storedAt: now - 30 * DAY },   // exactly 30 days: stays
  ];
  assert.deepEqual(c.planEviction(entries, now), ['stale']);
  const big = [
    { key: 'a', bytes: 40, lastUsed: now - 5 * DAY, storedAt: now }, { key: 'b', bytes: 40, lastUsed: now - 2 * DAY, storedAt: now },
    { key: 'c', bytes: 40, lastUsed: now - 1 * DAY, storedAt: now }, { key: 'old', bytes: 1, lastUsed: now - 40 * DAY, storedAt: now },
  ];
  assert.deepEqual(c.planEviction(big, now, { maxAgeMs: 30 * DAY, maxBytes: 85 }).sort(), ['a', 'old']);
  assert.deepEqual(c.planEviction(big, now, { maxAgeMs: 30 * DAY, maxBytes: 200 }), ['old']);
  assert.deepEqual(c.planEviction([], now), []);
  assert.equal(c.formatCacheSize(1.5 * 1024 * 1024), '1.5 MB');
});

test('only immutable responses are kept; a kept picture is served from the store across pages and token renewals', async () => {
  const idb = fakeIndexedDB(); const seen = [];
  let reply = () => response('PIXELS', { 'Cache-Control': 'private, max-age=31536000, immutable' });
  const fetch = async (url, init) => { seen.push({ url, init }); return reply(url); };
  const c = load('lib/assetCache.ts', { indexedDB: idb, fetch, location: { href: 'http://app.test/' } });
  c.setAssetScope('http://api.test|u1');
  const a = 'http://api.test/api/channels/c/media/m1?token=T1&v=2';
  assert.match(await c.cachedSrc(a, H), /^blob:/);
  assert.equal(seen[0].init.redirect, 'manual'); assert.equal(seen[0].init.credentials, 'omit');
  assert.equal(new URL(seen[0].url).searchParams.get('direct'), '1', 'the API is asked for the bucket URL, not a redirect');
  await tick();
  const rows = [...idb.stores.get('assets').values()];
  assert.equal(rows.length, 1, 'kept on disk'); assert.ok(rows[0].key.endsWith(`sha:${H}`)); assert.ok(rows[0].lastUsed > 0); assert.equal(rows[0].bytes, 6);
  // A fresh page with a renewed token, and another asset that shows the same bytes: served from the store, no download.
  const c2 = load('lib/assetCache.ts', { indexedDB: idb, fetch, location: { href: 'http://app.test/' } });
  c2.setAssetScope('http://api.test|u1');
  assert.match(await c2.cachedSrc('http://api.test/api/channels/c/media/m1?v=2&token=T9', H), /^blob:/);
  assert.match(await c2.cachedSrc('http://api.test/api/channels/other/media/m7?v=1&token=T9', H), /^blob:/);
  assert.equal(seen.length, 1, 'not downloaded again');
  // Showing it refreshed its lifespan; an entry not shown for 30 days is dropped and downloaded afresh.
  const row = [...idb.stores.get('assets').values()][0];
  row.lastUsed = Date.now() - 31 * DAY;
  const c3 = load('lib/assetCache.ts', { indexedDB: idb, fetch, location: { href: 'http://app.test/' } });
  c3.setAssetScope('http://api.test|u1');
  assert.match(await c3.cachedSrc(a, H), /^blob:/);
  assert.equal(seen.length, 2, 'expired: downloaded again');
  // Another account on the same device starts empty.
  const c4 = load('lib/assetCache.ts', { indexedDB: idb, fetch, location: { href: 'http://app.test/' } });
  c4.setAssetScope('http://api.test|u2'); await tick();
  assert.equal(idb.stores.get('assets').size, 0, 'another account signing in empties the device');
  await c4.cachedSrc(a, H); assert.equal(seen.length, 3);
  // Not immutable (the current version, GM-private material): used, never kept.
  reply = () => response('X', { 'Cache-Control': 'private, max-age=3600' });
  const secret = 'http://api.test/api/channels/c/media/secret?v=1&token=T';
  assert.match(await c4.cachedSrc(secret), /^blob:/, 'shown from the bytes just downloaded');
  assert.equal(c4.peekSrc(secret), undefined, 'but not remembered');
  await tick();
  assert.equal([...idb.stores.get('assets').keys()].filter((k) => k.includes('secret')).length, 0);
  // An object in the public bucket: the API names its URL and whether it may be kept; it is fetched from the bucket in
  // one hop (the page's own origin), past the browser's HTTP cache, and kept by its hash when the API allows.
  const bucket = (keep) => (url) => url.startsWith('https://static.test/')
    ? response('BUCKET', { 'Cache-Control': 'public, max-age=31536000, immutable' }, { type: 'cors' })
    : response(JSON.stringify({ url: 'https://static.test/pub/art.png', keep }), { 'Content-Type': 'application/vnd.acerciae.direct+json' });
  reply = bucket(true); seen.length = 0;
  const pub = 'http://api.test/api/channels/c/media/art?v=1&token=T';
  assert.match(await c4.cachedSrc(pub, 'a'.repeat(64)), /^blob:/); await tick();
  assert.equal(seen.length, 2); assert.equal(seen[1].url, 'https://static.test/pub/art.png');
  assert.equal(seen[1].init.cache, 'no-store'); assert.equal(seen[1].init.credentials, 'omit');
  assert.equal([...idb.stores.get('assets').keys()].filter((k) => k.endsWith('sha:' + 'a'.repeat(64))).length, 1, 'the bucket\'s object is kept by its hash');
  // The bucket marks everything immutable, but GM-private material (keep: false) is shown, never kept.
  reply = bucket(false);
  const npc = 'http://api.test/api/channels/c/media/npc?v=1&token=T';
  assert.match(await c4.cachedSrc(npc, 'b'.repeat(64)), /^blob:/); await tick();
  assert.equal(c4.peekSrc(npc, 'b'.repeat(64)), undefined);
  assert.equal([...idb.stores.get('assets').keys()].filter((k) => k.endsWith('sha:' + 'b'.repeat(64))).length, 0);
  // A bucket whose CORS policy refuses the page, a URL that is not http(s), or an older server's redirect: the
  // browser loads the URL itself, as before.
  const art2 = 'http://api.test/api/channels/c/media/art2?v=1&token=T';
  reply = (url) => { if (url.startsWith('https://static.test/')) throw new TypeError('CORS'); return bucket(true)(url); };
  assert.equal(await c4.cachedSrc(art2), art2);
  reply = () => response(JSON.stringify({ url: 'javascript:alert(1)', keep: true }), { 'Content-Type': 'application/vnd.acerciae.direct+json' });
  assert.equal(await c4.cachedSrc(art2), art2);
  reply = () => response('', {}, { type: 'opaqueredirect', ok: false });
  assert.equal(await c4.cachedSrc(pub), pub);
  // Only the routes that can hand over to the bucket are asked for a direct URL.
  assert.match(c4.directUrl('http://api.test/api/users/u1/avatar?v=3&token=T'), /direct=1/);
  assert.match(c4.directUrl('http://api.test/api/channels/c/studio/tts/audio/a1?token=T'), /direct=1/);
  assert.equal(c4.directUrl('http://api.test/api/channels/c/atmosphere/assets/x?token=T'), 'http://api.test/api/channels/c/atmosphere/assets/x?token=T');
  assert.equal(c4.directUrl('https://elsewhere.test/signed.png?sig=abc'), 'https://elsewhere.test/signed.png?sig=abc');
  assert.equal(await c4.cachedSrc('data:image/png;base64,AA'), 'data:image/png;base64,AA');
  assert.deepEqual(await c4.cacheStats(), { entries: 2, bytes: 12 });
  await c4.clearAssetCache();
  assert.equal(idb.stores.get('assets').size, 0);
});

test('a failed download, or no IndexedDB, falls back to the URL itself', async () => {
  const c = load('lib/assetCache.ts', { indexedDB: fakeIndexedDB(), fetch: async () => { throw new Error('offline'); }, location: { href: 'http://app.test/' } });
  const u = 'http://api.test/api/users/u1/avatar?v=3&token=T';
  assert.equal(await c.cachedSrc(u), u);
  const none = load('lib/assetCache.ts', { fetch: async () => { throw new Error('offline'); }, location: { href: 'http://app.test/' } });
  assert.equal(await none.cachedSrc(u, H), u);
  assert.deepEqual(await none.cacheStats(), { entries: 0, bytes: 0 });
});

test('the model cache stand-in keeps files where the webview has no Cache API', async () => {
  const idb = fakeIndexedDB();
  const p = load('lib/speech/cachePolyfill.ts', { indexedDB: idb });
  const scope = {};
  assert.equal(p.installCachePolyfill(scope), true);
  const cache = await scope.caches.open('transformers-cache');
  assert.equal(await cache.match('https://hf.co/model.onnx'), undefined);
  await cache.put('https://hf.co/model.onnx', new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } }));
  const hit = await cache.match('https://hf.co/model.onnx');
  assert.deepEqual([...new Uint8Array(await hit.arrayBuffer())], [1, 2, 3]);
  assert.equal(hit.headers.get('content-type'), 'application/octet-stream');
  assert.equal(p.installCachePolyfill({ caches: {} }), false, 'a real Cache API is left alone');
});
