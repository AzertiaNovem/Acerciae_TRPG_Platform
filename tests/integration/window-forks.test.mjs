import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function request(token, method, path, body, status = 200) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await r.json(); assert.equal(r.status, status, JSON.stringify(out)); return out;
}
const delay = ms => new Promise(r => setTimeout(r, ms));
async function socket(token, ch) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/ws/chat?token=${token}`), events = [];
    const timer = setTimeout(() => { ws.close(); reject(Error('subscribe timeout')); }, 5000);
    ws.on('error', reject); ws.on('message', raw => {
      const e = JSON.parse(raw); events.push(e);
      if (e.type === 'hello') ws.send(JSON.stringify({ type: 'subscribe', channel_id: ch }));
      if (e.type === 'subscribed') { clearTimeout(timer); resolve({ ws, events }); }
    });
  });
}

test('Forks freeze recursive history without copying or widening player-group access; archive and restore', async () => {
  const suffix = Date.now().toString(36);
  const [gm, a, b, shared] = await Promise.all(['gm', 'a', 'b', 'shared'].map(n => request(null, 'POST', '/api/auth/register', { username: `fork_${n}_${suffix}`, display_name: n, password: 'test-password' })));
  const s = await request(gm.token, 'POST', '/api/servers', { name: `fork test ${suffix}` });
  const ch = await request(gm.token, 'POST', `/api/servers/${s.id}/channels`, { name: 'Forks', knowledge_mode: 'isolated', ai_enabled: false });
  const root = `/api/channels/${ch.id}`;
  const get = (who, path, status) => request(who.token, 'GET', root + path, undefined, status);
  const send = (who, path, body, status) => request(who.token, 'POST', root + path, body, status);
  const update = (who, id, body, status) => request(who.token, 'PUT', root + `/windows/${id}`, body, status);
  const chars = {};
  for (const u of [a, b, shared]) { await send(gm, '/members', { user_id: u.user.id, role: 'player' }); chars[u.user.id] = await send(u, '/characters', { name: u.user.display_name }); }
  const groups = await get(gm, '/player-groups');
  const group = groups.find(g => g.members.some(m => m.user_id === a.user.id));
  await request(gm.token, 'PUT', root + `/player-groups/${group.id}/members/${shared.user.id}`, {});
  const main = (await get(gm, '/windows')).find(w => w.kind === 'main');
  const post = (w, text, extra = {}) => send(gm, `/windows/${w.id}/messages`, { content: text, kind: 'narration', ...extra });
  const body = (name, people, extra = {}) => ({ name, members: people.map(u => ({ user_id: u.user.id, character_id: chars[u.user.id].id })), ...extra });
  const fork = (w, name, people, extra = {}) => send(gm, `/windows/${w.id}/fork`, body(name, people, extra));
  const history = (who, w, query = '') => get(who, `/windows/${w.id}/messages${query}`);
  const first = await post(main, 'COMMON_BEFORE_FORK');
  const note = await post(main, 'KEEPER_ONLY', { visibility: 'gm_only' });
  const whisper = await post(main, 'ONLY_A_WHISPER', { visibility: 'whisper', whisper_to: [chars[a.user.id].id] });
  const wa = await fork(main, 'Library', [a], { request_id: 'first-fork' });
  const wb = await fork(main, 'Garden', [b]);
  assert.equal(wa.fork_parent_id, main.id);
  const repeated = await fork(main, 'Library', [a], { request_id: 'first-fork' }); assert.equal(repeated.id, wa.id);
  await send(gm, `/windows/${main.id}/fork`, body('Changed after retry', [a], { request_id: 'first-fork' }), 409);
  await send(a, `/windows/${main.id}/fork`, body('unauthorized', [a]), 403);
  await update(a, wa.id, { archived: true }, 403);
  await send(gm, `/windows/${main.id}/fork`, body('wrong character', [a], { members: [{ user_id: a.user.id, character_id: chars[b.user.id].id }] }), 400);
  await send(gm, `/windows/${main.id}/fork`, body('future', [a], { through_seq: wa.fork_seq + 9999 }), 400);
  const commonLater = await post(main, 'PUBLIC_AFTER_FORK');
  const secretA = await post(wa, 'LIBRARY_ONLY');
  const secretB = await post(wb, 'GARDEN_ONLY');
  for (const who of [a, shared]) {
    assert.deepEqual((await history(who, wa)).map(m => m.id), [first.id, whisper.id, secretA.id]);
    await history(who, wb).then(() => assert.fail('other group read the garden'), e => { assert.match(e.message, /403|outside/); });
  }
  assert.deepEqual((await history(b, wb)).map(m => m.id), [first.id, secretB.id]);
  assert.ok((await history(gm, wa)).some(m => m.id === note.id));
  assert.ok(!(await history(gm, wa)).some(m => m.id === commonLater.id));
  assert.deepEqual((await history(gm, wa, '?include_history=false')).map(m => m.id), [secretA.id]);
  await get(b, `/messages/${secretA.id}`, 404);
  const child = await fork(wa, 'Library stacks', [a]);
  const aLater = await post(wa, 'OLD_LIBRARY_NEW_MESSAGE');
  const childOwn = await post(child, 'STACKS_ONLY');
  const pages = []; let before = 0;
  while (true) {
    const page = await history(a, child, `?limit=1${before ? `&before_seq=${before}` : ''}`);
    if (!page.length) break;
    pages.unshift(...page); before = page[0].seq;
  }
  assert.deepEqual(pages.map(m => m.id), [first.id, whisper.id, secretA.id, childOwn.id]);
  assert.equal(pages[0].chat_window_id, main.id); assert.equal(pages[2].chat_window_id, wa.id);
  const reunited = await fork(child, 'Meet at the stairs', [a, b]);
  const reunion = await post(reunited, 'TOGETHER_NOW');
  assert.deepEqual((await history(b, reunited)).map(m => m.id), [first.id, reunion.id], 'joining does not reveal A’s earlier private scenes or later lobby lines');
  assert.deepEqual((await history(a, reunited)).map(m => m.id), [first.id, whisper.id, secretA.id, childOwn.id, reunion.id]);
  const oldCut = await fork(reunited, 'Earlier branch', [a, b], { through_seq: first.seq });
  assert.deepEqual((await history(gm, oldCut)).map(m => m.id), [first.id], 'child cutoff applies to all ancestors');
  const socketB = await socket(b.token, ch.id), socketShared = await socket(shared.token, ch.id);
  try {
    const other = await post(child, 'LATER_PRIVATE_STACKS');
    await delay(250);
    assert.ok(!socketB.events.some(e => e.message?.id === other.id));
    assert.ok(socketShared.events.some(e => e.message?.id === other.id));
    assert.ok(!(await history(a, reunited)).some(m => m.id === other.id));
  } finally { socketB.ws.close(); socketShared.ws.close(); }
  await update(gm, wa.id, { archived: true });
  assert.ok((await get(a, '/windows')).find(w => w.id === wa.id).archived_at);
  assert.ok((await history(a, wa)).some(m => m.id === aLater.id));
  await send(a, `/windows/${wa.id}/messages`, { content: 'cannot post while archived' }, 409);
  await fork(wa, 'From archived history', [a]);
  await update(gm, wa.id, { archived: false, name: 'Restored library' });
  await send(a, `/windows/${wa.id}/messages`, { content: 'restored' });
  await update(gm, main.id, { archived: true }, 409);
  const visibility = (who, w, user, paused, status) => request(who.token, 'PUT', root + `/windows/${w.id}/members/${user.user.id}/visibility`, { paused }, status);
  await visibility(a, child, a, true, 403);
  await visibility(gm, main, a, true, 409);
  await visibility(gm, child, gm, true, 400);
  await send(gm, `/windows/${child.id}/members`, { user_id: shared.user.id });
  const past = await post(child, 'BEFORE_PAUSE');
  await visibility(gm, child, a, true);
  const groupVisible = await post(child, 'GROUP_MEMBER_STILL_HERE');
  assert.ok((await history(a, child)).some(m => m.id === groupVisible.id), 'same-group active member still shares the scene');
  await send(a, `/windows/${child.id}/messages`, { content: 'cannot act while absent' }, 403);
  await visibility(gm, child, shared, true);
  const pausedSocket = await socket(a.token, ch.id);
  let hidden;
  try {
    hidden = await post(child, 'HIDDEN_DURING_PAUSE');
    await visibility(gm, child, a, true); // duplicate pause must not move the cutoff
    await delay(150);
    assert.ok(!pausedSocket.events.some(e => e.message?.id === hidden.id));
    await get(a, `/messages/${hidden.id}`, 404);
    assert.ok(!(await history(a, child)).some(m => m.id === hidden.id));
    assert.ok((await history(a, child)).some(m => m.id === past.id));
    await visibility(gm, child, a, false);
    const returned = await post(child, 'VISIBLE_AFTER_RESUME');
    await visibility(gm, child, a, false); // duplicate resume must not discard this line
    await delay(150);
    assert.ok(pausedSocket.events.some(e => e.message?.id === returned.id));
    for (const who of [a, shared]) {
      const rows = await history(who, child);
      assert.ok(rows.some(m => m.id === returned.id));
      assert.ok(!rows.some(m => m.id === hidden.id), 'the pause gap remains hidden after resume');
      assert.equal((await get(who, '/messages?q=HIDDEN_DURING_PAUSE')).length, 0);
    }
    await send(a, `/windows/${child.id}/messages`, { content: 'forbidden reference', reference_ids: [hidden.id] }, 404);
    await request(gm.token, 'PUT', root, { studio_visible: true, studio_player_access: true });
    const exported = await get(a, '/studio/log/export?format=json');
    assert.ok(exported.messages.some(m => m.content === returned.content));
    assert.ok(!exported.messages.some(m => m.content === hidden.content), 'Log Studio cannot reveal the pause gap');
    const afterPauseFork = await fork(child, 'After absence', [a]);
    assert.ok(!(await history(a, afterPauseFork)).some(m => m.id === hidden.id), 'fork history also respects absence intervals');
  } finally { pausedSocket.ws.close(); }
  // A late arrival joins the existing scene from now, rather than opening the old private history.
  await send(gm, `/windows/${child.id}/members`, { user_id: b.user.id });
  const joined = await post(child, 'AFTER_B_JOINED');
  const bView = await history(b, child);
  assert.ok(bView.some(m => m.id === joined.id));
  assert.ok(!bView.some(m => [hidden.id, childOwn.id, past.id].includes(m.id)));
  const ch2 = await request(gm.token, 'POST', `/api/servers/${s.id}/channels`, { name: 'Other channel' });
  await request(gm.token, 'POST', `/api/channels/${ch2.id}/windows/${main.id}/fork`, body('wrong channel', []), 404);
  assert.equal((await get(gm, '/messages?q=LIBRARY_ONLY')).filter(m => m.id === secretA.id).length, 1, 'forks do not duplicate stored events');
});
