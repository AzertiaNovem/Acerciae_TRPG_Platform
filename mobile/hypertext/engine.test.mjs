import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
// The committed mobile card engine (mobile/contracts/hypertext/hypertext-engine.js) in bare contexts like the apps'
// WebViews: no fetch, no network, no bridge. Without Worker support it runs on the page itself; with it (a stand-in
// Worker that runs the blob's source in a second context, as a WebView would in a thread) each run goes to the worker
// and the page ends a run that does not answer.
const read = (p) => fs.readFileSync(new URL(p, import.meta.url));
const bundle = read('../contracts/hypertext/hypertext-engine.js');
const hashes = JSON.parse(read('../contracts/hypertext/hypertext-engine.sha256.json'));
const fixture = JSON.parse(read('../contracts/fixtures/hypertext-client.json'));
const sharedPath = new URL('../contracts/fixtures/hypertext.json', import.meta.url);
const shared = fs.existsSync(sharedPath) ? JSON.parse(fs.readFileSync(sharedPath, 'utf8')) : null;
const bare = () => ({ TextDecoder, TextEncoder, atob, btoa, console, WebAssembly, URL });
const context = vm.createContext(bare());
vm.runInContext(bundle.toString('utf8'), context);
const engine = context.MobileHypertext;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const docOf = (c) => { const d = fixture.docs[c.doc]; return c.script !== undefined ? { ...d, script: c.script } : d; };
const request = (c) => JSON.stringify({ doc: docOf(c), state: c.state, prev: c.prev ?? c.state, handler: c.handler, event: c.event, viewer: c.viewer });
const run = async (c, e = engine) => JSON.parse(await e.run(request(c)));
function check(r, c) {
  const e = c.expect;
  if (e.ok) {
    assert.equal(r.ok, true, `${c.name}: ${JSON.stringify(r.error)}`);
    for (const k of Object.keys(e)) if (k !== 'ok') assert.deepEqual(r[k], e[k], `${c.name}: ${k}`);
  } else {
    assert.equal(r.ok, false, `${c.name}: expected ${e.code}`);
    assert.equal(r.error.code, e.code, `${c.name}: ${r.error.message}`);
    if (e.line !== undefined) assert.equal(r.error.line, e.line, c.name);
    if (e.logs !== undefined) assert.deepEqual(r.logs, e.logs, c.name);
  }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('the bundle is the committed build of the pinned engine, within the size cap', () => {
  assert.equal(typeof context.fetch, 'undefined');
  assert.ok(bundle.length <= fixture.engine.max_bundle_bytes, `${bundle.length} bytes`);
  assert.deepEqual(hashes, { wasm_sha256: fixture.engine.wasm_sha256, bundle_sha256: sha256(bundle), bytes: bundle.length });
  assert.equal(engine.version, fixture.engine.version);
  assert.ok(bundle.toString('utf8').includes('Fabrice Bellard'), 'the MIT notices are kept');
  assert.ok(bundle.toString('utf8').startsWith('(function __hypertextBundle() {\n'), 'the bundle is its own worker source');
  const html = read('../contracts/hypertext/hypertext-engine.html').toString('utf8');
  assert.ok(html.includes(`content="default-src 'none'; script-src 'self' file: 'wasm-unsafe-eval'; worker-src blob:; base-uri 'none'; form-action 'none'"`));
  assert.ok(html.includes('x-dns-prefetch-control') && html.includes('<script src="hypertext-engine.js">'));
  if (shared) {
    assert.equal(shared.engine.wasm_sha256, hashes.wasm_sha256);
    assert.ok(bundle.length <= shared.engine.max_bundle_bytes);
  }
});

test('every runs case through the bundle (engine and host validation), on the page', async () => {
  for (const c of fixture.runs) check(await run(c), c);
  assert.equal(engine.ready, true);
});

test('start and take: the poll-able form of run, for a host that cannot await', async () => {
  const c = fixture.runs[0];
  assert.equal(engine.take('a'), null);
  engine.start('a', request(c));
  assert.equal(engine.take('a'), null);                        // still running
  let out = null;
  for (let i = 0; i < 200 && out === null; i++) { await tick(5); out = engine.take('a'); }
  check(JSON.parse(out), c);
  assert.equal(engine.take('a'), null);                        // taken once
  // Results nobody takes do not pile up: at most 32 wait (started in batches the queue of 8 can hold; each run(c)
  // resolves after the batch before it).
  for (let i = 0; i < 40; i += 5) { for (let j = i; j < i + 5; j++) engine.start(`n${j}`, request(c)); await run(c); }
  for (let i = 0; i < 8; i++) assert.equal(engine.take(`n${i}`), null, `n${i}`);
  for (let i = 8; i < 40; i++) check(JSON.parse(engine.take(`n${i}`)), c);
  // More than 8 waiting: the rest fail at once without running.
  const flood = await Promise.all(Array.from({ length: 10 }, () => run(c)));
  assert.equal(flood.filter((r) => !r.ok && r.error.message === 'too many actions are waiting').length, 1);
});

test('malformed requests fail closed', async () => {
  const c = fixture.runs[0];
  const call = async (req) => JSON.parse(await engine.run(typeof req === 'string' ? req : JSON.stringify(req)));
  const full = { doc: docOf(c), state: c.state, prev: c.state, handler: 'go', event: c.event, viewer: c.viewer };
  assert.equal((await call('not json')).error.code, 'engine');
  assert.equal((await call({ ...full, doc: { ...docOf(c), v: 2 } })).error.code, 'engine');
  assert.equal((await call({ ...full, state: { ...c.state, n: 99 } })).error.code, 'invalid_state');
  const noPrev = await call({ ...full, prev: undefined });
  assert.equal(noPrev.error.code, 'invalid_state');
  assert.match(noPrev.error.message, /prev/);
  assert.equal((await call({ ...full, handler: 'Go!' })).error.code, 'engine');
  assert.equal((await call({ ...full, event: { type: 'hover', node: 'go' } })).error.code, 'engine');
});

// A page with Worker support. The stand-in Worker reads the blob the page made from its own source and runs it in a
// second bare context with a worker scope; `hang` makes the worker swallow requests, as one stuck in a C built-in.
function pageWithWorkers() {
  const blobs = new Map(), made = [];
  let hang = false;
  class PageURL extends URL {
    static createObjectURL(blob) { const u = `blob:page/${blobs.size + 1}`; blobs.set(u, blob); return u; }
    static revokeObjectURL() {}
  }
  class StandInWorker {
    constructor(url) {
      this.terminated = false; this.queue = []; this.scope = null; made.push(this);
      void blobs.get(url).text().then((source) => {
        if (this.terminated) return;
        const scope = vm.createContext({ ...bare(), WorkerGlobalScope: function WorkerGlobalScope() {},
          postMessage: (data) => setImmediate(() => { if (!this.terminated) this.onmessage?.({ data }); }) });
        vm.runInContext(source, scope);
        this.scope = scope;
        for (const m of this.queue.splice(0)) this.deliver(m);
      });
    }
    deliver(data) { if (!hang && !this.terminated) setImmediate(() => this.scope.onmessage({ data })); }
    postMessage(data) { if (this.scope) this.deliver(data); else this.queue.push(data); }
    terminate() { this.terminated = true; }
  }
  const page = vm.createContext({ ...bare(), URL: PageURL, Blob, Worker: StandInWorker, setTimeout, clearTimeout });
  vm.runInContext(bundle.toString('utf8'), page);
  return { engine: page.MobileHypertext, made, setHang: (v) => { hang = v; } };
}

test('with Worker support, every run happens in a worker started from the bundle itself', async () => {
  const { engine: e, made } = pageWithWorkers();
  assert.equal(e.ready, false);                                  // until the worker has compiled the WASM
  for (let i = 0; i < 400 && !e.ready; i++) await tick(5);
  assert.equal(e.ready, true);
  assert.equal(made.length, 1);
  assert.equal(made[0].scope.MobileHypertext, undefined, 'the worker serves requests, it is no page');
  const sample = fixture.runs.filter((c) => !/deadline/.test(c.name)).slice(0, 25);
  for (const c of sample) check(await run(c, e), c);
  assert.equal(made.length, 1);
});

test('with Worker support, a run that does not answer ends as timeout and its worker is replaced', async () => {
  const { engine: e, made, setHang } = pageWithWorkers();
  for (let i = 0; i < 400 && !e.ready; i++) await tick(5);
  setHang(true);
  const t0 = Date.now();
  const r = await run(fixture.runs[0], e);
  assert.equal(r.error.code, 'timeout');
  assert.ok(Date.now() - t0 >= fixture.engine.limits.timeout_ms - 50, `${Date.now() - t0} ms`);
  assert.equal(made[0].terminated, true);
  assert.equal(made.length, 2, 'a new worker is started at once');
  setHang(false);
  check(await run(fixture.runs[0], e), fixture.runs[0]);
  assert.equal(made.length, 2);
});
