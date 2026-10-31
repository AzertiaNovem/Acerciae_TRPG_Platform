import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await r.json();
  if (!r.ok) throw Object.assign(Error(JSON.stringify(value)), { status: r.status });
  return value;
}
async function until(fn) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); }
  throw Error('visual novel fixture timed out');
}

test('VN durable chunks: resume, full retry, manual retry, changed model, cancellation and access checks', async (t) => {
  let requests = [], failures = 0, hold = false, releaseHeld;
  const fixture = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    // Only VN requests are part of this test; background observers may run in CI.
    if (!body.instructions?.includes('visual-novel script')) {
      res.statusCode = 400; return res.end('{}');
    }
    const user = body.input.find(x => x.role === 'user').content;
    const part = Number(/Part (\d+)/.exec(user)[1]);
    requests.push({ part, body });
    if (hold) { hold = false; await new Promise(resolve => { releaseHeld = resolve; }); }
    // Longer than the short daily timeout used in the local regression run.
    if (part === 1) await new Promise(r => setTimeout(r, 1200));
    if (part === 2 && failures-- > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'controlled part failure' } }));
    }
    const refs = [...user.matchAll(/\[(L\d+)\]/g)].map(m => m[1]);
    const text = JSON.stringify({ script: refs.map(ref => ({ ref, background: 'Harbour' })), generate_backgrounds: [{ name: 'Harbour', prompt: 'Foggy harbour' }], generate_portraits: [] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }));
  });
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  t.after(() => { releaseHeld?.(); fixture.closeAllConnections(); fixture.close(); });
  const suffix = Math.random().toString(36).slice(2);
  const gm = (await call('', 'POST', '/api/auth/register', { username: 'vnretrygm' + suffix, password: 'password' })).token;
  const pl = (await call('', 'POST', '/api/auth/register', { username: 'vnretrypl' + suffix, password: 'password' })).token;
  const srv = await call(gm, 'POST', '/api/servers', { name: 'VN retry fixture' });
  const ch = (await call(gm, 'POST', `/api/servers/${srv.id}/channels`, { name: 'Script retry' })).id;
  await call(gm, 'POST', `/api/channels/${ch}/members`, { username: 'vnretrypl' + suffix, role: 'player' });
  const root = `/api/channels/${ch}/studio`, path = root + '/vn-scripts';
  const settings = `/api/servers/${srv.id}/settings`;
  const setModel = model => call(gm, 'PUT', settings, { llm: { provider: 'openai_compatible', api_base: `http://127.0.0.1:${fixture.address().port}/v1`, api_key: 'fixture', model } });
  t.after(async () => { await call(gm, 'PUT', settings, { llm: { provider: 'mock' } }).catch(() => {}); });
  await call(gm, 'PUT', root + '/settings', { studio_cloud_allowed: true });
  const window = (await call(gm, 'GET', `/api/channels/${ch}/windows`))[0].id;
  for (let i = 0; i < 21; i++) await call(gm, 'POST', `/api/channels/${ch}/windows/${window}/messages`, { content: `Scene ${i}: ` + 'fog '.repeat(400), kind: 'narration' });
  await setModel('fixture-vn');
  const config = await call(gm, 'GET', path + '/status');
  assert.ok(config.max_tokens > 0 && config.timeout_ms >= 1000);
  assert.equal(typeof config.retry_failed_chunks, 'boolean');
  const create = retry_failed_chunks => call(gm, 'POST', path, { allow_cloud: true, generate_art: false, retry_failed_chunks });
  const done = id => until(async () => { const j = await call(gm, 'GET', path + '/' + id); return ['failed', 'completed', 'cancelled'].includes(j.status) && j; });
  await assert.rejects(create('yes'), e => e.status === 400);

  failures = 1;
  const a = await create(true), ad = await done(a.id);
  assert.equal(ad.status, 'completed', ad.error);
  assert.deepEqual(requests.map(x => x.part), [1, 2, 2, 3]);
  assert.equal(ad.progress.chunks_reused, 1);
  assert.ok(requests.every(x => x.body.max_output_tokens === config.max_tokens));
  await assert.rejects(call(gm, 'POST', path + '/' + a.id + '/retry', {}), e => e.status === 400);

  requests = []; failures = 1;
  const b = await create(false), bd = await done(b.id);
  assert.equal(bd.status, 'completed', bd.error);
  assert.deepEqual(requests.map(x => x.part), [1, 2, 1, 2, 3]);
  assert.equal(bd.progress.chunks_reused, 0);

  requests = []; failures = 10;
  const c = await create(true), cd = await done(c.id);
  assert.equal(cd.status, 'failed'); assert.match(cd.error, /Part 2\/3/);
  assert.equal(cd.progress.chunks_done, 1);
  await assert.rejects(call(pl, 'POST', path + '/' + c.id + '/retry', {}), e => e.status === 404);
  await call(gm, 'PUT', root + '/settings', { studio_cloud_allowed: false });
  await assert.rejects(call(gm, 'POST', path + '/' + c.id + '/retry', {}), e => e.status === 403);
  await call(gm, 'PUT', root + '/settings', { studio_cloud_allowed: true });
  failures = 0; requests = [];
  const retried = await call(gm, 'POST', path + '/' + c.id + '/retry', {});
  assert.equal(retried.snapshot_id, c.snapshot_id);
  assert.equal((await done(c.id)).status, 'completed');
  assert.deepEqual(requests.map(x => x.part), [2, 3]);

  failures = 10; requests = [];
  const d = await create(true); assert.equal((await done(d.id)).status, 'failed');
  await setModel('fixture-vn-changed'); failures = 0; requests = [];
  await call(gm, 'POST', path + '/' + d.id + '/retry', {});
  assert.equal((await done(d.id)).status, 'completed');
  assert.deepEqual(requests.map(x => x.part), [1, 2, 3]);

  hold = true; requests = [];
  const e = await create(true); await until(() => releaseHeld);
  await call(gm, 'POST', path + '/' + e.id + '/cancel', {});
  releaseHeld();
  assert.equal((await done(e.id)).status, 'cancelled');
  await assert.rejects(call(gm, 'POST', path + '/' + e.id + '/retry', {}), e => e.status === 400);
});
