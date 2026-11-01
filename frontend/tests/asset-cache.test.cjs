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
      index: () => ({ getAll: () => req(() => [...rows.values()].sort((a, b) => a.used - b.used)) }),
    };
  };
  const db = { createObjectStore: (n) => { stores.set(n, new Map()); return { createIndex() {} }; }, transaction: () => ({ objectStore }) };
  let created = false;   // like a real database, upgraded only the first time it is opened
  return { stores, open: () => { const r = {}; setTimeout(() => { r.result = db; if (!created) { created = true; r.onupgradeneeded && r.onupgradeneeded(); } r.onsuccess(); }, 0); return r; } };
}

function load(file, globals) {
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', ...Object.keys(globals), js)(module, module.exports, ...Object.values(globals));
  return module.exports;
}

const response = (body, headers = {}, init = {}) => ({ type: init.type ?? 'basic', ok: init.ok ?? true, headers: new Headers(headers), blob: async () => new Blob([body]) });

test('assets are keyed without the file token and per account; only immutable responses are kept', async () => {
  const idb = fakeIndexedDB(); const seen = [];
  let reply = () => response('PIXELS', { 'Cache-Control': 'private, max-age=31536000, immutable' });
  const fetch = async (url, init) => { seen.push({ url, init }); return reply(url); };
  const c = load('lib/assetCache.ts', { indexedDB: idb, fetch, location: { href: 'http://app.test/' } });
  c.setAssetScope('http://api.test|u1');
  const a = 'http://api.test/api/channels/c/media/m1?token=T1&v=2';
  assert.equal(c.assetKey(a), c.assetKey('http://api.test/api/channels/c/media/m1?v=2&token=T2'), 'a new token is the same asset');
  const src = await c.cachedSrc(a);
  assert.match(src, /^blob:/);
  assert.equal(seen[0].init.redirect, 'manual');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(idb.stores.get('assets').size, 1, 'kept on disk');
  // A fresh page (memory gone) with a renewed token: served from the store, no download.
  const c2 = load('lib/assetCache.ts', { indexedDB: idb, fetch, location: { href: 'http://app.test/' } });
  c2.setAssetScope('http://api.test|u1');
  assert.match(await c2.cachedSrc('http://api.test/api/channels/c/media/m1?v=2&token=T9'), /^blob:/);
  assert.equal(seen.length, 1, 'not downloaded again');
  // Another account on the same device does not share it.
  c2.setAssetScope('http://api.test|u2');
  await c2.cachedSrc(a);
  assert.equal(seen.length, 2);
  // Not immutable (the current version, GM-private material): used, never kept.
  reply = () => response('X', { 'Cache-Control': 'private, max-age=3600' });
  const secret = 'http://api.test/api/channels/c/media/secret?v=1&token=T';
  assert.match(await c2.cachedSrc(secret), /^blob:/, 'shown from the bytes just downloaded');
  assert.equal(c2.peekSrc(secret), undefined, 'but not remembered');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal([...idb.stores.get('assets').keys()].filter((k) => k.includes('secret')).length, 0);
  // A redirect to the public bucket is left to the browser.
  reply = () => response('', {}, { type: 'opaqueredirect', ok: false });
  const pub = 'http://api.test/api/channels/c/media/art?v=1&token=T';
  assert.equal(await c2.cachedSrc(pub), pub);
  // Data URIs pass through; signing out empties the store.
  assert.equal(await c2.cachedSrc('data:image/png;base64,AA'), 'data:image/png;base64,AA');
  await c2.clearAssetCache();
  assert.equal(idb.stores.get('assets').size, 0);
});

test('a failed download falls back to the URL itself', async () => {
  const c = load('lib/assetCache.ts', { indexedDB: fakeIndexedDB(), fetch: async () => { throw new Error('offline'); }, location: { href: 'http://app.test/' } });
  const u = 'http://api.test/api/users/u1/avatar?v=3&token=T';
  assert.equal(await c.cachedSrc(u), u);
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
