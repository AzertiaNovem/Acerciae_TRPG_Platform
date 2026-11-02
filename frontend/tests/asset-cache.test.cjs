const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// The device media cache (lib/assetCache): what is cacheable, how it is keyed, and what eviction drops.
const source = fs.readFileSync(path.join(__dirname, '../src/lib/assetCache.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
const stored = new Map();
new Function('require', 'module', 'exports', js)((name) => name === '../api/client' ? { getToken: () => 'tok' } : { readStorage: (k) => stored.get(k) ?? null, writeStorage: (k, v) => (v === null ? stored.delete(k) : stored.set(k, v)) }, mod, mod.exports);
const { planEviction, mediaKey, avatarKey, atmosphereKey, ttsKey, ASSET_CACHE_MAX_AGE_MS, ASSET_CACHE_MAX_BYTES, formatCacheSize, resolveAsset, peekAsset } = mod.exports;
const DAY = 24 * 60 * 60 * 1000;

test('only immutable content gets a cache key: versioned media and avatars, atmosphere images, voice clips', () => {
  assert.equal(mediaKey('ch', 'a', 3), 'media:ch:a:v3');
  assert.equal(mediaKey('ch', 'a', undefined), null, 'an asset without a version may change under the same URL');
  assert.equal(mediaKey('ch', 'a', null), null);
  assert.equal(avatarKey('u', 2), 'avatar:u:v2'); assert.equal(avatarKey('u', 0), null);
  assert.equal(atmosphereKey('ch', 'img'), 'atmosphere:ch:img'); assert.equal(ttsKey('ch', 'clip'), 'tts:ch:clip');
});

test('eviction drops what was not used for 30 days, then the least recently used until the budget fits', () => {
  const now = 100 * DAY;
  assert.ok(ASSET_CACHE_MAX_AGE_MS >= 30 * DAY, 'assets live at least 30 days');
  const entries = [
    { key: 'fresh', bytes: 10, lastUsed: now - 1 * DAY, storedAt: now - 60 * DAY },      // old but used yesterday: stays
    { key: 'stale', bytes: 10, lastUsed: now - 31 * DAY, storedAt: now - 31 * DAY },     // unused for 31 days: goes
    { key: 'edge', bytes: 10, lastUsed: now - 30 * DAY, storedAt: now - 30 * DAY },      // exactly 30 days: stays
  ];
  assert.deepEqual(planEviction(entries, now), ['stale']);
  // Over budget: the least recently used go first, only as many as needed.
  const big = [
    { key: 'a', bytes: 40, lastUsed: now - 5 * DAY, storedAt: now },
    { key: 'b', bytes: 40, lastUsed: now - 2 * DAY, storedAt: now },
    { key: 'c', bytes: 40, lastUsed: now - 1 * DAY, storedAt: now },
    { key: 'old', bytes: 1, lastUsed: now - 40 * DAY, storedAt: now },
  ];
  assert.deepEqual(planEviction(big, now, { maxAgeMs: 30 * DAY, maxBytes: 85 }).sort(), ['a', 'old']);
  assert.deepEqual(planEviction(big, now, { maxAgeMs: 30 * DAY, maxBytes: 200 }), ['old']);
  assert.deepEqual(planEviction([], now), []);
  assert.ok(ASSET_CACHE_MAX_BYTES >= 256 * 1024 * 1024);
});

test('without IndexedDB the direct URL is used, and nothing is remembered as resolved', async () => {
  // No indexedDB and no fetch in this process: resolution must fall back to the URL it was given, without throwing.
  const url = 'https://example.test/api/channels/ch/media/a?token=t&v=1';
  assert.equal(await resolveAsset(mediaKey('ch', 'a', 1), url), url);
  assert.equal(peekAsset(mediaKey('ch', 'a', 1)), undefined);
  assert.equal(await resolveAsset(null, url), url, 'uncacheable content is passed through');
  assert.equal(await resolveAsset(mediaKey('ch', 'a', 1), ''), '');
});

test('cache sizes read naturally', () => {
  assert.equal(formatCacheSize(0), '1 KB'); assert.equal(formatCacheSize(512 * 1024), '512 KB');
  assert.equal(formatCacheSize(1.5 * 1024 * 1024), '1.5 MB'); assert.equal(formatCacheSize(2 * 1024 * 1024 * 1024), '2.00 GB');
});
