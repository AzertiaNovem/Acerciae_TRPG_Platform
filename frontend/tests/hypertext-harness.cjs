// Loads frontend/src/hypertext/*.ts for the tests: each file is transpiled to CommonJS with TypeScript (as
// chat-harness.cjs does), relative imports load the same way, and packages come from node_modules (both QuickJS
// packages ship CommonJS builds). Also the client fixture and, when the backend phase has written it, the shared one.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const SRC = path.join(__dirname, '../src/hypertext');
const cache = new Map();
/** `patch` rewrites the transpiled code; `tag` names that variant, so one file can be loaded several ways. */
function load(file, patch, tag = 'patched') {
  const full = path.resolve(SRC, file.endsWith('.ts') ? file : file + '.ts'), key = patch ? `${full}#${tag}` : full;
  if (cache.has(key)) return cache.get(key);
  const js = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  cache.set(key, mod.exports);
  const req = (name) => name.startsWith('.') ? load(path.resolve(path.dirname(full), name)) : require(name);
  new Function('require', 'module', 'exports', patch ? patch(js) : js)(req, mod, mod.exports);
  return mod.exports;
}

const FIXTURES = path.join(__dirname, '../../mobile/contracts/fixtures');
const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'hypertext-client.json'), 'utf8'));
const sharedPath = path.join(FIXTURES, 'hypertext.json');
const shared = fs.existsSync(sharedPath) ? JSON.parse(fs.readFileSync(sharedPath, 'utf8')) : null;

/** A case's document: a name in fixture.docs (runs may replace the script), or the document itself. */
function docOf(c, docs = fixture.docs) {
  const raw = typeof c.doc === 'string' ? docs[c.doc] : c.doc;
  return c.script !== undefined ? { ...raw, script: c.script } : raw;
}
/** Compares a run result with a `runs` expectation (only the fields it gives). */
function checkRun(assert, result, expect, name) {
  if (expect.ok) {
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.error)}`);
    for (const k of Object.keys(expect)) if (k !== 'ok') assert.deepEqual(result[k], expect[k], `${name}: ${k}`);
  } else {
    assert.equal(result.ok, false, `${name}: expected ${expect.code}, got ok`);
    assert.equal(result.error.code, expect.code, `${name}: ${result.error.message}`);
    if (expect.line !== undefined) assert.equal(result.error.line, expect.line, name);
    if (expect.logs !== undefined) assert.deepEqual(result.logs, expect.logs, name);
  }
}
const WASM = path.join(__dirname, '../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm');

module.exports = { load, fixture, shared, sharedPath, docOf, checkRun, WASM };
