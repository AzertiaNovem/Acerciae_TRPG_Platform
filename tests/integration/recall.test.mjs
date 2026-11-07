// Recall: the author takes a line back. Everyone who could read it is told live, it stops counting as unread, the
// campaign log loses it, and what the AI made of it is forgotten.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  assert.equal(res.status, status, `${method} ${path}: ${text}`); return data;
}
function chatSocket(token, channelId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/chat?token=${token}`);
    const received = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()); received.push(m);
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'subscribe', channel_id: channelId }));
      if (m.type === 'subscribed') resolve({ ws, received });
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 8000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, label, timeout = 5000) {
  const start = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(50); }
}

test('recall: author only, pushed to who could read it, a tombstone everywhere, gone from unread, search, the log and the journal', async () => {
  const sfx = Date.now().toString(36);
  const [gm, ann, bob] = await Promise.all(['gm', 'ann', 'bob'].map((n) => request(null, 'POST', '/api/auth/register', { username: `recall_${n}_${sfx}`, display_name: n, password: 'password' })));
  const server = await request(gm.token, 'POST', '/api/servers', { name: 'Recall ' + sfx });
  for (const u of [ann, bob]) await request(gm.token, 'POST', `/api/servers/${server.id}/members`, { user_id: u.user.id, role: 'member' });
  const ch = (await request(gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Lighthouse', knowledge_mode: 'isolated' })).id;
  for (const u of [ann, bob]) await request(gm.token, 'POST', `/api/channels/${ch}/members`, { user_id: u.user.id, role: 'player' });
  const main = (await request(gm.token, 'GET', `/api/channels/${ch}/windows`))[0].id;
  const side = (await request(gm.token, 'POST', `/api/channels/${ch}/windows`, { name: 'Ann alone', kind: 'group', members: [{ user_id: ann.user.id }] })).id;
  const say = (who, win, content, kind = 'ic') => request(who.token, 'POST', `/api/channels/${ch}/windows/${win}/messages`, { content, kind });
  const recall = (who, id, status = 200) => request(who.token, 'POST', `/api/channels/${ch}/messages/${id}/recall`, undefined, status);
  const unread = async (who) => (await request(who.token, 'GET', `/api/channels/${ch}/windows`)).find((w) => w.id === main).unread;
  const bobSocket = await chatSocket(bob.token, ch);
  try {
    const keep = await say(ann, main, 'I knock on the lighthouse door.');
    const typo = await say(ann, main, 'I look at teh brass lantern.');
    assert.ok(typo.recall_seconds_left > 0 && typo.recall_seconds_left <= 120, `a fresh line can be recalled: ${typo.recall_seconds_left}`);
    await eventually(() => bobSocket.received.some((m) => m.type === 'message.posted' && m.message.id === typo.id), 'the line reaching Bob');
    assert.equal(await unread(bob), 2);

    // Only the author: not another player, not even the GM.
    await recall(bob, typo.id, 403);
    await recall(gm, typo.id, 403);
    const done = await recall(ann, typo.id);
    assert.equal(done.content, 'I look at teh brass lantern.', 'the author gets the text back to edit and send again');
    assert.ok(done.message.recalled_at, 'tombstone');
    assert.equal(done.message.content, '');
    assert.equal(done.message.id, typo.id); assert.equal(done.message.seq, typo.seq);
    assert.equal(done.message.recall_seconds_left, null);
    const again = await recall(ann, typo.id);
    assert.equal(again.content, '', 'repeating it is a no-op');

    // Pushed live to who could read it, as the tombstone, without the text.
    const pushed = await eventually(() => bobSocket.received.find((m) => m.type === 'message.recalled' && m.message.id === typo.id), 'the recall reaching Bob');
    assert.equal(pushed.message.content, ''); assert.ok(pushed.message.recalled_at);
    assert.ok(!JSON.stringify(bobSocket.received.filter((m) => m.type === 'message.recalled')).includes('teh brass'), 'the recall push never carries the text');
    assert.equal(await unread(bob), 1, 'a recalled line is no longer unread');

    // Every reader gets the tombstone in place of the line; the text is gone from the server.
    const lines = await request(bob.token, 'GET', `/api/channels/${ch}/windows/${main}/messages`);
    const stone = lines.find((m) => m.id === typo.id);
    assert.ok(stone && stone.recalled_at && stone.content === '' && stone.dice === null, 'the tombstone keeps its place');
    assert.ok(lines.some((m) => m.id === keep.id && m.content === 'I knock on the lighthouse door.'));
    assert.ok(!JSON.stringify(lines).includes('teh brass'));
    await request(bob.token, 'GET', `/api/channels/${ch}/messages/${typo.id}`, undefined, 404);
    assert.equal((await request(gm.token, 'GET', `/api/channels/${ch}/messages?q=brass`)).length, 0, 'search no longer finds it');
    await request(bob.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: 'Quoting it.', kind: 'ooc', reference_ids: [typo.id] }, 404);

    // A recall in a window Bob is not in never reaches him.
    const secret = await say(ann, side, 'Only the GM should hear this.');
    await recall(ann, secret.id);
    await sleep(300);
    assert.ok(!bobSocket.received.some((m) => m.message?.id === secret.id), 'Bob hears nothing about a window he is not in');

    // Dice results stay on the record.
    const roll = await request(gm.token, 'POST', `/api/channels/${ch}/windows/${main}/messages`, { content: '.r 1d6', kind: 'ic' });
    assert.equal(roll.recall_seconds_left, null);
    assert.equal((await recall(gm, roll.id, 409)).error, 'not_recallable');

    // The campaign log: a copy taken before the recall goes too, and syncing again does not bring it back.
    const log = async () => { const r = await fetch(`${base}/api/channels/${ch}/studio/log/export?format=txt`, { headers: { Authorization: `Bearer ${gm.token}` } }); assert.ok(r.ok, `export ${r.status}`); return r.text(); };
    const loud = await say(ann, main, 'I shout the wrong name into the fog.');
    assert.ok((await log()).includes('the wrong name'), 'the log copied the line');
    await recall(ann, loud.id);
    const after = await log();
    assert.ok(!after.includes('the wrong name') && !after.includes('teh brass'), 'recalled lines are not in the log');
    assert.ok(after.includes('I knock on the lighthouse door.'), 'other lines stay');

    // What the AI made of a recalled line is forgotten: the GM's clue leaves the journal and does not come back.
    const clue = await say(gm, main, 'Ann, you notice a silver compass hidden under the lamp.', 'narration');
    await request(gm.token, 'POST', `/api/channels/${ch}/ai/observe-now`);
    const journal = async () => {
      const doc = (await request(gm.token, 'GET', `/api/channels/${ch}/documents`)).find((d) => d.doc_type === 'clue_journal');
      return (await request(gm.token, 'GET', `/api/channels/${ch}/documents/${doc.id}`)).entries;
    };
    assert.ok((await journal()).some((e) => /compass/i.test(e.summary)), 'the observer recorded the clue');
    await recall(gm, clue.id);
    assert.ok(!(await journal()).some((e) => /compass/i.test(e.summary)), 'the clue resting only on the recalled line is retracted');
    await request(gm.token, 'POST', `/api/channels/${ch}/ai/observe-now`);
    assert.ok(!(await journal()).some((e) => /compass/i.test(e.summary)), 'observing again does not bring it back');
  } finally { bobSocket.ws.close(); }
});
