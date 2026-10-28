const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// Loads a dependency-free TypeScript module from src.
function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
}

test('Log Studio access mirrors the server: maintainer switch, Keeper switches before the end, open to all after it', () => {
  const { studioAccess } = load('components/studio/access.ts');
  const on = { features: { log_studio: true } }, off = { features: { log_studio: false } };
  const ch = (o) => ({ my_role: 'player', studio_visible: true, studio_player_access: true, story_status: 'ongoing', ...o });
  assert.equal(studioAccess(ch({}), on), 'open');
  assert.equal(studioAccess(ch({}), off), 'disabled');
  assert.equal(studioAccess(ch({ studio_visible: false }), on), 'hidden');
  assert.equal(studioAccess(ch({ studio_visible: false, my_role: 'gm' }), on), 'hidden');
  assert.equal(studioAccess(ch({ studio_player_access: false }), on), 'locked');
  assert.equal(studioAccess(ch({ studio_player_access: false, my_role: 'gm' }), on), 'open');
  assert.equal(studioAccess(ch({ studio_visible: false, studio_player_access: false, story_status: 'ended' }), on), 'open');
  assert.equal(studioAccess(ch({ story_status: 'ended' }), off), 'disabled');
});

test('storage helpers survive blocked or corrupt storage', () => {
  const { readStorage, writeStorage, readJson } = load('lib/storage.ts');
  global.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(readStorage('x'), null);
  assert.doesNotThrow(() => writeStorage('x', 'y'));
  const data = new Map([['seen', '{not json']]);
  global.localStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  assert.deepEqual(readJson('seen', {}), {});
  writeStorage('seen', '{"a":1}'); assert.deepEqual(readJson('seen', {}), { a: 1 });
  delete global.localStorage;
});
