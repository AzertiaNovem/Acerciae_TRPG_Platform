import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const base = process.env.API_BASE || 'http://127.0.0.1:18081';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await r.json();
  if (!r.ok) throw Object.assign(Error(JSON.stringify(value)), { status: r.status });
  return value;
}
async function until(fn) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); }
  throw Error('background retry fixture timed out');
}

test('VN background resume preserves successful art, retries failed/cancelled jobs and deduplicates concurrent clicks', async (t) => {
  let requests = 0, mode = 'initial', release;
  const fixture = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); ++requests;
    assert.equal(body.background, undefined, 'scene backgrounds must not ask for transparency');
    if (mode === 'hold') await new Promise(resolve => { release = resolve; });
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'initial' && requests === 2) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'controlled background failure' } })); }
    res.end(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  t.after(() => { release?.(); fixture.closeAllConnections(); fixture.close(); });
  const suffix = Math.random().toString(36).slice(2);
  const gm = await call('', 'POST', '/api/auth/register', { username: 'vnbggm' + suffix, password: 'password' });
  const pl = await call('', 'POST', '/api/auth/register', { username: 'vnbgpl' + suffix, password: 'password' });
  const srv = await call(gm.token, 'POST', '/api/servers', { name: 'VN background retry fixture' });
  const ch = (await call(gm.token, 'POST', `/api/servers/${srv.id}/channels`, { name: 'Harbour' })).id;
  await call(gm.token, 'POST', `/api/channels/${ch}/members`, { username: 'vnbgpl' + suffix, role: 'player' });
  const root = `/api/channels/${ch}/studio`, settings = `/api/servers/${srv.id}/settings`;
  await call(gm.token, 'PUT', settings, { llm: { provider: 'mock' }, image: { provider: 'gpt_image', api_base: `http://127.0.0.1:${fixture.address().port}/v1`, api_key: 'fixture', model: 'fixture-image' } });
  t.after(async () => { await call(gm.token, 'PUT', settings, { image: { provider: 'disabled' } }).catch(() => {}); });
  await call(gm.token, 'PUT', root + '/settings', { studio_cloud_allowed: true });
  const main = (await call(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  const side = (await call(gm.token, 'POST', `/api/channels/${ch}/windows`, { name: 'Archive', kind: 'private', members: [{ user_id: pl.user.id }] })).id;
  for (const w of [main, side]) await call(gm.token, 'POST', `/api/channels/${ch}/windows/${w}/messages`, { content: 'The room is quiet.', kind: 'narration' });
  const j = await call(gm.token, 'POST', root + '/vn-scripts', { generate_art: false, allow_cloud: true });
  const path = root + '/vn-scripts/' + j.id;
  const get = () => call(gm.token, 'GET', path);
  const retry = body => call(gm.token, 'POST', path + '/backgrounds/retry', body ?? {});
  const done = await until(async () => { const x = await get(); return x.status === 'completed' && x; });
  assert.equal(done.background_jobs.length, 2);
  assert.ok(done.background_jobs.every(b => b.status === 'missing'));
  assert.equal(requests, 0);
  await assert.rejects(call(pl.token, 'POST', path + '/backgrounds/retry', {}), e => e.status === 404);
  await assert.rejects(retry({ scene_key: 'not-this-draft' }), e => e.status === 404);
  await assert.rejects(retry({ scene_key: false }), e => e.status === 400);
  await retry();
  const mixed = await until(async () => { const x = await get(); return x.background_jobs.some(b => b.status === 'failed') && x; });
  assert.equal(requests, 2);
  const good = mixed.background_jobs.find(b => b.status === 'completed'), bad = mixed.background_jobs.find(b => b.status === 'failed');
  assert.ok(good && bad); assert.match(bad.error, /HTTP 400/);
  const presPath = root + '/presentations/' + done.presentation_id;
  const first = await call(gm.token, 'GET', presPath);
  const kept = first.scenes.find(s => s.id === good.scene_id).background_asset_id;
  await call(gm.token, 'PUT', root + '/settings', { studio_cloud_allowed: false });
  await assert.rejects(retry({ scene_key: bad.scene_key }), e => e.status === 403);
  await call(gm.token, 'PUT', root + '/settings', { studio_cloud_allowed: true });

  mode = 'hold';
  await Promise.all(Array.from({ length: 5 }, () => retry({ scene_key: bad.scene_key })));
  await until(() => release);
  assert.equal(requests, 3, 'concurrent retries must make only one provider request');
  let active = (await get()).background_jobs.find(b => b.scene_key === bad.scene_key);
  assert.equal(active.job_id, bad.job_id, 'same settings reuse the failed job');
  await call(gm.token, 'POST', root + '/images/jobs/' + active.job_id + '/cancel', {});
  assert.equal((await get()).background_jobs.find(b => b.scene_key === bad.scene_key).status, 'cancelled');
  mode = 'ok'; release(); release = undefined;
  await retry({ scene_key: bad.scene_key });
  await until(async () => (await get()).background_jobs.every(b => b.status === 'completed'));
  assert.equal(requests, 4);
  const after = await call(gm.token, 'GET', presPath);
  assert.equal(after.scenes.find(s => s.id === good.scene_id).background_asset_id, kept);
  await retry(); await retry({ scene_key: good.scene_key });
  assert.equal(requests, 4, 'completed backgrounds must not regenerate');
  assert.equal((await get()).presentation_id, done.presentation_id);
  // Simulate an interruption after the worker saved an asset but before attaching it.
  await call(gm.token, 'PUT', root + '/pscenes/' + good.scene_id, { background_asset_id: '' });
  assert.equal((await get()).background_jobs.find(b => b.scene_id === good.scene_id).status, 'missing');
  await retry({ scene_key: good.scene_key });
  assert.equal((await call(gm.token, 'GET', presPath)).scenes.find(s => s.id === good.scene_id).background_asset_id, kept);
  assert.equal(requests, 4, 'saved images should reattach without another generation request');

  // If the saved image itself was deleted, the completed job must be allowed to generate again.
  await call(gm.token, 'DELETE', `/api/channels/${ch}/media/${kept}`);
  await retry({ scene_key: good.scene_key });
  await until(async () => (await get()).background_jobs.every(b => b.status === 'completed'));
  assert.equal(requests, 5);

});
