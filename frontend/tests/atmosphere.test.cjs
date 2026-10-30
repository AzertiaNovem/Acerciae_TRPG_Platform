const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/lib/atmosphere.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const result = {exports:{}};
new Function('module','exports',code)(result,result.exports);
test('device theme and orientation select all four existing variants without a story clock', () => {
  const variant = result.exports.atmosphereVariant;
  assert.equal(variant(false,false), 'day_landscape');
  assert.equal(variant(true,false), 'night_landscape');
  assert.equal(variant(false,true), 'day_portrait');
  assert.equal(variant(true,true), 'night_portrait');
});
