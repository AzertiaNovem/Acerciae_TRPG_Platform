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

test('point-buy skill names: shown in the server language, typed in either language, stored under the English key', () => {
  const { skillLabel, skillKey } = load('components/skillNames.ts');
  const rules = {
    skills: [
      { name: 'Spot Hidden', base: 25, names: { ja: '目星', 'zh-CN': '侦查', fr: 'Trouver objet caché' } },
      { name: 'Science', base: 1, names: { ja: '科学', 'zh-CN': '科学', de: 'Naturwissenschaft' } },
      { name: 'Fighting (Brawl)', base: 25, names: { ja: '近接戦闘（格闘）' } },
    ],
    families: [{ name: 'Science', base: 1, names: { ja: '科学', 'zh-CN': '科学', de: 'Naturwissenschaft', ko: '과학' } }, { name: 'Fighting', base: 0, names: { ja: '近接戦闘' } }],
    careers: [], hobby_formula: 'INT×2',
  };
  assert.equal(skillLabel('Spot Hidden', rules, 'ja'), '目星');
  assert.equal(skillLabel('Spot Hidden', rules, 'en'), 'Spot Hidden');
  assert.equal(skillLabel('Science (Biology)', rules, 'zh-CN'), '科学（Biology）');
  assert.equal(skillLabel('Science (Biology)', rules, 'de'), 'Naturwissenschaft (Biology)');
  assert.equal(skillLabel('Science (Biology)', rules, 'ko'), '과학(Biology)');
  assert.equal(skillLabel('Fighting (Sword)', rules, 'ja'), '近接戦闘（Sword）');
  assert.equal(skillLabel('research', rules, 'ja'), 'research');
  assert.equal(skillKey('目星', rules, 'ja'), 'Spot Hidden');
  assert.equal(skillKey(' spot hidden ', rules, 'ja'), 'Spot Hidden');
  assert.equal(skillKey('目星', rules, 'fr'), '目星');   // only English and the server language
  assert.equal(skillKey('trouver objet caché', rules, 'fr'), 'Spot Hidden');
  assert.equal(skillKey('科学（生物学）', rules, 'ja'), 'Science (生物学)');
  assert.equal(skillKey('近接戦闘(刀剣)', rules, 'ja'), 'Fighting (刀剣)');
  assert.equal(skillKey('近接戦闘', rules, 'ja'), 'Fighting (Brawl)');
  assert.equal(skillKey('Science (Biology)', rules, 'en'), 'Science (Biology)');
  assert.equal(skillKey('research', rules, 'ja'), 'research');
});
