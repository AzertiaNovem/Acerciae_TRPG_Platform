const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// The session token: local storage on the web, the system keychain in the desktop app.
const source = fs.readFileSync(path.join(__dirname, '../src/lib/tokenStore.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', js)(() => ({ readStorage: () => null, writeStorage: () => {} }), mod, mod.exports);
const { createTokenStore, STORAGE_KEY, SECRET_NAME } = mod.exports;

function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, read: (k) => m.get(k) ?? null, write: (k, v) => (v === null ? m.delete(k) : m.set(k, v)) }; }
function keychain(init = {}, { failSet = false } = {}) {
  const m = new Map(Object.entries(init)); const log = [];
  return { m, log, get: async (n) => m.get(n) ?? null, set: async (n, v) => { if (failSet) throw new Error('denied'); log.push(['set', v]); m.set(n, v); }, remove: async (n) => { log.push(['remove']); m.delete(n); } };
}

test('the web keeps the token in local storage', async () => {
  const s = kv({ [STORAGE_KEY]: 'web' }); const store = createTokenStore(false, async () => { throw new Error('no keychain on the web'); }, s);
  assert.equal(store.initial(), 'web'); assert.equal(await store.load(), 'web');
  await store.save('next'); assert.equal(s.m.get(STORAGE_KEY), 'next');
  await store.save(null); assert.equal(s.m.has(STORAGE_KEY), false);
});

test('the desktop app reads and writes the keychain, never local storage', async () => {
  const s = kv(); const kc = keychain({ [SECRET_NAME]: 'saved' }); const store = createTokenStore(true, async () => kc, s);
  assert.equal(store.initial(), null);
  assert.equal(await store.load(), 'saved');
  store.save('a'); store.save(null); await store.save('b');   // queued in order
  assert.deepEqual(kc.log, [['set', 'a'], ['remove'], ['set', 'b']]);
  assert.equal(kc.m.get(SECRET_NAME), 'b'); assert.equal(s.m.size, 0);
});

test('a token left in local storage by an older desktop version moves to the keychain', async () => {
  const s = kv({ [STORAGE_KEY]: 'old' }); const kc = keychain(); const store = createTokenStore(true, async () => kc, s);
  assert.equal(await store.load(), 'old');
  assert.equal(kc.m.get(SECRET_NAME), 'old'); assert.equal(s.m.has(STORAGE_KEY), false);
});

test('a keychain that refuses the token keeps the old copy instead of signing out', async () => {
  const s = kv({ [STORAGE_KEY]: 'old' }); const store = createTokenStore(true, async () => keychain({}, { failSet: true }), s);
  assert.equal(await store.load(), 'old'); assert.equal(s.m.get(STORAGE_KEY), 'old');
  const none = createTokenStore(true, async () => { throw new Error('no tauri'); }, kv({ [STORAGE_KEY]: 'x' }));
  assert.equal(await none.load(), 'x');
});
