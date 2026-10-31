const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// The desktop app's server address: normalized, kept apart from the sidebar's remembered server id.
function load(store, desktop) {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/platform.ts'), 'utf8').replace(/import\.meta\.env\.\w+/g, 'undefined');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  const window = desktop ? { __TAURI_INTERNALS__: {} } : {};
  new Function('require', 'module', 'exports', 'window', 'location', js)(
    () => ({ readStorage: (k) => store.get(k) ?? null, writeStorage: (k, v) => (v === null ? store.delete(k) : store.set(k, v)) }),
    module, module.exports, window, { origin: 'https://web.example' });
  return module.exports;
}

test('server addresses are normalized; http only for localhost', () => {
  const p = load(new Map(), true);
  assert.equal(p.normalizeServer('trpg.example.com/'), 'https://trpg.example.com');
  assert.equal(p.normalizeServer(' https://trpg.example.com:8443/app '), 'https://trpg.example.com:8443');
  assert.equal(p.normalizeServer('http://localhost:18090'), 'http://localhost:18090');
  assert.throws(() => p.normalizeServer('http://trpg.example.com'));
  assert.throws(() => p.normalizeServer('  '));
});

test('the desktop server address does not share storage with the remembered sidebar server', () => {
  const store = new Map([['acerciae.server', 'ca8f497b-1717-44fd-8e6e-03f0b1eb53f4']]);   // the sidebar's last server id
  const p = load(store, true);
  assert.equal(p.apiBase(), 'https://trpg.missazertia.com');
  p.setServerUrl('http://localhost:18090');
  assert.equal(p.apiBase(), 'http://localhost:18090');
  assert.equal(store.get('acerciae.server'), 'ca8f497b-1717-44fd-8e6e-03f0b1eb53f4');
  p.setServerUrl('https://trpg.missazertia.com');   // the default is not stored
  assert.equal(p.apiBase(), 'https://trpg.missazertia.com');
  const web = load(new Map(), false);
  assert.equal(web.apiBase(), '');
  assert.equal(web.webOrigin(), 'https://web.example');
});
