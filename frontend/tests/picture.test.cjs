const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// Pictures a member uploads into chat (src/lib/picture.ts).
const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/picture.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
const { pictureAmong, preparePicture, PICTURE_TYPES, PICTURE_ACCEPT, MAX_PICTURE_BYTES } = mod.exports;
const file = (name, type) => new File(['x'], name, { type });

test('the picture among pasted or dropped files is the first image; nothing else counts', () => {
  assert.equal(pictureAmong(null), null);
  assert.equal(pictureAmong([file('notes.txt', 'text/plain'), file('scan.pdf', 'application/pdf')]), null);
  assert.equal(pictureAmong([file('notes.txt', 'text/plain'), file('map.png', 'image/png'), file('photo.jpg', 'image/jpeg')]).name, 'map.png');
  assert.deepEqual(PICTURE_TYPES, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  assert.equal(PICTURE_ACCEPT, 'image/png,image/jpeg,image/webp,image/gif');
  assert.equal(MAX_PICTURE_BYTES, 10 * 1024 * 1024);
});

test('only a JPEG is redrawn; other formats, and a JPEG the browser cannot redraw, go as they are', async () => {
  const png = file('map.png', 'image/png'), gif = file('dance.gif', 'image/gif'), jpg = file('photo.jpg', 'image/jpeg');
  assert.equal(await preparePicture(png), png);
  assert.equal(await preparePicture(gif), gif);
  assert.equal(await preparePicture(jpg), jpg, 'no createImageBitmap here: sent unchanged');
  // A browser that fails to decode it: unchanged as well, the server still judges the bytes.
  global.createImageBitmap = async () => { throw new Error('cannot decode'); };
  try { assert.equal(await preparePicture(jpg), jpg); } finally { delete global.createImageBitmap; }
});
