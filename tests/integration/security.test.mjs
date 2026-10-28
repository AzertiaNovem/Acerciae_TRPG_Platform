import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200, headers = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`); return data;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 50; i++) { const r = await fn(); if (r) return r; await wait(100); } throw Error('condition timeout'); }
function socket(token, channelId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/ws/chat?token=${encodeURIComponent(token)}`), messages = [];
    const state = { ws, messages, closed: false };
    const timer = setTimeout(() => { ws.close(); reject(Error('socket timeout')); }, 5000);
    ws.on('error', reject);
    ws.on('close', () => { state.closed = true; });
    ws.on('message', raw => {
      const m = JSON.parse(raw); messages.push(m);
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'subscribe', channel_id: channelId }));
      if (m.type === 'subscribed' || m.type === 'error') { clearTimeout(timer); resolve(state); }
    });
  });
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('security: session tokens stay out of URLs, file tokens are short-lived and die with the session, logins are throttled, sockets are revoked, CORS is closed', async () => {
  const sfx = Date.now().toString(36);
  const [gm, pl] = await Promise.all(['gm', 'pl'].map(n => request(null, 'POST', '/api/auth/register', { username: `sec_${n}_${sfx}`, display_name: n, password: 'password' })));
  const server = await request(gm.token, 'POST', '/api/servers', { name: 'Security ' + sfx });
  const ch = (await request(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Vault' })).id;
  await request(gm.token, 'POST', `/api/channels/${ch}/members`, { user_id: pl.user.id, role: 'player' });
  const form = new FormData(); form.append('file', new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }), 'map.png');
  const up = await fetch(base + `/api/channels/${ch}/media`, { method: 'POST', headers: { Authorization: `Bearer ${gm.token}` }, body: form });
  assert.equal(up.status, 200); const asset = await up.json();
  const media = `/api/channels/${ch}/media/${asset.id}`;

  // The session token is accepted only in the Authorization header.
  assert.equal((await fetch(base + media + `?token=${gm.token}`)).status, 401);
  assert.equal((await fetch(base + '/api/auth/me?token=' + gm.token)).status, 401);
  // A file token opens files (and only files), and is bound to the session.
  const session = (await request(null, 'POST', '/api/auth/login', { username: `sec_gm_${sfx}`, password: 'password' })).token;
  const file = await request(session, 'POST', '/api/auth/file-token');
  assert.match(file.token, /^f1\.[0-9a-f]{64}\.\d+\.[0-9a-f]{64}$/);
  assert.ok(file.expires_at * 1000 - Date.now() <= 6 * 3600 * 1000 + 5000);
  assert.equal((await fetch(base + media + `?token=${encodeURIComponent(file.token)}`)).status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${file.token}` } })).status, 401);
  const forged = file.token.replace(/\.(\d+)\./, (_, e) => `.${Number(e) + 3600}.`);
  assert.equal((await fetch(base + media + `?token=${encodeURIComponent(forged)}`)).status, 401);
  // Logging out ends the session's file tokens and closes its sockets.
  const sock = await socket(file.token, ch);
  assert.equal(sock.messages.at(-1).type, 'subscribed');
  await request(session, 'POST', '/api/auth/logout');
  assert.equal((await fetch(base + media + `?token=${encodeURIComponent(file.token)}`)).status, 401);
  await until(() => sock.closed);

  // A member removed from the channel stops receiving its traffic at once.
  const plSock = await socket(pl.token, ch);
  const main = (await request(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  await request(gm.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'before removal', kind: 'narration' });
  await until(() => plSock.messages.some(m => m.message?.content === 'before removal'));
  await request(gm.token, 'DELETE', `/api/channels/${ch}/members/${pl.user.id}`);
  await request(gm.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'after removal', kind: 'narration' });
  await wait(400);
  assert.ok(!plSock.messages.some(m => JSON.stringify(m).includes('after removal')));
  plSock.ws.close();

  // Password guessing: the sixth failure in a row on one account is refused before the password is checked.
  for (let i = 0; i < 5; i++) await request(null, 'POST', '/api/auth/login', { username: `sec_pl_${sfx}`, password: 'wrong' + i }, 401);
  const limited = await request(null, 'POST', '/api/auth/login', { username: `sec_pl_${sfx}`, password: 'password' }, 429);
  assert.equal(limited.error, 'too_many_attempts');
  // Other accounts are unaffected.
  await request(null, 'POST', '/api/auth/login', { username: `sec_gm_${sfx}`, password: 'password' });

  // No cross-origin access unless the deployment lists the origin.
  const cors = await fetch(base + '/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(base + '/api/auth/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);

});
