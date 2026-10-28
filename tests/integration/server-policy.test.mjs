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
function socket(token, sub) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/ws/chat?token=${token}`), messages = [];
    const timer = setTimeout(() => { ws.close(); reject(Error('socket timeout')); }, 5000);
    ws.on('error', reject);
    ws.on('message', raw => {
      const m = JSON.parse(raw); messages.push(m);
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'subscribe', ...sub }));
      if (m.type === 'subscribed' || m.type === 'error') { clearTimeout(timer); resolve({ ws, messages, first: m }); }
    });
  });
}

test('server policy: join modes and invites, channel creation, guests see only their channel, Main Chat spectators read public lines only', async () => {
  const suffix = Date.now().toString(36);
  const [owner, gm, member, outsider, stranger] = await Promise.all(['owner', 'gm', 'member', 'outsider', 'stranger'].map(n =>
    request(null, 'POST', '/api/auth/register', { username: `sp_${n}_${suffix}`, display_name: n, password: 'password' })));
  const server = await request(owner.token, 'POST', '/api/servers', { name: 'Policy ' + suffix });
  const settings = `/api/servers/${server.id}/settings`;
  const s0 = await request(owner.token, 'GET', settings);
  assert.deepEqual(s0.policy, { join_policy: 'invite', channel_creation: 'members', guest_invites: false, main_chat_spectators: false });

  // Invite (default): no code, no entry; a code lets one person in and can be limited, expired and revoked.
  await request(member.token, 'POST', `/api/servers/${server.id}/join`, {}, 403);
  assert.ok(!(await request(member.token, 'GET', '/api/server-directory')).some(s => s.id === server.id));
  await request(member.token, 'POST', `/api/servers/${server.id}/invites`, {}, 403);
  const once = await request(owner.token, 'POST', `/api/servers/${server.id}/invites`, { max_uses: 1, expires_in_hours: 24 });
  assert.match(once.code, /^[a-z2-9]{10}$/); assert.ok(once.expires_at);
  const preview = await request(member.token, 'GET', `/api/invites/${once.code}`);
  assert.equal(preview.name, server.name); assert.equal(preview.valid, true); assert.equal(preview.already_member, false);
  assert.equal((await request(member.token, 'POST', `/api/invites/${once.code}/accept`)).my_role, 'member');
  await request(gm.token, 'POST', `/api/invites/${once.code}/accept`, undefined, 410);           // used up
  const open = await request(owner.token, 'POST', `/api/servers/${server.id}/invites`, { expires_in_hours: 0 });
  assert.equal(open.expires_at, null);
  await request(owner.token, 'DELETE', `/api/servers/${server.id}/invites/${open.id}`);
  await request(gm.token, 'POST', `/api/servers/${server.id}/join`, { invite_code: open.code }, 410);  // revoked
  const listed = await request(owner.token, 'GET', `/api/servers/${server.id}/invites`);
  assert.deepEqual(listed.map(i => i.active), [false, false]);
  const gmInvite = await request(owner.token, 'POST', `/api/servers/${server.id}/invites`, {});
  await request(gm.token, 'POST', `/api/servers/${server.id}/join`, { invite_code: gmInvite.code });

  // Closed: invites stop working and cannot be created; maintainers still add members directly.
  await request(owner.token, 'PUT', settings, { policy: { join_policy: 'closed' } });
  await request(stranger.token, 'POST', `/api/invites/${gmInvite.code}/accept`, undefined, 403);
  await request(owner.token, 'POST', `/api/servers/${server.id}/invites`, {}, 400);
  // Open: listed in the directory, anyone may join.
  await request(owner.token, 'PUT', settings, { policy: { join_policy: 'open' } });
  assert.ok((await request(stranger.token, 'GET', '/api/server-directory?q=' + suffix)).some(s => s.id === server.id));
  await request(stranger.token, 'POST', `/api/servers/${server.id}/join`);
  await request(owner.token, 'DELETE', `/api/servers/${server.id}/members/${stranger.user.id}`);
  await request(owner.token, 'PUT', settings, { policy: { join_policy: 'invite' } });
  await request(owner.token, 'PUT', settings, { policy: { join_policy: 'anyone' } }, 400);

  // Channel creation: maintainers only.
  await request(owner.token, 'PUT', settings, { policy: { channel_creation: 'maintainers' } });
  await request(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Not allowed' }, 403);
  await request(owner.token, 'PUT', settings, { policy: { channel_creation: 'members' } });
  const ch = (await request(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Harbour' })).id;
  const other = (await request(owner.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Other table' })).id;
  const root = `/api/channels/${ch}`;

  // Guests: refused until the server allows them; then they see only the channel they were invited to.
  await request(gm.token, 'POST', root + '/members', { user_id: outsider.user.id, role: 'player' }, 400);
  await request(owner.token, 'PUT', settings, { policy: { guest_invites: true } });
  const added = await request(gm.token, 'POST', root + '/members', { user_id: outsider.user.id, role: 'player' });
  assert.equal(added.server_role, 'guest');
  assert.equal((await request(outsider.token, 'GET', '/api/servers')).find(s => s.id === server.id).my_role, 'guest');
  assert.deepEqual((await request(outsider.token, 'GET', `/api/servers/${server.id}/channels`)).map(c => c.id), [ch]);
  await request(outsider.token, 'GET', `/api/channels/${other}`, undefined, 403);
  await request(outsider.token, 'GET', `/api/servers/${server.id}/members`, undefined, 403);
  await request(outsider.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Guest table' }, 403);
  // Someone already on the server stays a member; a maintainer's invitation makes an outsider a member, not a guest.
  assert.equal((await request(gm.token, 'POST', root + '/members', { user_id: member.user.id, role: 'player' })).server_role, 'member');
  await request(gm.token, 'DELETE', root + `/members/${member.user.id}`);
  assert.equal((await request(owner.token, 'POST', `/api/channels/${other}/members`, { user_id: stranger.user.id, role: 'player' })).server_role, 'member');

  // Spectators: off by default; when on, members (not guests) read public Main Chat lines of channels they are not in.
  const main = (await request(gm.token, 'GET', root + '/windows')).find(w => w.kind === 'main').id;
  await request(gm.token, 'POST', root + `/windows/${main}/messages`, { content: 'The fog rolls in over the harbour.', kind: 'narration' });
  await request(gm.token, 'POST', root + `/windows/${main}/messages`, { content: 'KP_ONLY_spectate', kind: 'narration', visibility: 'gm_only' });
  await request(member.token, 'GET', root + '/spectate', undefined, 403);
  assert.deepEqual(await request(member.token, 'GET', `/api/servers/${server.id}/spectate`), []);
  await request(owner.token, 'PUT', settings, { policy: { main_chat_spectators: true } });
  assert.deepEqual((await request(member.token, 'GET', `/api/servers/${server.id}/spectate`)).map(c => c.id).sort(), [ch, other].sort());
  assert.deepEqual((await request(stranger.token, 'GET', `/api/servers/${server.id}/spectate`)).map(c => c.id), [ch]);
  await request(outsider.token, 'GET', `/api/channels/${other}/spectate`, undefined, 403);
  const view = await request(member.token, 'GET', root + '/spectate');
  assert.equal(view.window.id, main);
  assert.deepEqual(view.messages.map(m => m.content), ['The fog rolls in over the harbour.']);
  // Spectating grants nothing else in the channel.
  await request(member.token, 'GET', root + '/windows', undefined, 403);
  await request(member.token, 'POST', root + `/windows/${main}/messages`, { content: 'hello', kind: 'ooc' }, 403);
  const denied = await socket(outsider.token, { channel_id: ch, spectate: true });
  assert.equal(denied.first.type, 'error'); denied.ws.close();
  const live = await socket(member.token, { channel_id: ch, spectate: true });
  const memberSock = await socket(outsider.token, { channel_id: ch });
  await request(gm.token, 'POST', root + `/windows/${main}/messages`, { content: 'A bell tolls.', kind: 'narration' });
  await request(gm.token, 'POST', root + `/windows/${main}/messages`, { content: 'KP_ONLY_live', kind: 'narration', visibility: 'gm_only' });
  await until(() => live.messages.some(m => m.type === 'spectate.message' && m.message.content === 'A bell tolls.'));
  await until(() => memberSock.messages.some(m => m.type === 'message.posted' && m.message.content === 'A bell tolls.'));
  await wait(300);
  assert.ok(!live.messages.some(m => JSON.stringify(m).includes('KP_ONLY')));
  assert.ok(!live.messages.some(m => m.type === 'window.changed' || m.type === 'message.posted'));
  live.ws.close(); memberSock.ws.close();

  // A guest removed from their last channel leaves the server.
  await request(gm.token, 'DELETE', root + `/members/${outsider.user.id}`);
  assert.ok(!(await request(outsider.token, 'GET', '/api/servers')).some(s => s.id === server.id));
});
