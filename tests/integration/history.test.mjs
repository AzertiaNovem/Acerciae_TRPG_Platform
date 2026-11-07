// Catching up: a client that keeps a window's history asks only for the lines after the last one it has.
import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`); return data;
}

test('history catch-up: after_seq returns the next lines oldest first, as the reader may see them, tombstones included', async () => {
  const sfx = Date.now().toString(36);
  const [gm, ann] = await Promise.all(['gm', 'ann'].map((n) => request(null, 'POST', '/api/auth/register', { username: `hist_${n}_${sfx}`, display_name: n, password: 'password' })));
  const server = await request(gm.token, 'POST', '/api/servers', { name: 'History ' + sfx });
  await request(gm.token, 'POST', `/api/servers/${server.id}/members`, { user_id: ann.user.id, role: 'member' });
  const ch = (await request(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Harbour' })).id;
  await request(gm.token, 'POST', `/api/channels/${ch}/members`, { user_id: ann.user.id, role: 'player' });
  const main = (await request(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  const say = (who, content, extra = {}) => request(who.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content, kind: 'ooc', ...extra });
  const lines = [];
  for (const n of [1, 2, 3, 4, 5]) lines.push(await say(n % 2 ? ann : gm, `line ${n}`));
  const secret = await say(gm, 'a Keeper note', { kind: 'narration', visibility: 'gm_only' });
  const after = (who, seq, limit) => request(who.token, 'GET', `/api/channels/${ch}/windows/${main}/messages?after_seq=${seq}${limit ? `&limit=${limit}` : ''}`);

  assert.deepEqual((await after(ann, lines[1].seq)).map((m) => m.content), ['line 3', 'line 4', 'line 5'], 'the lines after it, oldest first; not the Keeper note');
  assert.deepEqual((await after(gm, lines[1].seq)).map((m) => m.content), ['line 3', 'line 4', 'line 5', 'a Keeper note']);
  assert.deepEqual((await after(ann, lines[1].seq, 2)).map((m) => m.content), ['line 3', 'line 4'], 'a page at a time, from the oldest');
  assert.deepEqual(await after(gm, secret.seq), [], 'nothing after the newest line');
  assert.deepEqual((await after(ann, 0, 2)).map((m) => m.content), ['line 1', 'line 2'], 'after_seq=0: from the first line');
  // The newest page and paging back are unchanged.
  assert.deepEqual((await request(ann.token, 'GET', `/api/channels/${ch}/windows/${main}/messages?limit=2`)).map((m) => m.content), ['line 4', 'line 5']);
  assert.deepEqual((await request(ann.token, 'GET', `/api/channels/${ch}/windows/${main}/messages?before_seq=${lines[2].seq}&limit=2`)).map((m) => m.content), ['line 1', 'line 2']);

  // A line recalled since the client last read: the catch-up from before it brings its tombstone.
  await request(ann.token, 'POST', `/api/channels/${ch}/messages/${lines[4].id}/recall`);
  const caught = await after(ann, lines[3].seq);
  assert.equal(caught.length, 1); assert.equal(caught[0].id, lines[4].id); assert.ok(caught[0].recalled_at); assert.equal(caught[0].content, '');
});
