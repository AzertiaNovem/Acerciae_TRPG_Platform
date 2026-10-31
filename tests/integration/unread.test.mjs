import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`); return data;
}

test('unread counters: per user and window, own messages and history excluded, cleared by reading', async () => {
  const sfx = Date.now().toString(36);
  const [gm, ann, bob] = await Promise.all(['gm', 'ann', 'bob'].map(n => request(null, 'POST', '/api/auth/register', { username: `unread_${n}_${sfx}`, display_name: n, password: 'password' })));
  const server = await request(gm.token, 'POST', '/api/servers', { name: 'Unread ' + sfx });
  for (const u of [ann, bob]) await request(gm.token, 'POST', `/api/servers/${server.id}/members`, { user_id: u.user.id, role: 'member' });
  const ch = (await request(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Harbour' })).id;
  const main = (await request(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  await request(gm.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'Before anyone joined.', kind: 'narration' });
  for (const u of [ann, bob]) await request(gm.token, 'POST', `/api/channels/${ch}/members`, { user_id: u.user.id, role: 'player' });
  const unread = async (who, win = main) => (await request(who.token, 'GET', `/api/channels/${ch}/windows`)).find((w) => w.id === win).unread;
  assert.equal(await unread(ann), 0, 'history from before joining is not unread');

  await request(gm.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'Rain on the pier.', kind: 'narration' });
  const last = await request(ann.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'I look around.', kind: 'ooc' });
  assert.equal(await unread(ann), 1, 'own messages do not count');
  assert.equal(await unread(bob), 2);
  assert.equal(await unread(gm), 1);

  // A window Bob is not in: neither listed nor counted for him.
  const side = (await request(gm.token, 'POST', `/api/channels/${ch}/windows`, { name: 'Side', kind: 'group', members: [{ user_id: ann.user.id }] })).id;
  await request(gm.token, 'POST', `/api/channels/${ch}/windows/${side}/messages`, { content: 'A secret.', kind: 'narration' });
  assert.equal(await unread(ann, side), 1);
  assert.ok(!(await request(bob.token, 'GET', `/api/channels/${ch}/windows`)).some((w) => w.id === side));
  await request(bob.token, 'POST', `/api/channels/${ch}/windows/${side}/read`, { seq: 1 }, 403);

  // Reading clears; it never goes backwards and never past the newest message.
  assert.equal((await request(bob.token, 'POST', `/api/channels/${ch}/windows/${main}/read`, { seq: last.seq })).last_read_seq, last.seq);
  assert.equal(await unread(bob), 0);
  await request(bob.token, 'POST', `/api/channels/${ch}/windows/${main}/read`, { seq: 1 });
  assert.equal(await unread(bob), 0);
  assert.equal((await request(ann.token, 'POST', `/api/channels/${ch}/windows/${main}/read`, { seq: last.seq + 1000 })).last_read_seq, last.seq);
  await request(gm.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'Thunder.', kind: 'narration' });
  assert.equal(await unread(ann), 1);
});
