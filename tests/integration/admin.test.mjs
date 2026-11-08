import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
// Platform administration: PLATFORM_ADMINS (the test server names `platform_admin`) and granted administrators inspect
// storage, database and account use across every server, and suspend servers and accounts; nothing is deleted and
// every action is logged. scripts/test.sh provisions `platform_admin` through the trusted test database before starting the server.
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  if (!r.ok) throw Object.assign(Error(JSON.stringify(d)), { status: r.status, body: d });
  return d;
}
const rejects = async (p, status, code) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); if (code) assert.equal(e.body.error, code); return e; } assert.fail(`expected HTTP ${status}`); };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
async function adminToken() {
  return (await call('', 'POST', '/api/auth/login', {username:'platform_admin',password:'password'})).token;
}
function socket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/ws/chat?token=${encodeURIComponent(token)}`);
    const state = { ws, closed: false };
    ws.on('error', reject); ws.on('close', () => { state.closed = true; });
    ws.on('message', (raw) => { if (JSON.parse(raw).type === 'hello') resolve(state); });
  });
}
const until = async (fn) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail('condition timeout'); };

test('platform administration: overview, server and user inspection, suspensions with their effects, granted administrators, the audit log', async () => {
  const sfx = Math.random().toString(36).slice(2, 8);
  const admin = await adminToken();
  const owner = await call('', 'POST', '/api/auth/register', { username: `own_${sfx}`, password: 'password', display_name: 'Owner' });
  const player = await call('', 'POST', '/api/auth/register', { username: `pl_${sfx}`, password: 'password', display_name: 'Player' });
  const other = await call('', 'POST', '/api/auth/register', { username: `oth_${sfx}`, password: 'password', display_name: 'Other' });

  // Only administrators reach the panel; the profile says who is one.
  assert.equal((await call(admin, 'GET', '/api/auth/me')).is_admin, true);
  assert.equal((await call(owner.token, 'GET', '/api/auth/me')).is_admin, false);
  await rejects(call(owner.token, 'GET', '/api/admin/overview'), 403, 'admin_required');
  await rejects(call(owner.token, 'GET', '/api/admin/users'), 403, 'admin_required');

  // A server with a channel, a member, a message and an uploaded image.
  const srv = await call(owner.token, 'POST', '/api/servers', { name: `Abuse ${sfx}` });
  const ch = (await call(owner.token, 'POST', `/api/servers/${srv.id}/channels`, { name: 'Gallery' })).id;
  await call(owner.token, 'POST', `/api/channels/${ch}/members`, { user_id: player.user.id, role: 'player' });
  const main = (await call(owner.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  await call(owner.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'The gallery opens.', kind: 'narration' });
  const form = new FormData(); form.append('file', new Blob([png], { type: 'image/png' }), 'poster.png');
  const up = await fetch(base + `/api/channels/${ch}/media`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: form });
  assert.equal(up.status, 200);
  const pub = await call(owner.token, 'POST', `/api/channels/${ch}/studio/publications`, { kind: 'styled', visibility: 'link', title: 'Public gallery' }).catch(() => null);

  // The overview counts what the deployment holds.
  const ov = await call(admin, 'GET', '/api/admin/overview');
  assert.ok(ov.users.total >= 4); assert.ok(ov.servers.total >= 1); assert.ok(ov.storage.bytes >= png.length); assert.ok(ov.storage.images >= 1);
  assert.ok(ov.database.bytes > 0); assert.ok(ov.database.tables.length > 0); assert.ok(typeof ov.storage.store === 'string');
  assert.ok(ov.users.listed_admins.includes('platform_admin'));

  // Server rows carry storage and activity; the detail lists channels and members.
  const servers = await call(admin, 'GET', `/api/admin/servers?q=${encodeURIComponent(`Abuse ${sfx}`)}&sort=storage`);
  assert.equal(servers.total, 1); const row = servers.rows[0];
  assert.equal(row.owner_username, `own_${sfx}`); assert.equal(row.member_count, 2); assert.equal(row.channel_count, 1); assert.ok(row.message_count >= 1);
  assert.equal(row.images, 1); assert.equal(row.bytes, png.length); assert.equal(row.suspended, false);
  const detail = await call(admin, 'GET', `/api/admin/servers/${srv.id}`);
  assert.equal(detail.channels[0].name, 'Gallery'); assert.equal(detail.channels[0].bytes, png.length);
  assert.deepEqual(detail.members.map((m) => m.role).sort(), ['member', 'owner']);
  const byOwner = await call(admin, 'GET', `/api/admin/servers?q=own_${sfx}`);
  assert.equal(byOwner.total, 1, 'servers are found by their owner too');

  // User rows attribute the media they made.
  const users = await call(admin, 'GET', `/api/admin/users?q=own_${sfx}`);
  assert.equal(users.total, 1); assert.equal(users.rows[0].images, 1); assert.equal(users.rows[0].bytes, png.length); assert.equal(users.rows[0].owned_count, 1);
  const udetail = await call(admin, 'GET', `/api/admin/users/${owner.user.id}`);
  assert.equal(udetail.servers[0].id, srv.id); assert.equal(udetail.servers[0].role, 'owner');

  // Suspending a server needs a reason; afterwards nothing inside it answers, sockets drop, published links go dark,
  // but the owner still signs in and sees the server listed with the reason.
  await rejects(call(admin, 'PUT', `/api/admin/servers/${srv.id}/suspension`, { suspended: true }), 400);
  const sock = await socket(player.token);
  sock.ws.send(JSON.stringify({ type: 'subscribe', channel_id: ch }));
  const suspended = await call(admin, 'PUT', `/api/admin/servers/${srv.id}/suspension`, { suspended: true, reason: 'Image storage abuse' });
  assert.equal(suspended.suspended, true); assert.equal(suspended.suspended_reason, 'Image storage abuse');
  await rejects(call(owner.token, 'GET', `/api/servers/${srv.id}/channels`), 403, 'server_suspended');
  await rejects(call(player.token, 'GET', `/api/channels/${ch}/windows/${main}/messages`), 403, 'server_suspended');
  await rejects(call(owner.token, 'GET', `/api/servers/${srv.id}/settings`), 403, 'server_suspended');
  await rejects(call(other.token, 'POST', `/api/servers/${srv.id}/join`, {}), 403, 'server_suspended');
  const listed = (await call(owner.token, 'GET', '/api/servers')).find((s) => s.id === srv.id);
  assert.equal(listed.suspended, true); assert.equal(listed.suspended_reason, 'Image storage abuse');
  if (pub?.share_token) await rejects(call('', 'GET', `/api/published/${pub.share_token}`), 404);
  // The subscription is gone: a message posted later (after reinstatement) must not reach the stale subscription.
  // Here we check the simpler invariant: the socket is still open but a new subscribe is refused while suspended.
  const refused = new Promise((resolve) => sock.ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'error') resolve(m); }));
  sock.ws.send(JSON.stringify({ type: 'subscribe', channel_id: ch }));
  assert.ok(await Promise.race([refused, new Promise((r) => setTimeout(() => r(null), 3000))]), 'subscribing to a suspended server\'s channel is refused');
  sock.ws.close();
  // Reinstating brings it back.
  const back = await call(admin, 'PUT', `/api/admin/servers/${srv.id}/suspension`, { suspended: false });
  assert.equal(back.suspended, false);
  assert.equal((await call(owner.token, 'GET', `/api/servers/${srv.id}/channels`)).length, 1);

  // Suspending an account ends its sessions at once; signing in names the reason; reinstating lets it in again.
  const psock = await socket(player.token);
  const sus = await call(admin, 'PUT', `/api/admin/users/${player.user.id}/suspension`, { suspended: true, reason: 'Harassment in chat' });
  assert.equal(sus.suspended, true);
  await rejects(call(player.token, 'GET', '/api/auth/me'), 401);
  await until(() => psock.closed);
  const login = await rejects(call('', 'POST', '/api/auth/login', { username: `pl_${sfx}`, password: 'password' }), 403, 'account_suspended');
  assert.match(login.body.message, /Harassment in chat/);
  await call(admin, 'PUT', `/api/admin/users/${player.user.id}/suspension`, { suspended: false });
  const again = await call('', 'POST', '/api/auth/login', { username: `pl_${sfx}`, password: 'password' });
  assert.ok(again.token);

  // Guard rails: not yourself, not an account named in PLATFORM_ADMINS.
  const me = (await call(admin, 'GET', '/api/auth/me')).id;
  await rejects(call(admin, 'PUT', `/api/admin/users/${me}/suspension`, { suspended: true, reason: 'x' }), 400);
  await rejects(call(admin, 'PUT', `/api/admin/users/${me}/admin`, { admin: false }), 400);

  // A granted administrator has the same powers until revoked; the audit log shows it all.
  await call(admin, 'PUT', `/api/admin/users/${other.user.id}/admin`, { admin: true, reason: 'second operator' });
  assert.equal((await call(other.token, 'GET', '/api/auth/me')).is_admin, true);
  assert.ok((await call(other.token, 'GET', '/api/admin/overview')).users.total >= 4);
  await call(admin, 'PUT', `/api/admin/users/${other.user.id}/admin`, { admin: false });
  await rejects(call(other.token, 'GET', '/api/admin/overview'), 403, 'admin_required');
  const log = await call(admin, 'GET', '/api/admin/actions?limit=20');
  const mine = log.rows.filter((a) => [srv.id, player.user.id, other.user.id].includes(a.target_id)).map((a) => a.action);
  for (const a of ['suspend_server', 'unsuspend_server', 'suspend_user', 'unsuspend_user', 'grant_admin', 'revoke_admin']) assert.ok(mine.includes(a), a);
  assert.equal(log.rows.find((a) => a.action === 'suspend_server' && a.target_id === srv.id).reason, 'Image storage abuse');
  assert.equal(log.rows.find((a) => a.action === 'suspend_server' && a.target_id === srv.id).admin_name, 'platform_admin');
});
