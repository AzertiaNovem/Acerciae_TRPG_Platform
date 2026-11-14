const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load, fixture, docOf, checkRun, WASM } = require('./hypertext-harness.cjs');
// Interactive messages: the script engine (src/hypertext/engine.ts + prelude.ts) with the QuickJS WASM from
// node_modules, its host validation (effects.ts) over the fixture's `runs`, the pins, and the worker manager
// (client.ts) with stand-in workers.
const { runAction, ENGINE_LIMITS, ENGINE_VERSION } = load('engine');
const { validateOutput } = load('effects');
const { parseDoc } = load('format');
const { createEngineClient, CLIENT_LIMITS } = load('client', (js) => js.replace(/import\.meta\.url/g, '"file:///hypertext-worker.js"'));

let compiled;
const wasm = () => compiled ??= WebAssembly.compile(fs.readFileSync(WASM));
const input = (c) => ({ doc: parseDoc(docOf(c)), state: c.state, handler: c.handler, event: c.event, viewer: c.viewer });
async function runCase(c, meter) {
  const i = input(c);
  return validateOutput(i.doc, c.prev ?? c.state, await runAction(await wasm(), i, meter));
}
const base = fixture.runs[0];
const withScript = (script, over = {}) => ({ ...base, script, ...over });

test('the engine is pinned: exact packages, lockfile, WASM bytes and limits', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  for (const [name, version] of Object.entries(fixture.engine.packages)) {
    assert.equal(pkg.dependencies[name], version, `${name} is pinned exactly (no ^ or ~)`);
    assert.equal(lock.packages[''].dependencies[name], version, name);
    assert.equal(lock.packages[`node_modules/${name}`].version, version, `the lockfile resolves ${name}`);
  }
  assert.equal(lock.packages['node_modules/@jitl/quickjs-ffi-types'].version, '0.32.0');
  assert.equal(pkg.devDependencies.esbuild, '0.21.5');
  assert.equal(lock.packages['node_modules/esbuild'].version, '0.21.5');
  const bytes = fs.readFileSync(WASM);
  assert.equal(bytes.length, fixture.engine.wasm_bytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), fixture.engine.wasm_sha256);
  assert.equal(fixture.engine.wasm_sha256, '105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232');
  const l = fixture.engine.limits;
  assert.deepEqual(ENGINE_LIMITS, { interruptPolls: l.interrupt_polls, memoryBytes: l.memory_bytes, stackBytes: l.stack_bytes, outputBytes: l.output_bytes });
  assert.equal(CLIENT_LIMITS.timeoutMs, l.timeout_ms);
  assert.equal(CLIENT_LIMITS.coldTimeoutMs, l.cold_timeout_ms);
  assert.equal(ENGINE_VERSION, fixture.engine.version);
  // The guest never gets a callable host function.
  for (const f of ['engine.ts', 'prelude.ts', 'hypertext-worker.ts']) assert.ok(!/\.new\w*Function\s*\(/.test(fs.readFileSync(path.join(__dirname, '../src/hypertext', f), 'utf8')), f);
});

test('every runs case: engine output after host validation', async () => {
  assert.ok(fixture.runs.length >= 40);
  for (const c of fixture.runs) checkRun(assert, await runCase(c), c.expect, c.name);
});

test('the step budget cuts off at the same poll every time', async () => {
  for (const script of ["on('go', () => { while (1) {} });", "on('go', () => { let i = 0; for (;;) i++; });", 'for (;;) {}']) {
    const a = { polls: 0 }, b = { polls: 0 };
    checkRun(assert, await runCase(withScript(script), a), { ok: false, code: 'budget' }, script);
    checkRun(assert, await runCase(withScript(script), b), { ok: false, code: 'budget' }, script);
    assert.equal(a.polls, ENGINE_LIMITS.interruptPolls + 1, script);
    assert.equal(b.polls, a.polls, script);
  }
  // A run inside the budget reports how much it used; the same code uses the same amount.
  const loop = "on('go', () => { let s = 0; for (let i = 0; i < 100000; i++) s += i; state.n = s % 10; });";
  const a = { polls: 0 }, b = { polls: 0 };
  checkRun(assert, await runCase(withScript(loop), a), { ok: true, state: { ...base.state, n: 0 } }, loop);
  await runCase(withScript(loop), b);
  assert.ok(a.polls > 1 && a.polls <= ENGINE_LIMITS.interruptPolls);
  assert.equal(b.polls, a.polls);
});

test('a fresh instance per run: nothing persists between runs', async () => {
  const leak = withScript("globalThis.seen = (globalThis.seen || 0) + 1; on('go', () => notify(String(seen)));");
  checkRun(assert, await runCase(leak), { ok: true, notices: ['1'] }, 'first');
  checkRun(assert, await runCase(leak), { ok: true, notices: ['1'] }, 'second');
  const proto = withScript("Object.prototype.polluted = 1; on('go', () => {});");
  await runCase(proto);
  checkRun(assert, await runCase(withScript("on('go', () => notify(String(({}).polluted)));")), { ok: true, notices: ['undefined'] }, 'prototype');
});

test('1000 runs keep memory stable', async () => {
  const c = withScript("on('go', () => { const a = []; for (let i = 0; i < 1000; i++) a.push({ i }); state.n = a.length % 10; say('.r 1d6'); });");
  for (let i = 0; i < 50; i++) await runCase(c);
  global.gc?.();
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 1000; i++) { const r = await runCase(c); if (!r.ok) assert.fail(JSON.stringify(r.error)); }
  global.gc?.();
  const grew = (process.memoryUsage().rss - before) / 1e6;
  assert.ok(grew < 50, `RSS grew by ${grew.toFixed(1)} MB`);
});

test('a forged or broken output never passes validation', async () => {
  const doc = parseDoc(fixture.docs.run), s = base.state;
  const v = (raw) => validateOutput(doc, s, raw);
  assert.equal(v(undefined).error.code, 'engine');
  assert.equal(v('not json').error.code, 'invalid_effect');
  assert.equal(v('['.repeat(17) + ']'.repeat(17)).error.code, 'invalid_effect');
  assert.equal(v('"' + '['.repeat(40) + '"').error.code, 'invalid_effect');               // a string is no object, but not too deep
  assert.equal(v(JSON.stringify({ ok: true, state: s, effects: [], notices: [], logs: [], x: '\\"[[[[' })).error.code, 'invalid_effect');
  assert.equal(v(JSON.stringify({ ok: true, state: s, effects: [{ type: 'post', text: 'x' }], notices: [], logs: [] })).error.code, 'invalid_effect');
  assert.equal(v(JSON.stringify({ ok: true, state: s, effects: [{ type: 'say', text: '.r', kind: 'ic', character_id: 'npc' }], notices: [], logs: [] })).error.code, 'invalid_effect');
  assert.equal(v(JSON.stringify({ ok: true, state: s, effects: [{ type: 'reply', id: 'door', slots: {}, text: 'Forged GM line' }], notices: [], logs: [] })).error.code, 'invalid_effect');
  assert.equal(v(JSON.stringify({ ok: true, state: { ...s, n: '1' }, effects: [], notices: [], logs: [] })).error.code, 'invalid_state');
  assert.equal(v(JSON.stringify({ ok: true, state: s, effects: [], notices: [], logs: Array(21).fill('x') })).error.code, 'invalid_effect');
  assert.equal(v(JSON.stringify({ ok: true, state: s, effects: [], notices: ['\u202ex'], logs: [] })).error.code, 'invalid_effect');
  const err = v(JSON.stringify({ ok: false, error: { code: 'root', message: 'x\u202e'.repeat(300), line: -1 }, logs: ['\u0007'] }));
  assert.deepEqual(err, { ok: false, error: { code: 'script_error', message: 'x\ufffd'.repeat(100) }, logs: ['\ufffd'] });
  const ok = v(JSON.stringify({ ok: true, state: s, effects: [], notices: [], logs: ['a\u202eb'] }));
  assert.deepEqual(ok.logs, ['a\ufffdb']);
});

// The worker manager, with stand-in workers: `answer` decides what a worker does with each request.
function workers(answer) {
  const made = [];
  const spawn = () => {
    const w = { posted: [], terminated: false, onmessage: null, onerror: null, terminate() { this.terminated = true; } };
    w.postMessage = (msg) => { w.posted.push(msg); answer(w, JSON.parse(msg)); };
    made.push(w); return w;
  };
  return { made, client: createEngineClient(spawn) };
}
const reply = (w, id, out) => setImmediate(() => w.onmessage?.({ data: JSON.stringify({ id, out }) }));
const real = (w, req) => { void wasm().then((m) => runAction(m, req.input)).then((out) => reply(w, req.id, out)); };
const flush = () => new Promise((r) => setImmediate(r));

test('client: runs in the worker, validates on this side, one action per card, at most 4 waiting', async () => {
  const { made, client } = workers(real);
  const c = (script) => input(withScript(script));
  const r = await client.run('card1', c("on('go', () => say('I wave.'));"));
  assert.deepEqual(r.confirm, { text: 'I wave.', kind: 'ic' });
  assert.equal(made.length, 1);
  const first = client.run('card1', c("on('go', () => { state.n = 1; });"));
  assert.equal((await client.run('card1', c("on('go', () => {});"))).error.code, 'engine');   // the same card is busy
  const more = ['a', 'b', 'c', 'd'].map((k) => client.run(k, c("on('go', () => { state.n = 2; });")));
  assert.equal((await client.run('e', c("on('go', () => {});"))).error.code, 'engine');       // 4 already wait
  assert.deepEqual((await first).state, { ...base.state, n: 1 });
  for (const p of more) assert.equal((await p).ok, true);
  assert.equal(made.length, 1);
  assert.equal(client.busy, false);
  // A forged reply from the worker is validated like any output.
  const forged = workers((w, req) => reply(w, req.id, JSON.stringify({ ok: true, state: { done: 'x' }, effects: [], notices: [], logs: [] }))).client;
  assert.equal((await forged.run('x', c("on('go', () => {});"))).error.code, 'invalid_state');
});

test('client: a run past the backstop terminates the worker; the next run gets a new one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let silent = true;
  const { made, client } = workers((w, req) => { if (!silent) reply(w, req.id, JSON.stringify({ ok: true, state: base.state, effects: [], notices: [], logs: [] })); });
  const cold = client.run('card', input(base));
  t.mock.timers.tick(CLIENT_LIMITS.coldTimeoutMs - 1); await flush();
  assert.equal(made[0].terminated, false);
  t.mock.timers.tick(1);
  assert.equal((await cold).error.code, 'timeout');
  assert.equal(made[0].terminated, true);
  silent = false;
  assert.equal((await client.run('card', input(base))).ok, true);          // a new worker, warm after its first answer
  assert.equal(made.length, 2);
  silent = true;
  const warm = client.run('card', input(base));
  t.mock.timers.tick(CLIENT_LIMITS.timeoutMs);
  assert.equal((await warm).error.code, 'timeout');
  assert.equal(made[1].terminated, true);
});

test('client: recycles the worker after 500 runs, stops on dispose, and needs WebAssembly', async () => {
  const ok = JSON.stringify({ ok: true, state: base.state, effects: [], notices: [], logs: [] });
  const { made, client } = workers((w, req) => reply(w, req.id, ok));
  for (let i = 0; i < CLIENT_LIMITS.recycleAfter; i++) assert.equal((await client.run('card', input(base))).ok, true);
  assert.equal(made.length, 1); assert.equal(made[0].terminated, true);
  await client.run('card', input(base));
  assert.equal(made.length, 2);

  const hung = workers(() => {});
  const pending = [hung.client.run('a', input(base)), hung.client.run('b', input(base))];
  await flush();
  hung.client.dispose();
  for (const p of pending) assert.equal((await p).error.code, 'engine');
  assert.equal(hung.made[0].terminated, true);

  const broken = workers((w) => setImmediate(() => w.onerror?.({})));
  assert.equal((await broken.client.run('a', input(base))).error.code, 'engine_unavailable');

  const saved = globalThis.WebAssembly;
  try { delete globalThis.WebAssembly; assert.equal((await client.run('card', input(base))).error.code, 'engine_unavailable'); }
  finally { globalThis.WebAssembly = saved; }
});
