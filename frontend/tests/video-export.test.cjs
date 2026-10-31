const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// The pure parts of the desktop video export: how long each line stays, and how its text wraps.
function load() {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/studio/vn/videoExport.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(() => ({}), module, module.exports);
  return module.exports;
}
const { lineDuration, wrapText } = load();

test('a voiced line lasts its voice plus a breath; others get a reading time within bounds', () => {
  assert.equal(lineDuration({ text: 'Hi', audio_ms: 4000, kind: 'dialogue' }), 4600);
  assert.equal(lineDuration({ text: 'Hi', audio_ms: 300, kind: 'dialogue' }), 1500);
  assert.equal(lineDuration({ text: 'Yes.', kind: 'dialogue' }), 2000);
  const zh = lineDuration({ text: '我从书架最上层抽出那本账簿。', kind: 'dialogue' });
  const en = lineDuration({ text: 'I pull the ledger from the top shelf.', kind: 'dialogue' });
  assert.ok(zh > 2000 && en > 2000 && zh < 14000 && en < 14000, `${zh} ${en}`);
  assert.equal(lineDuration({ text: 'word '.repeat(500), kind: 'narration' }), 14000);
});

test('text wraps at spaces, between CJK characters, and inside words longer than a line', () => {
  const measure = (s) => [...s].length;   // one unit per character
  assert.deepEqual(wrapText(measure, 'the quick brown fox', 10), ['the quick', 'brown fox']);
  assert.deepEqual(wrapText(measure, '我从书架最上层抽出那本', 4), ['我从书架', '最上层抽', '出那本']);
  assert.deepEqual(wrapText(measure, 'abcdefghijkl', 5), ['abcde', 'fghij', 'kl']);
  assert.deepEqual(wrapText(measure, 'one\ntwo', 10), ['one', 'two']);
  for (const l of wrapText(measure, '混合 mixed 文本 text 在一行 in one line', 8)) assert.ok(measure(l) <= 8, l);
});
