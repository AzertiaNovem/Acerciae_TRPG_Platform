import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
// The committed mobile card engine (mobile/contracts/hypertext/hypertext-engine.js) in a bare context like the
// apps' WebViews: no fetch, no network, no bridge. Runs the client fixture's `runs` cases through MobileHypertext.run.
const read = (p) => fs.readFileSync(new URL(p, import.meta.url));
const bundle = read('../contracts/hypertext/hypertext-engine.js');
const hashes = JSON.parse(read('../contracts/hypertext/hypertext-engine.sha256.json'));
const fixture = JSON.parse(read('../contracts/fixtures/hypertext-client.json'));
const context = vm.createContext({ TextDecoder, TextEncoder, atob, btoa, console, WebAssembly, URL });
vm.runInContext(bundle.toString('utf8'), context);
const engine = context.MobileHypertext;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const docOf = (c) => { const d = fixture.docs[c.doc]; return c.script !== undefined ? { ...d, script: c.script } : d; };
const run = async (c) => JSON.parse(await engine.run(JSON.stringify({ doc: docOf(c), state: c.state, prev: c.prev, handler: c.handler, event: c.event, viewer: c.viewer })));

test('the bundle is the committed build of the pinned engine, within the size cap', () => {
  assert.equal(typeof context.fetch, 'undefined');
  assert.ok(bundle.length <= fixture.engine.max_bundle_bytes, `${bundle.length} bytes`);
  assert.deepEqual(hashes, { wasm_sha256: fixture.engine.wasm_sha256, bundle_sha256: sha256(bundle), bytes: bundle.length });
  assert.equal(engine.version, fixture.engine.version);
  assert.ok(bundle.toString('utf8').includes('Fabrice Bellard'), 'the MIT notices are kept');
  const html = read('../contracts/hypertext/hypertext-engine.html').toString('utf8');
  assert.ok(html.includes(`content="default-src 'none'; script-src 'self' file: 'wasm-unsafe-eval'; base-uri 'none'; form-action 'none'"`));
  assert.ok(html.includes('x-dns-prefetch-control') && html.includes('<script src="hypertext-engine.js">'));
});

test('every runs case through the bundle (engine and host validation)', async () => {
  for (const c of fixture.runs) {
    const r = await run(c), e = c.expect;
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
  assert.equal(engine.ready, true);
});

test('malformed requests fail closed', async () => {
  const c = fixture.runs[0];
  const call = async (req) => JSON.parse(await engine.run(typeof req === 'string' ? req : JSON.stringify(req)));
  assert.equal((await call('not json')).error.code, 'engine');
  assert.equal((await call({ ...c, doc: { ...docOf(c), v: 2 } })).error.code, 'engine');
  assert.equal((await call({ doc: docOf(c), state: { ...c.state, n: 99 }, handler: 'go', event: c.event, viewer: c.viewer })).error.code, 'invalid_state');
  assert.equal((await call({ doc: docOf(c), state: c.state, handler: 'Go!', event: c.event, viewer: c.viewer })).error.code, 'engine');
  assert.equal((await call({ doc: docOf(c), state: c.state, handler: 'go', event: { type: 'hover', node: 'go' }, viewer: c.viewer })).error.code, 'engine');
});
