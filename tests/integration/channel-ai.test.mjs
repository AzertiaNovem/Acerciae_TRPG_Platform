import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`); return data;
}

test('channel AI switches: the GM turns the chronicler, consistency, inspiration and atmosphere off for a token-free chat room', async () => {
  const sfx = Date.now().toString(36);
  const [gm, pl] = await Promise.all(['gm', 'pl'].map(n => request(null, 'POST', '/api/auth/register', { username: `cai_${n}_${sfx}`, display_name: n, password: 'password' })));
  const server = await request(gm.token, 'POST', '/api/servers', { name: 'Hub ' + sfx });
  await request(gm.token, 'PUT', `/api/servers/${server.id}/settings`, { features: { atmosphere: true }, image: { provider: 'mock' } });
  await request(pl.token, 'PUT', '/api/auth/me', { atmosphere_enabled: true });
  const ch = (await request(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Lobby' })).id;
  await request(gm.token, 'POST', `/api/channels/${ch}/members`, { user_id: pl.user.id, role: 'player' });
  const main = (await request(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  const say = (content) => request(gm.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content, kind: 'narration' });

  // Everything on by default, and only the GM changes it.
  const before = await request(pl.token, 'GET', `/api/channels/${ch}`);
  for (const k of ['ai_enabled', 'consistency_enabled', 'inspiration_enabled', 'atmosphere_enabled']) assert.equal(before[k], true, k);
  await request(pl.token, 'PUT', `/api/channels/${ch}`, { ai_enabled: false }, 403);
  assert.equal((await request(pl.token, 'GET', `/api/channels/${ch}/atmosphere`)).enabled, true);

  const off = await request(gm.token, 'PUT', `/api/channels/${ch}`, { ai_enabled: false, consistency_enabled: false, inspiration_enabled: false, atmosphere_enabled: false });
  for (const k of ['ai_enabled', 'consistency_enabled', 'inspiration_enabled', 'atmosphere_enabled']) assert.equal(off[k], false, k);
  // The player's helpers answer feature_disabled; the backdrop is off for everyone.
  const draft = await request(pl.token, 'POST', `/api/channels/${ch}/inspiration`, { chat_window_id: main, hint: 'anything' }, 403);
  assert.equal(draft.error, 'feature_disabled');
  const check = await request(pl.token, 'POST', `/api/channels/${ch}/consistency`, { chat_window_id: main, draft: 'I open the door.' }, 403);
  assert.equal(check.error, 'feature_disabled');
  assert.equal((await request(pl.token, 'GET', `/api/channels/${ch}/atmosphere`)).enabled, false);
  // The observer skips the channel even when a run is asked for: chat happens, no AI job is created.
  for (let i = 0; i < 6; i++) await say(`Lobby chatter ${i}: the next morning, far away in another town…`);
  assert.deepEqual(await request(gm.token, 'POST', `/api/channels/${ch}/ai/observe-now`), { jobs: [] });
  await new Promise(r => setTimeout(r, 2500));   // longer than the test server's observer interval
  assert.equal((await request(gm.token, 'GET', `/api/channels/${ch}/ai/jobs`)).length, 0);
  assert.equal((await request(gm.token, 'GET', `/api/channels/${ch}/atmosphere/history`)).length, 0);

  // Back on: the switches hold their own and the helpers answer again (mock LLM here).
  const on = await request(gm.token, 'PUT', `/api/channels/${ch}`, { ai_enabled: true, consistency_enabled: true, inspiration_enabled: true });
  assert.equal(on.ai_enabled, true); assert.equal(on.inspiration_enabled, true); assert.equal(on.atmosphere_enabled, false);
  await request(pl.token, 'POST', `/api/channels/${ch}/inspiration`, { chat_window_id: main, hint: 'anything' });
  assert.ok((await request(gm.token, 'POST', `/api/channels/${ch}/ai/observe-now`)).jobs.length >= 1);
});
