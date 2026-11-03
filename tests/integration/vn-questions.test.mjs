import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const base = process.env.API_BASE || 'http://127.0.0.1:18081';
async function call(token, method, path, body) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await r.json();
  if (!r.ok) throw Object.assign(Error(JSON.stringify(value)), { status: r.status });
  return value;
}
async function until(fn) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); }
  throw Error('visual novel fixture timed out');
}

// The script editor may ask the players or the Keeper about a part instead of guessing. The job then waits while the
// other parts go on; the user's answers resume the part with the model's own turn replayed, sealed reasoning included
// only when the provider can still verify it.
test('VN questions: a part asks, the job waits, the answers resume the part with its replayed turn', async (t) => {
  let requests = [], askParts = new Set(), rejectReplay = false;
  const fixture = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (!body.instructions?.includes('visual-novel script')) { res.statusCode = 400; return res.end('{}'); }
    const users = body.input.filter(x => x.role === 'user' && typeof x.content === 'string').map(x => x.content);
    const part = Number(/Part (\d+)/.exec(users.join('\n'))[1]);
    const replayed = body.input.filter(x => x.role !== 'user' && x.role !== 'system');   // the model's own turn, item by item
    const resumed = users.some(u => u.includes('# Answers to your questions about this part'));
    requests.push({ part, body, users, replayed, resumed });
    const reply = (text, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      if (status !== 200) return res.end(JSON.stringify({ error: { message: 'reasoning item rejected' } }));
      res.end(JSON.stringify({ status: 'completed', output: [
        { type: 'reasoning', id: `rs_${part}_${requests.length}`, summary: [], encrypted_content: `enc-${part}-${requests.length}` },
        { type: 'message', id: `msg_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] }));
    };
    if (rejectReplay && replayed.some(x => x.type === 'reasoning')) return reply('', 400);
    const refs = [...users.join('\n').matchAll(/\[(L\d+)\]/g)].map(m => m[1]);
    const script = { script: refs.slice(1).map(ref => ({ ref, background: 'Harbour' })), exclude: [{ ref: refs[0], reason: resumed ? 'bot banner (confirmed)' : 'bot banner' }],
      generate_backgrounds: [{ name: 'Harbour', prompt: 'Foggy harbour' }], generate_portraits: [] };
    if (askParts.has(part) && !resumed) {
      script.questions = [{ id: 'q1', question: `Is ${refs[0]} a bot banner?`, refs: [refs[0]], options: ['yes', 'no'] }, { id: 'q2', question: 'Is this one session?', refs: [] },
        { question: '' }, 'junk'];
    }
    reply(JSON.stringify(script));
  });
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const suffix = Math.random().toString(36).slice(2);
  const gm = (await call('', 'POST', '/api/auth/register', { username: 'vnqgm' + suffix, password: 'password' })).token;
  const pl = (await call('', 'POST', '/api/auth/register', { username: 'vnqpl' + suffix, password: 'password' })).token;
  const srv = await call(gm, 'POST', '/api/servers', { name: 'VN questions fixture' });
  const ch = (await call(gm, 'POST', `/api/servers/${srv.id}/channels`, { name: 'Script questions' })).id;
  await call(gm, 'POST', `/api/channels/${ch}/members`, { username: 'vnqpl' + suffix, role: 'player' });
  const root = `/api/channels/${ch}/studio`, path = root + '/vn-scripts';
  const settings = `/api/servers/${srv.id}/settings`;
  const setModel = model => call(gm, 'PUT', settings, { llm: { provider: 'openai_compatible', api_base: `http://127.0.0.1:${fixture.address().port}/v1`, api_key: 'fixture', model } });
  t.after(async () => { await call(gm, 'PUT', settings, { llm: { provider: 'mock' } }).catch(() => {}); });
  await call(gm, 'PUT', root + '/settings', { studio_cloud_allowed: true });
  const window = (await call(gm, 'GET', `/api/channels/${ch}/windows`))[0].id;
  for (let i = 0; i < 21; i++) await call(gm, 'POST', `/api/channels/${ch}/windows/${window}/messages`, { content: `Scene ${i}: ` + 'fog '.repeat(400), kind: 'narration' });
  await setModel('fixture-vn');
  const create = () => call(gm, 'POST', path, { allow_cloud: true, generate_art: false });
  const settled = id => until(async () => { const j = await call(gm, 'GET', path + '/' + id); return ['failed', 'completed', 'cancelled', 'waiting'].includes(j.status) && j; });
  const answer = (id, body, token = gm) => call(token, 'POST', path + '/' + id + '/answers', body);

  // The first part asks: the job waits with the questions while parts 2 and 3 are already done.
  askParts = new Set([1]);
  const a = await create(), aw = await settled(a.id);
  assert.equal(aw.status, 'waiting', aw.error);
  assert.deepEqual(requests.map(x => x.part), [1, 2, 3]);
  assert.equal(aw.progress.chunks_done, 2); assert.equal(aw.progress.questions_open, 1); assert.equal(aw.progress.chunks_total, 3);
  assert.equal(aw.questions.length, 1);
  const q = aw.questions[0];
  assert.equal(q.part_index, 0); assert.equal(q.first_line, 1); assert.equal(q.answered, false);
  assert.deepEqual(q.items.map(x => x.id), ['q1', 'q2']);   // the empty and malformed questions were dropped
  assert.deepEqual(q.items[0].options, ['yes', 'no']); assert.deepEqual(q.items[0].refs, ['L1']);
  assert.equal(aw.script, null);
  // Bad answers: a part that asked nothing, no answer at all, a player who may not see the job.
  await assert.rejects(answer(a.id, { part_index: 1, answers: { q1: 'yes' } }), e => e.status === 404);
  await assert.rejects(answer(a.id, { part_index: 0, answers: { q9: 'yes' } }), e => e.status === 400);
  await assert.rejects(answer(a.id, { answers: { q1: 'yes' } }), e => e.status === 400);
  await assert.rejects(answer(a.id, { part_index: 0, answers: { q1: 'yes' } }, pl), e => e.status === 404);
  await assert.rejects(call(gm, 'POST', path + '/' + a.id + '/retry', {}), e => e.status === 400);
  requests = [];
  const answered = await answer(a.id, { part_index: 0, answers: { q1: ' yes, the bot posts it ', q2: 42 } });
  assert.ok(['pending', 'running'].includes(answered.status), answered.status); assert.equal(answered.questions[0].answered, true); assert.deepEqual(answered.questions[0].answers, { q1: 'yes, the bot posts it' });
  await assert.rejects(answer(a.id, { part_index: 0, answers: { q1: 'again' } }), e => e.status === 400);
  const ad = await settled(a.id);
  assert.equal(ad.status, 'completed', ad.error);
  // Only part 1 ran again: the shared turn, its own lines, the model's turn as returned, then the answers.
  assert.deepEqual(requests.map(x => x.part), [1]);
  const r = requests[0];
  assert.ok(r.resumed);
  assert.deepEqual(r.replayed.map(x => x.type), ['reasoning', 'message']);
  assert.equal(r.replayed[0].encrypted_content, 'enc-1-1'); assert.equal(r.replayed[0].id, 'rs_1_1');
  assert.equal(r.replayed[1].id, 'msg_1'); assert.ok(r.replayed[1].content[0].text.includes('"questions"'));
  assert.equal(r.users.length, 3);   // shared, the part, the answers
  assert.ok(r.users[2].startsWith('# Answers to your questions about this part\n- q1 ("Is L1 a bot banner?"): yes, the bot posts it\n- q2 ("Is this one session?"): (no answer; decide yourself)\n'));
  assert.ok(r.body.input.indexOf(r.replayed[0]) < r.body.input.length - 1 && r.body.input.at(-1).content === r.users[2]);
  assert.equal(r.body.include, undefined);   // the sealed-reasoning field goes to OpenAI's own API only
  assert.equal(ad.questions.length, 0);
  // The editor's exclusions are hidden with their reasons; every other line is shown.
  const lines = ad.script.scenes.flatMap(s => s.lines);
  assert.equal(lines.length, 21);
  const hidden = lines.filter(l => l.hidden);
  assert.equal(hidden.length, 3);
  assert.deepEqual(hidden.map(l => l.exclusion_reason), ['bot banner (confirmed)', 'bot banner', 'bot banner']);
  assert.equal(ad.script.stats.hidden, 3);
  const pres = await call(gm, 'GET', root + `/presentations/${ad.presentation_id}`);
  assert.equal(pres.events.filter(e => e.hidden).length, 3);

  // Skipping the questions keeps the draft without another call; a part can ask twice at most.
  requests = []; askParts = new Set([2]);
  const b = await create(), bw = await settled(b.id);
  assert.equal(bw.status, 'waiting'); assert.equal(bw.questions[0].part_index, 1);
  requests = [];
  await answer(b.id, { part_index: 1, skip: true });
  const bd = await settled(b.id);
  assert.equal(bd.status, 'completed', bd.error);
  assert.deepEqual(requests, []);
  assert.ok(bd.script.notes.some(n => /Part 2\/3 .*skipped; the draft was used/.test(n)), JSON.stringify(bd.script.notes));
  assert.equal(bd.script.stats.hidden, 3);

  // A provider that rejects the replayed turn (HTTP 400 on the reasoning item) gets the answers without it.
  requests = []; askParts = new Set([3]); rejectReplay = true;
  const c = await create(), cw = await settled(c.id);
  assert.equal(cw.status, 'waiting');
  requests = [];
  await answer(c.id, { part_index: 2, answers: { q1: 'no' } });
  const cd = await settled(c.id);
  assert.equal(cd.status, 'completed', cd.error);
  assert.deepEqual(requests.map(x => [x.part, x.replayed.length, x.resumed]), [[3, 2, true], [3, 0, true]]);
  assert.equal(requests[1].users.length, 2); assert.ok(requests[1].users[1].includes('Part 3 of 3')); assert.ok(requests[1].users[1].includes('- q1 ("Is L'));
  rejectReplay = false;

  // Another model cannot verify the sealed reasoning: the turn is replayed as plain text; the other parts run again.
  requests = []; askParts = new Set([1]);
  const d = await create(), dw = await settled(d.id);
  assert.equal(dw.status, 'waiting');
  await setModel('fixture-vn-2'); requests = [];
  await answer(d.id, { part_index: 0, answers: { q2: 'yes' } });
  const dd = await settled(d.id);
  assert.equal(dd.status, 'completed', dd.error);
  assert.deepEqual(requests.map(x => x.part), [1, 2, 3]);
  assert.deepEqual(requests[0].replayed.map(x => x.type), ['message']); assert.ok(requests[0].resumed);
  assert.ok(requests[0].users[2].includes('- q1 ("Is L1 a bot banner?"): (no answer; decide yourself)'));

  // Several parts may wait at once; the job runs on only when all are answered. A waiting job can be cancelled.
  await setModel('fixture-vn'); requests = []; askParts = new Set([1, 3]);
  const e = await create(), ew = await settled(e.id);
  assert.equal(ew.status, 'waiting'); assert.deepEqual(ew.questions.map(x => x.part_index), [0, 2]); assert.equal(ew.progress.questions_open, 2);
  assert.equal((await answer(e.id, { part_index: 2, skip: true })).status, 'waiting');
  await call(gm, 'POST', path + '/' + e.id + '/cancel', {});
  assert.equal((await settled(e.id)).status, 'cancelled');
  await assert.rejects(answer(e.id, { part_index: 0, skip: true }), e => e.status === 400);
  const list = await call(gm, 'GET', path);
  assert.ok(list.some(j => j.id === e.id && j.status === 'cancelled'));
});
