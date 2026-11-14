const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { load, fixture, docOf, WASM } = require('./hypertext-harness.cjs');
// Interactive messages: the web worker module itself (src/hypertext/hypertext-worker.ts) in a stand-in worker scope:
// what it removes from its scope before the first message, the protocol, and what it answers when the engine cannot
// load. (client.ts, which drives it, is tested in hypertext-engine.test.cjs.)
const { validateOutput } = load('effects');
const { parseDoc } = load('format');

function scopeWith(fetch) {
  function WorkerGlobalScope() {}
  WorkerGlobalScope.prototype = { get fonts() { return { load() {} }; }, get indexedDB() { return {}; }, get caches() { return {}; } };
  const scope = Object.create(WorkerGlobalScope.prototype), posted = [];
  Object.assign(scope, {
    WorkerGlobalScope, fetch, XMLHttpRequest() {}, WebSocket() {}, EventSource() {}, importScripts() {}, BroadcastChannel() {}, Worker() {}, FontFace() {},
    navigator: Object.create({ get storage() { return { getDirectory() {} }; }, get locks() { return {}; } }),
    postMessage: (m) => posted.push(JSON.parse(m)),
  });
  return { scope, posted };
}
let n = 0;
function loadWorker(fetch) {
  const { scope, posted } = scopeWith(fetch);
  globalThis.self = scope;
  load('hypertext-worker', (js) => js.replace(/require\("@jitl\/quickjs-wasmfile-release-sync\/wasm\?url"\)/, '({ __esModule: true, default: "file:///emscripten-module.wasm" })'), `worker${n++}`);
  delete globalThis.self;
  return { scope, posted };
}
const wasmResponse = () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(fs.readFileSync(WASM)) });
const c = fixture.runs[0];
const input = { doc: parseDoc(docOf(c)), state: c.state, handler: c.handler, event: c.event, viewer: c.viewer };
const answer = async (scope, posted, id) => {
  scope.onmessage({ data: JSON.stringify({ id, input }) });
  for (let i = 0; i < 400 && !posted.some((m) => m.id === id); i++) await new Promise((r) => setTimeout(r, 5));
  return posted.find((m) => m.id === id);
};

test('the worker drops network, storage and font APIs before its first message, then runs actions', async () => {
  const fetched = [];
  const { scope, posted } = loadWorker((url) => { fetched.push(url); return wasmResponse(); });
  assert.deepEqual(fetched, ['file:///emscripten-module.wasm']);   // requested once, before the lockdown
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'BroadcastChannel', 'Worker', 'FontFace', 'fonts', 'indexedDB', 'caches']) {
    assert.equal(scope[name], undefined, name);
    assert.deepEqual(Object.getOwnPropertyDescriptor(scope, name), { value: undefined, writable: false, enumerable: false, configurable: false }, name);
  }
  assert.equal(scope.navigator.storage, undefined);
  assert.equal(scope.navigator.locks, undefined);
  assert.equal(typeof scope.onmessage, 'function');
  const m = await answer(scope, posted, 7);
  assert.equal(m.reload, undefined);
  const r = validateOutput(input.doc, c.state, m.out);
  assert.deepEqual(r.effects, c.expect.effects);
  assert.deepEqual(r.state, c.expect.state);
  // Anything that is not a request is ignored; a request that breaks the worker gets an engine error.
  scope.onmessage({ data: 42 });
  scope.onmessage({ data: 'x'.repeat(70000) });
  scope.onmessage({ data: '{"id": 8, "input": null}' });
  for (let i = 0; i < 100 && !posted.some((x) => x.id === 8); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(posted.map((x) => x.id), [7, 8]);
  assert.equal(JSON.parse(posted[1].out).error.code, 'engine');
});

test('a failed load answers engine_unavailable with reload, so client.ts starts a new worker', async () => {
  const { scope, posted } = loadWorker(() => Promise.reject(new TypeError('Failed to fetch')));
  const m = await answer(scope, posted, 1);
  assert.equal(m.reload, true);
  assert.deepEqual(JSON.parse(m.out).error, { code: 'engine_unavailable', message: 'the engine could not be loaded: Failed to fetch' });
  const http = loadWorker(() => Promise.resolve({ ok: false, status: 503 }));
  assert.equal((await answer(http.scope, http.posted, 1)).reload, true);
});

test('without WebAssembly the worker says so, and nothing is fetched', async () => {
  const saved = globalThis.WebAssembly, fetched = [];
  delete globalThis.WebAssembly;
  let w;
  try { w = loadWorker((url) => { fetched.push(url); return wasmResponse(); }); } finally { globalThis.WebAssembly = saved; }
  const m = await answer(w.scope, w.posted, 1);
  assert.deepEqual(fetched, []);
  assert.equal(m.reload, undefined);
  assert.equal(JSON.parse(m.out).error.code, 'engine_unavailable');
});
