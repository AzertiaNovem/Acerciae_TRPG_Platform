import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`); return data;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 50; i++) { const r = await fn(); if (r) return r; await wait(100); } throw Error('condition timeout'); }
function socket(token, channelId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/ws/chat?token=${token}`), messages = [];
    const timer = setTimeout(() => { ws.close(); reject(Error('socket timeout')); }, 5000);
    ws.on('error', reject);
    ws.on('message', raw => {
      const m = JSON.parse(raw); messages.push(m);
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'subscribe', channel_id: channelId }));
      if (m.type === 'subscribed' || m.type === 'error') { clearTimeout(timer); resolve({ ws, messages }); }
    });
  });
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// A channel with chat, dice, characters, a role card, media, scenarios, groups and invites behind it.
async function populate(gm, player, serverId, name) {
  const ch = (await request(gm.token, 'POST', `/api/servers/${serverId}/channels`, { name })).id;
  await request(gm.token, 'POST', `/api/channels/${ch}/members`, { user_id: player.user.id, role: 'player' });
  const pc = await request(player.token, 'POST', `/api/channels/${ch}/characters`, { name: 'Ada' });
  const main = (await request(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  await request(gm.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'Rain on the harbour.', kind: 'narration' });
  await request(player.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: '.st spot60 SAN55', kind: 'ic', character_id: pc.id });
  await request(player.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: '.ra spot', kind: 'ic', character_id: pc.id });
  await request(player.token, 'PUT', `/api/channels/${ch}/characters/${pc.id}/card`, { role_card: { characteristics: { DEX: 60, EDU: 70 } } });
  await request(gm.token, 'POST', `/api/channels/${ch}/windows`, { name: 'Side', kind: 'group', members: [{ user_id: player.user.id }] });
  await request(gm.token, 'POST', `/api/channels/${ch}/scenarios/advance`, { title: 'The pier' });
  const form = new FormData(); form.append('file', new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }), 'map.png');
  const up = await fetch(base + `/api/channels/${ch}/media`, { method: 'POST', headers: { Authorization: `Bearer ${gm.token}` }, body: form });
  assert.equal(up.status, 200);
  await request(gm.token, 'GET', `/api/channels/${ch}/studio/log`);
  return ch;
}

test('deletion: maintainers delete channels, only the owner deletes the server, both after typing the phrase', async () => {
  const sfx = Date.now().toString(36);
  const [owner, admin, gm, player] = await Promise.all(['owner', 'admin', 'gm', 'player'].map(n =>
    request(null, 'POST', '/api/auth/register', { username: `del_${n}_${sfx}`, display_name: n, password: 'password' })));
  const server = await request(owner.token, 'POST', '/api/servers', { name: 'Doomed ' + sfx });
  for (const [u, role] of [[admin, 'admin'], [gm, 'member'], [player, 'member']]) await request(owner.token, 'POST', `/api/servers/${server.id}/members`, { user_id: u.user.id, role });
  await request(owner.token, 'POST', `/api/servers/${server.id}/invites`, {});
  const first = await populate(gm, player, server.id, 'Arkham');
  const second = await populate(gm, player, server.id, 'Dunwich');

  // Maintainers see every channel, member or not; others do not get the list.
  assert.deepEqual((await request(admin.token, 'GET', `/api/servers/${server.id}/all-channels`)).map(c => c.name), ['Arkham', 'Dunwich']);
  await request(gm.token, 'GET', `/api/servers/${server.id}/all-channels`, undefined, 403);
  // A channel: server maintainers only, and only with the phrase. Its GM is not enough.
  await request(gm.token, 'DELETE', `/api/channels/${first}`, { confirm: 'Delete Channel' }, 403);
  const missing = await request(admin.token, 'DELETE', `/api/channels/${first}`, {}, 400);
  assert.equal(missing.error, 'confirmation_required');
  await request(admin.token, 'DELETE', `/api/channels/${first}`, { confirm: 'delete channel' }, 400);
  const watching = await socket(player.token, first);
  const gone = await request(admin.token, 'DELETE', `/api/channels/${first}`, { confirm: 'Delete Channel' });
  assert.equal(gone.ok, true); assert.ok(gone.files >= 1, 'the uploaded map is removed from storage');
  await until(() => watching.messages.some(m => m.type === 'channel.deleted' && m.channel_id === first));
  watching.ws.close();
  await request(player.token, 'GET', `/api/channels/${first}`, undefined, 404);
  assert.deepEqual((await request(player.token, 'GET', `/api/servers/${server.id}/channels`)).map(c => c.id), [second]);
  await request(admin.token, 'DELETE', `/api/channels/${first}`, { confirm: 'Delete Channel' }, 404);

  // The server: its owner only — not a maintainer — and only with the phrase.
  await request(admin.token, 'DELETE', `/api/servers/${server.id}`, { confirm: 'Delete Server' }, 403);
  await request(player.token, 'DELETE', `/api/servers/${server.id}`, { confirm: 'Delete Server' }, 403);
  await request(owner.token, 'DELETE', `/api/servers/${server.id}`, { confirm: 'Delete Channel' }, 400);
  const outsider = (await request(null, 'POST', '/api/auth/register', { username: `del_out_${sfx}`, display_name: 'out', password: 'password' })).token;
  await request(outsider, 'DELETE', `/api/servers/${server.id}`, { confirm: 'Delete Server' }, 404);
  const listening = await socket(player.token, second);
  const removed = await request(owner.token, 'DELETE', `/api/servers/${server.id}`, { confirm: 'Delete Server' });
  assert.equal(removed.ok, true); assert.equal(removed.channels, 1);
  await until(() => listening.messages.some(m => m.type === 'server.deleted' && m.server_id === server.id));
  listening.ws.close();
  for (const u of [owner, admin, player]) assert.ok(!(await request(u.token, 'GET', '/api/servers')).some(s => s.id === server.id));
  await request(player.token, 'GET', `/api/channels/${second}`, undefined, 404);
});
