const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function client(fetch) {
  const source = fs.readFileSync(path.join(__dirname, '../src/api/client.ts'), 'utf8').replace('import.meta.env.VITE_API_BASE', "''");
  const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
  const module = {exports: {}}, timers = new Map(); let next = 0;
  const setTimer = (fn, ms) => { assert.equal(ms, 120000); timers.set(++next, fn); return next; };
  new Function('require', 'module', 'exports', 'fetch', 'setTimeout', 'clearTimeout', js)(
    () => ({readStorage: () => null, writeStorage: () => {}, apiBase: () => ''}), module, module.exports, fetch, setTimer, id => timers.delete(id));
  return {...module.exports, timers, expire: () => { for (const fn of timers.values()) fn(); }};
}
function stalled(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
  });
}
test('API deadlines abort stalled headers and response bodies without retrying a write', async () => {
  for (const bodyStalls of [false, true]) {
    let calls = 0;
    const c = client(async (_, {signal}) => { ++calls; return bodyStalls ? {ok: true, text: () => stalled(signal)} : stalled(signal); });
    const request = c.request('POST', '/test', {value: 1});
    await Promise.resolve(); c.expire();
    await assert.rejects(request, e => e.status === 408 && e.code === 'request_timeout');
    assert.equal(calls, 1); assert.equal(c.timers.size, 0);
  }
});
test('API clears deadlines on success and preserves an upstream error', async () => {
  const c = client(async () => ({ok: true, text: async () => '{"saved":true}'}));
  assert.deepEqual(await c.request('GET', '/test'), {saved: true}); assert.equal(c.timers.size, 0);
  const failed = client(async () => ({ok: false, status: 503, text: async () => '{"error":"server_busy","message":"queue full"}'}));
  await assert.rejects(failed.request('POST', '/test'), e => e.status === 503 && e.code === 'server_busy');
  assert.equal(failed.timers.size, 0);
});
