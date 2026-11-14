// Interactive messages (kind hypertext, docs/HYPERTEXT.md): a channel GM account posts a card through the API, its
// readers save their own state and act on it (a line as themselves, one of the sender's private replies). These suites
// drive the five routes over HTTP and WebSocket: posting and its checks, the secrecy of reply templates, the audience
// of every line a card produces, the dice policy, reply limits, replays, failures, the lifecycle, per-viewer state and
// the downstream consumers. Concurrency (racing claims, one action in flight, abandoned claims) is in db_tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const base = process.env.API_BASE || 'http://127.0.0.1:18081';
const fixture = JSON.parse(readFileSync(new URL('../../mobile/contracts/fixtures/hypertext.json', import.meta.url), 'utf8'));
const MARKER = 'PRIVATE_MARKER';

async function raw(token, method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}
async function request(token, method, path, body, status = 200) {
  const r = await raw(token, method, path, body);
  assert.equal(r.status, status, `${method} ${path}: ${r.text}`); return r.data;
}
function chatSocket(token, channelId, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/chat?token=${token}`);
    const received = []; const frames = [];
    ws.on('message', (data) => {
      const text = data.toString(); frames.push(text);
      const m = JSON.parse(text); received.push(m);
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'subscribe', channel_id: channelId, ...extra }));
      if (m.type === 'subscribed') resolve({ ws, received, frames });
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 8000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, label, timeout = 5000) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(50); }
}
let counter = 0;
const uuid = () => crypto.randomUUID();

// A table: the owner GM, a second GM account (the bot that posts cards), three players with a PC each in their own
// player group, a server member outside the channel (a spectator), and an NPC.
async function table(tag) {
  const sfx = `${tag}_${Date.now().toString(36)}${(counter++).toString(36)}`;
  const u = {};
  for (const n of ['gm', 'bot', 'ann', 'bob', 'cat', 'eve']) u[n] = await request(null, 'POST', '/api/auth/register', { username: `hx${n}_${sfx}`, display_name: n[0].toUpperCase() + n.slice(1), password: 'password' });
  const server = await request(u.gm.token, 'POST', '/api/servers', { name: 'Hypertext ' + sfx });
  for (const n of ['bot', 'ann', 'bob', 'cat', 'eve']) await request(u.gm.token, 'POST', `/api/servers/${server.id}/members`, { user_id: u[n].user.id, role: 'member' });
  const ch = (await request(u.gm.token, 'POST', `/api/servers/${server.id}/channels`, { name: 'Manor', knowledge_mode: 'isolated' })).id;
  const root = `/api/channels/${ch}`;
  await request(u.gm.token, 'POST', `${root}/members`, { user_id: u.bot.user.id, role: 'gm' });
  for (const n of ['ann', 'bob', 'cat']) await request(u.gm.token, 'POST', `${root}/members`, { user_id: u[n].user.id, role: 'player' });
  const main = (await request(u.gm.token, 'GET', `${root}/windows`)).find((w) => w.kind === 'main').id;
  const pc = {};
  for (const [n, name] of [['ann', 'Ada'], ['bob', 'Bea'], ['cat', 'Cy']]) pc[n] = (await request(u[n].token, 'POST', `${root}/characters`, { name })).id;
  const npc = (await request(u.gm.token, 'POST', `${root}/characters`, { name: 'Butler', kind: 'npc' })).id;
  const t = { ...u, server, ch, root, main, pc, npc };
  t.post = (who, body, status = 200, win = main) => request(who.token, 'POST', `${root}/windows/${win}/hypertext`, body, status);
  t.act = (who, id, body, status = 200) => request(who.token, 'POST', `${root}/messages/${id}/hypertext/act`, { interaction_id: uuid(), base_version: 0, ...body }, status);
  t.save = (who, id, body, status = 200) => request(who.token, 'PUT', `${root}/messages/${id}/hypertext/state`, body, status);
  t.status = (who, ids) => request(who.token, 'GET', `${root}/hypertext?ids=${ids.join(',')}`);
  t.close = (who, id, status = 200) => request(who.token, 'POST', `${root}/messages/${id}/hypertext/close`, undefined, status);
  t.lines = (who, win = main) => request(who.token, 'GET', `${root}/windows/${win}/messages?limit=200`);
  t.say = (who, content, extra = {}, win = main) => request(who.token, 'POST', `${root}/windows/${win}/messages`, { content, kind: 'ic', ...extra });
  return t;
}
const button = (id, label, extra = {}) => ({ type: 'button', id, label, ...extra });
const card = (body, extra = {}) => ({ hypertext: { v: 1, title: 'The study', body, ...extra.hypertext }, ...extra.top });

test('posting: GM accounts only, through their own route, checked to the path, characters, content, audience, the rate and the fallback', async () => {
  const t = await table('post');
  const simple = card([{ type: 'text', text: 'The study is dark.' }, button('roll', 'Roll', { act: { say: '.ra Spot Hidden 50' } })]);
  // Players cannot post one; the chat route never does.
  assert.equal((await t.post(t.ann, simple, 403)).error, 'forbidden');
  for (const b of [{ content: 'Pick one', kind: 'hypertext' }, { content: 'Pick one', hypertext: simple.hypertext }]) {
    const r = await raw(t.gm.token, 'POST', `${t.root}/windows/${t.main}/messages`, b);
    assert.equal(r.status, 400); assert.match(r.data.message, /POST \/windows\/\{w\}\/hypertext/);
  }
  // A document that is not format v1 is refused with the paths of its errors.
  const bad = await t.post(t.gm, { hypertext: { v: 1, body: [{ type: 'text', text: 'x', colour: 'red' }, { type: 'button', id: 'b', label: 'B' }] } }, 400);
  assert.equal(bad.error, 'invalid_hypertext');
  const paths = bad.errors.map((e) => e.path);
  assert.ok(paths.includes('hypertext.body[0].colour'), JSON.stringify(bad.errors));
  assert.ok(paths.some((p) => p.startsWith('hypertext.body[1]')), 'a button needs on or act');
  assert.ok(bad.errors.every((e) => typeof e.message === 'string' && e.message.length));
  assert.equal((await t.post(t.gm, { ...simple, colour: 'red' }, 400)).errors[0].path, 'colour');
  assert.equal((await t.post(t.gm, { hypertext: { v: 2, body: [{ type: 'divider' }] } }, 400)).errors[0].path, 'hypertext.v');
  assert.equal((await t.post(t.gm, card([{ type: 'divider' }], { hypertext: { actors: [uuid()] } }), 400)).errors[0].path, 'hypertext.actors[0]');
  // Characters: an NPC, the sender's own or nobody's PC; never another player's.
  await t.post(t.gm, { ...simple, character_id: t.pc.ann }, 403);
  await t.post(t.gm, { ...simple, replies: { r: { text: 'Hello.', character_id: t.pc.bob } } }, 403);
  assert.equal((await t.post(t.gm, { ...simple, character_id: uuid() }, 400)).errors[0].path, 'character_id');
  const asNpc = await t.post(t.gm, { ...simple, character_id: t.npc, content: 'The butler offers a card.' });
  assert.equal(asNpc.character_id, t.npc); assert.equal(asNpc.character_name, 'Butler');
  // Content: the GM's own plain text, never a dot command, at most 2000 code points.
  assert.equal((await t.post(t.gm, { ...simple, content: '.r 1d6' }, 400)).errors[0].path, 'content');
  assert.equal((await t.post(t.gm, { ...simple, content: '😀'.repeat(2001) }, 400)).errors[0].path, 'content');
  assert.equal((await t.post(t.gm, { ...simple, content: '😀'.repeat(2000) })).content, '😀'.repeat(2000));
  // The audience as for a GM's line; closes_in within 60 s .. 30 days.
  await t.post(t.gm, { ...simple, visibility: 'whisper' }, 400);
  await t.post(t.gm, { ...simple, visibility: 'everyone' }, 400);
  assert.equal((await t.post(t.gm, { ...simple, closes_in: 59 }, 400)).errors[0].path, 'closes_in');
  assert.equal((await t.post(t.gm, { ...simple, closes_in: 2592001 }, 400)).errors[0].path, 'closes_in');
  const posted = await t.post(t.bot, { ...simple, closes_in: 3600 });
  assert.equal(posted.kind, 'hypertext'); assert.equal(posted.author_id, t.bot.user.id); assert.equal(posted.author_role, 'gm');
  assert.equal(posted.content, 'The study\nThe study is dark.\n[Roll]', 'the fallback when no content is given');
  assert.equal(posted.hypertext.v, 1); assert.deepEqual(posted.hypertext.replies, []);
  const closesIn = (Date.parse(posted.hypertext.closes_at) - Date.parse(posted.created_at)) / 1000;
  assert.ok(Math.abs(closesIn - 3600) < 5, `closes_at is an hour later: ${closesIn}`);
  assert.equal(posted.recall_seconds_left > 0, true, 'a card can be recalled like a line');
  // Its event holds the plain text, the kind and the title: never the document.
  const events = await request(t.gm.token, 'GET', `${t.root}/events?q=${encodeURIComponent('The study is dark')}&limit=50`);
  const ev = events.find((e) => e.payload.message_kind === 'hypertext');
  assert.ok(ev, 'the card has a message.posted event');
  assert.equal(ev.payload.content, posted.content); assert.equal(ev.payload.hypertext_title, 'The study');
  assert.ok(!('hypertext' in ev.payload) && !JSON.stringify(ev.payload).includes('Spot Hidden 50'), 'no document in the event');
  // Search finds the fallback.
  assert.ok((await request(t.ann.token, 'GET', `${t.root}/messages?q=${encodeURIComponent('study is dark')}`)).some((m) => m.id === posted.id));

  // The fallback is the shared fixture's, byte for byte, and the stored document its public form.
  for (const c of fixture.fallback) {
    const doc = structuredClone(c.hypertext);
    if (doc.actors) doc.actors = [t.pc.ann];
    const m = await t.post(t.bot, { hypertext: doc, ...(c.replies ? { replies: c.replies } : {}) });
    assert.equal(m.content, c.text, `fallback: ${c.name}`);
  }
  const pub = fixture.validation.find((c) => c.public);
  const doc = structuredClone(pub.input.hypertext); doc.actors = [t.pc.ann.toUpperCase()];
  const stored = (await t.post(t.bot, { hypertext: doc, replies: pub.input.replies })).hypertext;
  const expected = structuredClone(pub.public); expected.actors = [t.pc.ann]; expected.closes_at = stored.closes_at;
  assert.deepEqual(stored, expected, 'messages.hypertext is the public document');
  assert.ok(!JSON.stringify(stored).includes('Behind the portrait'), 'reply text never in the document');
});

test('posting: at most 20 cards a minute per author and channel', async () => {
  const t = await table('rate');
  const c = card([{ type: 'text', text: 'Tick.' }]);
  for (let i = 0; i < 20; i++) await t.post(t.bot, c);
  const limited = await t.post(t.bot, c, 429);
  assert.equal(limited.error, 'rate_limited'); assert.ok(limited.retry_after >= 1 && limited.retry_after <= 60, `retry_after ${limited.retry_after}`);
  await t.post(t.gm, c);   // per author
});

test('secrecy: reply templates never leave the server, a GM-audience reply and a hidden-roll template reach the clicker as null', async () => {
  const t = await table('secret');
  await request(t.gm.token, 'PUT', `/api/servers/${t.server.id}/settings`, { policy: { main_chat_spectators: true } });
  const sockets = {};
  for (const n of ['gm', 'ann', 'bob', 'cat']) sockets[n] = await chatSocket(t[n].token, t.ch);
  sockets.eve = await chatSocket(t.eve.token, t.ch, { spectate: true });
  try {
    const script = "on('peek', () => { reply('gmnote') })";
    const m = await t.post(t.bot, {
      hypertext: { v: 1, title: 'The study', body: [{ type: 'text', text: 'A portrait hangs crooked.' }, button('peek', 'Peek', { on: 'peek' }), button('door', 'Door', { act: { reply: 'door' } })], script, runs_per_viewer: 5 },
      replies: {
        gmnote: { text: `${MARKER}: the butler lies`, audience: 'gm' },
        peek: { text: `.rh 1d6 ${MARKER} roll`, audience: 'card' },
        door: { text: 'The door groans open.', audience: 'card' },
      },
    });
    assert.deepEqual(m.hypertext.replies.map((r) => r.id), ['door', 'gmnote', 'peek'], 'stubs only');
    assert.equal(m.hypertext.script, script);
    const leaks = (label, value) => assert.ok(!JSON.stringify(value).includes(MARKER), `${label} leaks the template`);
    await eventually(() => sockets.ann.received.some((f) => f.type === 'message.posted' && f.message.id === m.id), 'the card reaching Ann');
    await eventually(() => sockets.eve.received.some((f) => f.type === 'spectate.message' && f.message.id === m.id), 'the card reaching the spectator');
    for (const who of [t.gm, t.ann]) {
      leaks('the window', await t.lines(who)); leaks('the message', await request(who.token, 'GET', `${t.root}/messages/${m.id}`));
      assert.deepEqual(await request(who.token, 'GET', `${t.root}/messages?q=${MARKER}`), []);
      leaks('search', await request(who.token, 'GET', `${t.root}/messages?q=portrait`));
      leaks('events', await request(who.token, 'GET', `${t.root}/events?q=&limit=200`));
      leaks('status', await t.status(who, [m.id]));
    }
    // The campaign log and its native export keep the plain text only (no document, script or templates).
    const log = await request(t.gm.token, 'GET', `${t.root}/studio/log`); leaks('the campaign log', log);
    const exported = await request(t.gm.token, 'GET', `${t.root}/studio/log/export?format=json`);
    leaks('the native export', exported); assert.ok(!JSON.stringify(exported).includes("reply('gmnote')"), 'no script in the export');
    // Spectators: the public card, never its script.
    const view = await request(t.eve.token, 'GET', `${t.root}/spectate`);
    const seen = view.messages.find((x) => x.id === m.id);
    assert.ok(seen && seen.hypertext.title === 'The study' && !('script' in seen.hypertext), 'the spectator sees the card without its script');
    leaks('the spectator view', view);
    const live = sockets.eve.received.find((f) => f.type === 'spectate.message' && f.message.id === m.id);
    assert.ok(!('script' in live.message.hypertext), 'no script on the spectator feed');

    // A GM-audience reply: posted, but the clicker's response (first time and replay) carries no line.
    const iid = uuid();
    const asked = await t.act(t.ann, m.id, { interaction_id: iid, node: 'peek', reply: { id: 'gmnote' } });
    assert.equal(asked.replayed, false); assert.equal(asked.partial, false);
    assert.equal(asked.results.length, 1); assert.equal(asked.results[0].type, 'reply'); assert.equal(asked.results[0].ok, true);
    assert.equal(asked.results[0].message, null, 'a GM-only line is not the clicker\'s to read');
    leaks('the act response', asked);
    const again = await t.act(t.ann, m.id, { interaction_id: iid, node: 'peek', reply: { id: 'gmnote' } });
    assert.equal(again.replayed, true); assert.equal(again.results[0].message, null); leaks('the replay', again);
    const gmLine = (await t.lines(t.gm)).find((x) => x.via_hypertext_id === m.id && x.content.includes(MARKER));
    assert.ok(gmLine, 'the GM reads the reply');
    assert.equal(gmLine.visibility, 'gm_only'); assert.equal(gmLine.author_id, t.bot.user.id); assert.equal(gmLine.via_user_id, t.ann.user.id);
    assert.equal(gmLine.via_user_name, 'Ann'); assert.equal(gmLine.via_effect, 1); assert.equal(gmLine.kind, 'narration');
    // A hidden-roll template: the roll goes to the GMs, the clicker gets null, the card's readers get the notice.
    const rolled = await t.act(t.ann, m.id, { reply: { id: 'peek' } });
    assert.equal(rolled.results[0].ok, true); assert.equal(rolled.results[0].message, null); leaks('the roll response', rolled);
    const roll = (await t.lines(t.gm)).find((x) => x.via_hypertext_id === m.id && x.kind === 'roll');
    assert.equal(roll.visibility, 'gm_only'); assert.equal(roll.dice.type, 'roll');
    const notice = (await t.lines(t.bob)).find((x) => x.via_hypertext_id === m.id && x.dice?.type === 'hidden_notice');
    assert.ok(notice, 'the hidden roll\'s notice reaches the card\'s readers'); assert.equal(notice.via_interaction_id, null);
    // A card-audience reply is the clicker's to read.
    const door = await t.act(t.ann, m.id, { reply: { id: 'door' } });
    assert.equal(door.results[0].message.content, 'The door groans open.'); assert.equal(door.results[0].message.author_id, t.bot.user.id);
    await sleep(300);
    for (const who of [t.ann, t.bob, t.cat]) {
      leaks('a player\'s window', await t.lines(who));
      leaks('a player\'s events', await request(who.token, 'GET', `${t.root}/events?q=&limit=200`));
      leaks('a player\'s search', await request(who.token, 'GET', `${t.root}/messages?q=butler`));
    }
    for (const n of ['ann', 'bob', 'cat', 'eve']) assert.ok(!sockets[n].frames.some((f) => f.includes(MARKER)), `${n}'s socket never carries the template`);
    leaks('the spectator view', await request(t.eve.token, 'GET', `${t.root}/spectate`));
    assert.ok(!sockets.gm.frames.slice(0, sockets.gm.frames.findIndex((f) => f.includes(gmLine.id))).some((f) => f.includes(MARKER)), 'the GM\'s socket only has the posted reply');
  } finally { for (const s of Object.values(sockets)) s.ws.close(); }
});

test('audience: a whisper card\'s lines, its hidden notice and a viewer reply stay inside it; a GM reply is GM-only', async () => {
  const t = await table('aud');
  const sockets = {};
  for (const n of ['ann', 'bob', 'cat']) sockets[n] = await chatSocket(t[n].token, t.ch);
  try {
    const m = await t.post(t.bot, {
      visibility: 'whisper', whisper_to: [t.pc.ann, t.pc.bob],
      hypertext: { v: 1, title: 'A note', body: [{ type: 'text', text: 'Only you two see this.' }, button('go', 'Go', { on: 'go' })], script: "on('go', () => say('hi'))", runs_per_viewer: 10 },
      replies: { mine: { text: 'Psst: the key is yours.', audience: 'viewer' }, keeper: { text: 'Ann asked.', audience: 'gm' } },
    });
    assert.equal(m.visibility, 'whisper');
    await t.act(t.cat, m.id, { say: { text: 'Can I?' } }, 404);   // not a reader
    const said = await t.act(t.ann, m.id, { say: { text: 'We should go now.' } });
    const line = said.results[0].message;
    assert.equal(line.visibility, 'whisper'); assert.deepEqual(line.whisper_to.sort(), [t.pc.ann, t.pc.bob].sort());
    assert.equal(line.author_id, t.ann.user.id); assert.equal(line.character_id, t.pc.ann);
    assert.ok((await t.lines(t.bob)).some((x) => x.id === line.id), 'Bob reads Ann\'s answer');
    // A hidden roll from it: the result to Ada, the notice to the card's readers only.
    const rah = await t.act(t.ann, m.id, { say: { text: '.rah Spot Hidden 50' } });
    const result = rah.results[0].message;
    assert.equal(result.kind, 'roll'); assert.deepEqual(result.whisper_to, [t.pc.ann]);
    const notice = await eventually(async () => (await t.lines(t.bob)).find((x) => x.via_hypertext_id === m.id && x.dice?.type === 'hidden_notice'), 'the notice reaching Bob');
    assert.equal(notice.visibility, 'whisper'); assert.deepEqual(notice.whisper_to.sort(), [t.pc.ann, t.pc.bob].sort());
    assert.ok(!(await t.lines(t.bob)).some((x) => x.id === result.id), 'Bob never reads the hidden result');
    // A viewer reply whispers to the clicker; a GM reply is GM-only.
    const mine = (await t.act(t.ann, m.id, { reply: { id: 'mine' } })).results[0].message;
    assert.equal(mine.visibility, 'whisper'); assert.deepEqual(mine.whisper_to, [t.pc.ann]); assert.equal(mine.author_id, t.bot.user.id);
    assert.ok(!(await t.lines(t.bob)).some((x) => x.id === mine.id), 'a viewer reply is the clicker\'s alone');
    const keeper = await t.act(t.ann, m.id, { reply: { id: 'keeper' } });
    assert.equal(keeper.results[0].message, null);
    assert.equal((await t.lines(t.gm)).find((x) => x.content === 'Ann asked.').visibility, 'gm_only');
    // Closing reaches the card's readers, not the third player.
    await t.close(t.gm, m.id);
    await eventually(() => sockets.ann.received.some((f) => f.type === 'hypertext.closed' && f.message_id === m.id), 'the close reaching Ann');
    await eventually(() => sockets.bob.received.some((f) => f.type === 'hypertext.closed' && f.message_id === m.id), 'the close reaching Bob');
    await sleep(300);
    const third = JSON.stringify(sockets.cat.received);
    for (const id of [m.id, line.id, result.id, notice.id, mine.id]) assert.ok(!third.includes(id), `Cat's socket never hears of ${id}`);
    assert.ok(!(await t.lines(t.cat)).some((x) => x.via_hypertext_id === m.id || x.id === m.id), 'Cat reads none of it');
    // Initiative: the whole window sees the order, so only a card the whole window reads may roll it.
    await request(t.gm.token, 'PUT', t.root, { rule_system: 'dnd2024' });
    const order = () => request(t.cat.token, 'GET', `${t.root}/windows/${t.main}/initiative`);
    const hushed = await t.post(t.bot, { visibility: 'whisper', whisper_to: [t.pc.ann], hypertext: { v: 1, body: [button('init', 'Initiative', { act: { say: '.ri' } })], runs_per_viewer: 5 } });
    for (const text of ['.ri', '.rih +1']) assert.equal((await t.act(t.ann, hushed.id, { say: { text } }, 403)).error, 'hypertext_command_not_allowed', text);
    assert.deepEqual((await order()).entries, [], 'a whisper card never reaches the order');
    const everyone = await t.post(t.bot, card([button('init', 'Initiative', { act: { say: '.ri' } })]));
    assert.equal((await t.act(t.ann, everyone.id, { say: { text: '.ri' } })).results[0].message.kind, 'roll');
    assert.deepEqual((await order()).entries.map((e) => e.name), ['Ada'], 'a window card does');
  } finally { for (const s of Object.values(sockets)) s.ws.close(); }
});

test('say: the clicker\'s own line with the card\'s mark; rolls run, sheet changes are confirmed, other commands refused', async () => {
  const t = await table('say');
  const m = await t.post(t.bot, card([{ type: 'text', text: 'Search the study.' }, button('roll', 'Roll', { on: 'roll' })], { hypertext: { script: "on('roll', () => say('.ra Spot Hidden 50'))", actors: [t.pc.ann], runs_per_viewer: 20 } }));
  // Only actors act (GMs always may).
  assert.equal((await t.act(t.bob, m.id, { say: { text: '.ra Spot Hidden 50' } }, 403)).error, 'not_an_actor');
  const ra = await t.act(t.ann, m.id, { node: 'roll', say: { text: '.ra Spot Hidden 50' } });
  const roll = ra.results[0].message;
  assert.equal(roll.kind, 'roll'); assert.equal(roll.author_id, t.ann.user.id); assert.equal(roll.character_id, t.pc.ann);
  assert.equal(roll.via_hypertext_id, m.id); assert.equal(roll.via_user_id, t.ann.user.id); assert.equal(roll.via_effect, 0);
  assert.equal(roll.dice.type, 'check'); assert.match(roll.content, /^\.ra Spot Hidden 50/);
  assert.equal(roll.recall_seconds_left, null, 'a roll is never recalled');
  // The dice policy: ri only without a name; st/en/ss/init refused; sc/ds need the viewer's confirmation.
  for (const text of ['.st str60', '.ri Bob', '.en Spot Hidden', '.init clr', '.ss 1']) {
    assert.equal((await t.act(t.ann, m.id, { say: { text } }, 403)).error, 'hypertext_command_not_allowed', text);
  }
  await t.say(t.ann, '.st SAN60');
  const iid = uuid();
  const ask = await t.act(t.ann, m.id, { interaction_id: iid, say: { text: '.sc 1/1d6' } }, 428);
  assert.equal(ask.error, 'confirmation_required'); assert.equal(ask.text, '.sc 1/1d6');
  const sc = await t.act(t.ann, m.id, { interaction_id: iid, say: { text: '.sc 1/1d6', confirmed: true } });
  assert.equal(sc.results[0].message.dice.type, 'sanity');
  // The composer's character: one of the clicker's own.
  const ada2 = (await request(t.ann.token, 'POST', `${t.root}/characters`, { name: 'Ada Two' })).id;
  assert.equal((await t.act(t.ann, m.id, { say: { text: 'I speak as my other self.', character_id: ada2 } })).results[0].message.character_id, ada2);
  await t.act(t.ann, m.id, { say: { text: 'Not mine.', character_id: t.pc.bob } }, 403);
  // A plain line, in or out of character; the GM may act too.
  assert.equal((await t.act(t.ann, m.id, { say: { text: 'Back in a minute.', kind: 'ooc' } })).results[0].message.kind, 'ooc');
  assert.equal((await t.act(t.gm, m.id, { say: { text: 'Take your time.', kind: 'ooc' } })).results[0].message.author_id, t.gm.user.id);
  // Dice turned off on the server: a dot command would post as the plain text it is, so it is confirmed first (no sheet
  // change then); a line that is no command is unchanged.
  await request(t.gm.token, 'PUT', `/api/servers/${t.server.id}/settings`, { features: { dice: false } });
  for (const text of ['.ra I betray Bob', '.sc 1/1d6', '.r 1d6']) {
    const off = await t.act(t.ann, m.id, { say: { text } }, 428);
    assert.deepEqual([off.error, off.text, off.sheet], ['confirmation_required', text, false], text);
  }
  const offId = uuid();
  await t.act(t.ann, m.id, { interaction_id: offId, say: { text: '.ra I betray Bob' } }, 428);
  const plain = (await t.act(t.ann, m.id, { interaction_id: offId, say: { text: '.ra I betray Bob', confirmed: true } })).results[0].message;
  assert.deepEqual([plain.kind, plain.dice, plain.content], ['ic', null, '.ra I betray Bob']);
  assert.equal((await t.act(t.ann, m.id, { say: { text: 'Just words.' } })).results[0].message.kind, 'ic');
  await request(t.gm.token, 'PUT', `/api/servers/${t.server.id}/settings`, { features: { dice: true } });
  assert.equal((await t.act(t.ann, m.id, { say: { text: '.sc 1/1d6' } }, 428)).sheet, true, 'with dice on, sc changes the sheet');
  // The shape of a say.
  for (const say of [{ text: 'x'.repeat(501) }, { text: 'Hi', kind: 'narration' }, { text: 'a\nb\nc\nd\ne\nf' }, { text: '   ' }, { text: 'Hi‮' }, { text: 'Hi', colour: 'red' }]) {
    assert.equal((await t.act(t.ann, m.id, { say }, 400)).error, 'invalid_effect', JSON.stringify(say));
  }
  assert.equal((await t.act(t.ann, m.id, {}, 400)).error, 'invalid_effect', 'an action posts something');
  assert.equal((await t.act(t.ann, m.id, { say: { text: 'Hi' }, colour: 'red' }, 400)).error, 'invalid_effect');
  assert.equal((await t.act(t.ann, m.id, { say: { text: 'Hi' }, interaction_id: 'nope' }, 400)).error, 'invalid_effect');
  // via_* in a chat body are never read.
  const forged = await t.say(t.ann, 'Not from a card.', { via_hypertext_id: m.id, via_user_id: t.bob.user.id, via_effect: 1 });
  assert.equal(forged.via_hypertext_id, null); assert.equal(forged.via_user_id, null);
});

test('reply: the sender\'s own templates, filled with declared values, within their limits; a demoted or suspended sender stops speaking', async () => {
  const t = await table('reply');
  const m = await t.post(t.bot, {
    hypertext: { v: 1, title: 'Auction', body: [{ type: 'text', text: 'Bid, or try the portrait.' }, button('go', 'Go', { on: 'go' })], script: "on('go', () => reply('door'))", runs_per_viewer: 30 },
    replies: {
      door: { text: 'The door groans open.', total: 1 },
      clue: { text: 'Behind the portrait: a key stamped {{mark}}.', audience: 'viewer', group: 'portrait', slots: { mark: { type: 'enum', values: ['13', '31'] } } },
      trap: { text: 'A dart flies from the frame.', group: 'portrait' },
      bid: { text: '{{amount}} guineas, says the auctioneer.', kind: 'ic', character_id: t.npc, per_viewer: 3, slots: { amount: { type: 'int', min: 10, max: 500 } } },
    },
  });
  // The client names the reply and fills its slots; nothing else.
  assert.equal((await t.act(t.ann, m.id, { reply: { id: 'door', text: 'I own this house now.' } }, 400)).error, 'invalid_effect');
  for (const reply of [{ id: 'nope' }, { id: 'bid', slots: { amount: 9 } }, { id: 'bid', slots: { amount: 501 } }, { id: 'bid', slots: { amount: 12.5 } }, { id: 'bid', slots: { amount: '12' } },
                       { id: 'bid' }, { id: 'bid', slots: { amount: 12, extra: 1 } }, { id: 'clue', slots: { mark: '99' } }, { id: 'clue', slots: { mark: '.r 1d6' } }]) {
    assert.equal((await t.act(t.ann, m.id, { reply }, 400)).error, 'invalid_slot', JSON.stringify(reply));
  }
  const bid = (await t.act(t.ann, m.id, { reply: { id: 'bid', slots: { amount: 120 } } })).results[0].message;
  assert.equal(bid.content, '120 guineas, says the auctioneer.'); assert.equal(bid.kind, 'ic');
  assert.equal(bid.author_id, t.bot.user.id); assert.equal(bid.character_id, t.npc); assert.equal(bid.via_user_id, t.ann.user.id); assert.equal(bid.via_user_name, 'Ann');
  assert.equal((await t.act(t.ann, m.id, { reply: { id: 'bid', slots: { amount: 130.0 } } })).results[0].message.content, '130 guineas, says the auctioneer.');
  await t.act(t.ann, m.id, { reply: { id: 'bid', slots: { amount: 140 } } });
  assert.equal((await t.act(t.ann, m.id, { reply: { id: 'bid', slots: { amount: 150 } } }, 409)).error, 'reply_exhausted', 'per_viewer');
  // total: one for the whole table.
  await t.act(t.ann, m.id, { reply: { id: 'door' } });
  assert.equal((await t.act(t.bob, m.id, { reply: { id: 'door' } }, 409)).error, 'reply_exhausted', 'total');
  // group: one answer of the group per viewer; another viewer still chooses.
  const clue = (await t.act(t.ann, m.id, { reply: { id: 'clue', slots: { mark: '31' } } })).results[0].message;
  assert.equal(clue.content, 'Behind the portrait: a key stamped 31.'); assert.deepEqual(clue.whisper_to, [t.pc.ann]);
  assert.equal((await t.act(t.ann, m.id, { reply: { id: 'trap' } }, 409)).error, 'reply_exhausted', 'group');
  await t.act(t.bob, m.id, { reply: { id: 'trap' } });
  // The sender demoted, or suspended: the card stops speaking (409, never a 403 for the clicker).
  await request(t.gm.token, 'POST', `${t.root}/members`, { user_id: t.bot.user.id, role: 'player' });
  assert.equal((await t.act(t.cat, m.id, { reply: { id: 'bid', slots: { amount: 200 } } }, 409)).error, 'sender_unavailable');
  assert.equal((await t.act(t.cat, m.id, { say: { text: 'Hello?' } })).results[0].ok, true, 'the clicker may still speak');
  await request(t.gm.token, 'POST', `${t.root}/members`, { user_id: t.bot.user.id, role: 'gm' });
  const admin = (await request(null, 'POST', '/api/auth/login', { username: 'platform_admin', password: 'password' })).token;
  await request(admin, 'PUT', `/api/admin/users/${t.bot.user.id}/suspension`, { suspended: true, reason: 'Testing a silent card' });
  try {
    assert.equal((await t.act(t.cat, m.id, { reply: { id: 'bid', slots: { amount: 200 } } }, 409)).error, 'sender_unavailable');
  } finally { await request(admin, 'PUT', `/api/admin/users/${t.bot.user.id}/suspension`, { suspended: false }); }
  assert.equal((await t.act(t.cat, m.id, { reply: { id: 'bid', slots: { amount: 200 } } })).results[0].ok, true, 'back to speaking');
});

test('idempotency: the same interaction replays its result, a different action under its id is refused, nothing posts twice', async () => {
  const t = await table('idem');
  const m = await t.post(t.bot, { hypertext: { v: 1, body: [button('go', 'Go', { act: { say: 'Onward.', reply: 'nod' } })], runs_per_viewer: 5 }, replies: { nod: { text: 'The butler nods.' } } });
  const iid = uuid();
  const first = await t.act(t.ann, m.id, { interaction_id: iid, node: 'go', say: { text: 'Onward.' }, reply: { id: 'nod' } });
  assert.equal(first.interaction_id, iid); assert.equal(first.replayed, false); assert.equal(first.partial, false);
  assert.deepEqual(first.results.map((r) => [r.type, r.ok]), [['say', true], ['reply', true]]);
  const again = await t.act(t.ann, m.id, { interaction_id: iid, node: 'go', say: { text: 'Onward.' }, reply: { id: 'nod' } });
  assert.equal(again.replayed, true);
  assert.deepEqual(again.results.map((r) => r.message.id), first.results.map((r) => r.message.id));
  assert.equal((await t.lines(t.gm)).filter((x) => x.via_interaction_id === iid).length, 2, 'one line per effect');
  assert.equal((await t.status(t.ann, [m.id])).items[0].runs_left, 4, 'a replay is no new run');
  for (const body of [{ say: { text: 'Backward.' }, reply: { id: 'nod' } }, { say: { text: 'Onward.' } }, { say: { text: 'Onward.' }, reply: { id: 'nod' }, base_version: 3 }]) {
    assert.equal((await t.act(t.ann, m.id, { interaction_id: iid, ...body }, 409)).error, 'interaction_mismatch', JSON.stringify(body));
  }
  // The same id from another viewer is another action.
  assert.equal((await t.act(t.bob, m.id, { interaction_id: iid, say: { text: 'Onward.' }, reply: { id: 'nod' } })).replayed, false);
});

test('failures: a failing first effect posts nothing and saves nothing but still counts for the rate; a failing second effect is partial', async () => {
  const t = await table('fail');
  // Dan plays without a character: his hidden roll has nobody to reach.
  const dan = await request(null, 'POST', '/api/auth/register', { username: `hxdan_${Date.now().toString(36)}`, display_name: 'Dan', password: 'password' });
  await request(t.gm.token, 'POST', `/api/servers/${t.server.id}/members`, { user_id: dan.user.id, role: 'member' });
  await request(t.gm.token, 'POST', `${t.root}/members`, { user_id: dan.user.id, role: 'player' });
  const m = await t.post(t.bot, {
    hypertext: { v: 1, state: { done: { type: 'bool' } }, body: [button('go', 'Go', { act: { say: 'I try the door.', reply: 'boom', set: { done: true } } })], runs_per_viewer: 3 },
    // A roll that parses but cannot be totalled (it overflows): the reply fails only when it is posted.
    replies: { boom: { text: '.r 1000*1000*1000*(1d1000+1d1000+1d1000-2) the floor gives way' } },
  });
  const iid = uuid();
  const failed = await t.act(dan, m.id, { interaction_id: iid, say: { text: '.rh 1d6' }, state: { done: true } }, 400);
  assert.equal(failed.error, 'dice_error');
  assert.equal((await t.act(dan, m.id, { interaction_id: iid, say: { text: '.rh 1d6' }, state: { done: true } }, 400)).error, 'dice_error', 'a replay of a failure fails the same way');
  const st = (await t.status(dan, [m.id])).items[0];
  assert.equal(st.state, null); assert.equal(st.version, 0); assert.equal(st.runs_left, 3, 'a failed action uses no run');
  assert.ok(!(await t.lines(t.gm)).some((x) => x.via_user_id === dan.user.id), 'nothing posted');
  for (let i = 1; i < 10; i++) await t.act(dan, m.id, { say: { text: '.rh 1d6' } }, 400);
  const limited = await t.act(dan, m.id, { say: { text: 'Hello.' } }, 429);
  assert.equal(limited.error, 'rate_limited'); assert.ok(limited.retry_after >= 1 && limited.retry_after <= 60);
  // The say posts, the reply's roll fails: partial, the run and the state kept, the reply free to try again.
  const partial = await t.act(t.ann, m.id, { node: 'go', say: { text: 'I try the door.' }, reply: { id: 'boom' }, state: { done: true } });
  assert.equal(partial.partial, true);
  assert.equal(partial.results[0].ok, true); assert.equal(partial.results[0].message.content, 'I try the door.');
  assert.equal(partial.results[1].ok, false); assert.equal(partial.results[1].message, null); assert.equal(partial.results[1].error.error, 'dice_error');
  assert.deepEqual(partial.state, { state: { done: true }, version: 1 });
  const after = (await t.status(t.ann, [m.id])).items[0];
  assert.equal(after.runs_left, 2); assert.equal(after.version, 1);
});

test('lifecycle: runs, archived and paused windows, unreadable, closed (with its push), recalled cards, pins', async () => {
  const t = await table('life');
  const den = (await request(t.gm.token, 'POST', `${t.root}/windows`, { name: 'Den', kind: 'group', members: [{ user_id: t.ann.user.id }, { user_id: t.bob.user.id }, { user_id: t.bot.user.id }] })).id;
  const sockets = { ann: await chatSocket(t.ann.token, t.ch), cat: await chatSocket(t.cat.token, t.ch) };
  try {
    const once = card([{ type: 'checkbox', id: 'ok', label: 'Ready', bind: 'done' }, button('go', 'Go', { act: { say: 'Ready.' } })], { hypertext: { state: { done: { type: 'bool' } } } });
    const m = await t.post(t.bot, once, 200, den);
    await t.act(t.ann, m.id, { say: { text: 'Ready.' } });
    assert.equal((await t.act(t.ann, m.id, { say: { text: 'Ready again.' } }, 409)).error, 'runs_exhausted');
    assert.equal((await t.status(t.ann, [m.id])).items[0].runs_left, 0);
    // Cat is not in the den: the card is not hers to read.
    await t.act(t.cat, m.id, { say: { text: 'Hello?' } }, 404);
    await t.save(t.cat, m.id, { state: { done: true }, base_version: 0 }, 404);
    assert.deepEqual((await t.status(t.cat, [m.id])).items, []);
    // Archived: read-only.
    await request(t.gm.token, 'PUT', `${t.root}/windows/${den}`, { archived: true });
    await t.act(t.bob, m.id, { say: { text: 'Hello?' } }, 409);
    await t.save(t.bob, m.id, { state: { done: true }, base_version: 0 }, 409);
    await request(t.gm.token, 'PUT', `${t.root}/windows/${den}`, { archived: false });
    // Paused: the paused player may not act.
    await request(t.gm.token, 'PUT', `${t.root}/windows/${den}/members/${t.bob.user.id}/visibility`, { paused: true });
    await t.act(t.bob, m.id, { say: { text: 'Hello?' } }, 403);
    await t.save(t.bob, m.id, { state: { done: true }, base_version: 0 }, 403);
    await request(t.gm.token, 'PUT', `${t.root}/windows/${den}/members/${t.bob.user.id}/visibility`, { paused: false });
    // A GM-only card is no player's to use.
    const secret = await t.post(t.bot, { ...once, visibility: 'gm_only' });
    await t.act(t.ann, secret.id, { say: { text: 'Hello?' } }, 404);
    // Closed: by any channel GM, once; its readers hear it, nobody else; then nothing more is accepted.
    const open = await t.post(t.bot, card([button('go', 'Go', { act: { say: 'Go.' } })], { hypertext: { runs_per_viewer: 5 } }));
    const before = uuid();
    const went = await t.act(t.ann, open.id, { interaction_id: before, say: { text: 'Go.' } });
    await t.close(t.ann, open.id, 403);
    const closed = await t.close(t.gm, open.id);
    assert.ok(closed.closed_at); assert.equal(closed.closed_by, t.gm.user.id); assert.equal(closed.closed, true);
    assert.equal((await t.close(t.bot, open.id)).closed_at, closed.closed_at, 'closing again changes nothing');
    await eventually(() => sockets.ann.received.some((f) => f.type === 'hypertext.closed' && f.message_id === open.id && f.closed_at === closed.closed_at), 'the close reaching Ann');
    await sleep(200);
    assert.equal(sockets.ann.received.filter((f) => f.type === 'hypertext.closed' && f.message_id === open.id).length, 1, 'one push');
    assert.equal((await t.act(t.ann, open.id, { say: { text: 'Go.' } }, 409)).error, 'hypertext_closed');
    // An action finished before the close still replays (its response may have been lost while a bot closed the card).
    const late = await t.act(t.ann, open.id, { interaction_id: before, say: { text: 'Go.' } });
    assert.equal(late.replayed, true); assert.equal(late.results[0].message.id, went.results[0].message.id);
    assert.equal((await t.save(t.ann, open.id, { state: {}, base_version: 0 }, 409)).error, 'hypertext_closed');
    const st = (await t.status(t.ann, [open.id])).items[0];
    assert.equal(st.closed, true); assert.equal(st.closed_at, closed.closed_at);
    assert.ok(!sockets.cat.received.some((f) => f.type === 'hypertext.closed' && f.message_id === m.id), 'not to a non-reader');
    // Recalled: a tombstone with no document; its states go, nothing more is accepted, and no draft comes back.
    const fresh = await t.post(t.bot, once, 200, den);
    await t.save(t.ann, fresh.id, { state: { done: true }, base_version: 0 });
    const recalled = await request(t.bot.token, 'POST', `${t.root}/messages/${fresh.id}/recall`);
    assert.equal(recalled.content, ''); assert.equal(recalled.message.hypertext, null); assert.equal(recalled.message.content, ''); assert.ok(recalled.message.recalled_at);
    const stone = (await t.lines(t.ann, den)).find((x) => x.id === fresh.id);
    assert.ok(stone.recalled_at && stone.hypertext === null, 'readers keep a tombstone');
    await t.act(t.ann, fresh.id, { say: { text: 'Ready.' } }, 404);
    await t.save(t.ann, fresh.id, { state: { done: false }, base_version: 1 }, 404);
    assert.deepEqual((await t.status(t.ann, [fresh.id])).items, [], 'its state is gone');
    await t.close(t.gm, fresh.id, 404);
    // Pins: a card is not a line to pin.
    await request(t.ann.token, 'POST', `${t.root}/messages/${m.id}/pin`, undefined, 409);
  } finally { for (const s of Object.values(sockets)) s.ws.close(); }
});

test('state: per viewer and private, checked against the card, compare-and-swap, pushed only to its owner', async () => {
  const t = await table('state');
  const m = await t.post(t.bot, {
    hypertext: { v: 1, state: { done: { type: 'bool' }, hp: { type: 'int', min: 0, max: 12 }, mood: { type: 'enum', values: [{ value: 'calm' }, { value: 'tense' }] } },
      body: [{ type: 'checkbox', id: 'ok', label: 'Ready', bind: 'done' }, button('go', 'Go', { act: { say: 'Ready.', set: { done: true } } })], runs_per_viewer: 3 },
  });
  const ann2 = await chatSocket(t.ann.token, t.ch);
  const others = { gm: await chatSocket(t.gm.token, t.ch), bob: await chatSocket(t.bob.token, t.ch) };
  try {
    for (const [state, key] of [[{ colour: 'red' }, 'colour'], [{ done: 1 }, 'done'], [{ hp: 13 }, 'hp'], [{ mood: 'angry' }, 'mood']]) {
      const r = await t.save(t.ann, m.id, { state, base_version: 0 }, 400);
      assert.equal(r.error, 'invalid_state'); assert.equal(r.key, key);
    }
    assert.equal((await t.save(t.ann, m.id, { state: { done: true }, base_version: -1 }, 400)).error, 'invalid_state');
    assert.equal((await t.save(t.ann, m.id, { state: { done: true }, base_version: 0, extra: 1 }, 400)).error, 'invalid_state');
    const v1 = await t.save(t.ann, m.id, { state: { done: true }, base_version: 0 });
    assert.deepEqual(v1, { message_id: m.id, state: { done: true, hp: 0, mood: null }, version: 1 });
    const conflict = await t.save(t.ann, m.id, { state: { done: false }, base_version: 0 }, 409);
    assert.equal(conflict.error, 'state_conflict'); assert.deepEqual(conflict.state, v1.state); assert.equal(conflict.version, 1);
    assert.equal((await t.save(t.ann, m.id, { state: { done: false, hp: 3 }, base_version: 1 })).version, 2);
    await eventually(() => ann2.received.some((f) => f.type === 'hypertext.state' && f.message_id === m.id && f.version === 2 && f.state.hp === 3), 'the state reaching Ann\'s other device');
    // Only the owner reads it.
    const bobs = (await t.status(t.bob, [m.id])).items[0];
    assert.equal(bobs.state, null); assert.equal(bobs.version, 0);
    assert.equal((await t.status(t.gm, [m.id])).items[0].state, null, 'not even the GM');
    const anns = (await t.status(t.ann, [m.id])).items[0];
    assert.deepEqual(anns.state, { done: false, hp: 3, mood: null }); assert.equal(anns.version, 2);
    // An action carries its state with the version it started from.
    assert.equal((await t.act(t.ann, m.id, { say: { text: 'Ready.' }, state: { done: true }, base_version: 1 }, 409)).error, 'state_conflict');
    const acted = await t.act(t.ann, m.id, { say: { text: 'Ready.' }, state: { done: true, hp: 3 }, base_version: 2 });
    assert.deepEqual(acted.state, { state: { done: true, hp: 3, mood: null }, version: 3 });
    await eventually(() => ann2.received.some((f) => f.type === 'hypertext.state' && f.version === 3), 'the action\'s state reaching Ann\'s other device');
    // Bob's state is his own, from version 0.
    assert.equal((await t.save(t.bob, m.id, { state: { mood: 'tense' }, base_version: 0 })).version, 1);
    await sleep(300);
    for (const [n, s] of Object.entries(others)) {
      const pushes = s.received.filter((f) => f.type === 'hypertext.state');
      assert.ok(n === 'bob' ? pushes.every((f) => f.state.mood === 'tense') && pushes.length === 1 : pushes.length === 0, `${n} hears only their own state`);
    }
    // The status route: at most 100 ids, real ids only.
    await request(t.ann.token, 'GET', `${t.root}/hypertext?ids=${Array.from({ length: 101 }, uuid).join(',')}`, undefined, 400);
    await request(t.ann.token, 'GET', `${t.root}/hypertext?ids=nope`, undefined, 400);
    const empty = await request(t.ann.token, 'GET', `${t.root}/hypertext`);
    assert.deepEqual(empty, { enabled: true, items: [] });
    await request(t.eve.token, 'GET', `${t.root}/hypertext?ids=${m.id}`, undefined, 403);
  } finally { ann2.ws.close(); for (const s of Object.values(others)) s.ws.close(); }
});

test('downstream: reminder bubbles never quote a card\'s fallback; the narration beside it still is', async () => {
  const t = await table('remind');
  const kit = await t.post(t.bot, card([{ type: 'checkbox', id: 'lantern', label: 'Pack the Wexford lantern', bind: 'lantern' }], { hypertext: { title: 'Before you go', state: { lantern: { type: 'bool' } } } }));
  const told = await t.say(t.gm, 'The innkeeper mentions the Wexford lantern hanging by the cellar door.', { kind: 'narration' });
  for (let i = 0; i < 9; i++) await t.say(t.gm, `The rain keeps falling on the roof (${i}).`, { kind: 'narration' });
  await request(t.gm.token, 'POST', `${t.root}/ai/observe-now`);
  await t.say(t.ann, 'Did anyone bring the Wexford lantern down here?');
  await request(t.gm.token, 'POST', `${t.root}/ai/observe-now`);
  const bubbles = await request(t.ann.token, 'GET', `${t.root}/reminders`);
  const cited = bubbles.flatMap((r) => r.citations.map((c) => c.message_id));
  assert.ok(cited.includes(told.id), `the narration is quoted: ${JSON.stringify(bubbles.map((r) => r.title))}`);
  assert.ok(!cited.includes(kit.id), 'the card is not');
  assert.ok(bubbles.every((r) => !r.title.includes('☐')), 'no bubble quotes a fallback line');
});

test('downstream: the campaign log keeps a card as a system line (a GM-only card stays secret), marks its lines, and the script ignores cards', async () => {
  const t = await table('down');
  const open = await t.post(t.bot, card([{ type: 'text', text: 'Choose a door.' }, button('go', 'Go', { act: { say: 'The left door.' } })], { hypertext: { title: 'Doors' } }));
  const secret = await t.post(t.bot, { ...card([{ type: 'text', text: 'Keeper only.' }]), visibility: 'gm_only' });
  const said = (await t.act(t.ann, open.id, { say: { text: 'The left door.' } })).results[0].message;
  const exported = await request(t.gm.token, 'GET', `${t.root}/studio/log/export?format=json`);
  const byText = (s) => exported.messages.find((x) => x.content.includes(s));
  assert.equal(byText('Choose a door.').type, 'system'); assert.equal(byText('Choose a door.').hypertext, true);
  assert.equal(byText('Keeper only.').type, 'secret', 'a GM-only card stays secret'); assert.equal(byText('Keeper only.').hypertext, true);
  assert.equal(byText('The left door.').via_hypertext, true); assert.notEqual(byText('The left door.').type, 'system');
  assert.ok(said.id && secret.id);

  // The script's mock reviewer reads the GM's narration, never a card's fallback.
  const PAGES = [
    "THE LANTERN SOCIETY\nChapter 1: The Sheriff's Office\nThe investigators meet Sheriff Dunmore, who holds the only key to the lighthouse. He stalls them politely.\nNPC: Sheriff Dunmore\nA tired lawman.",
    "Chapter 2: The Lighthouse\nLocation: The Lighthouse\nA ruined tower on the cliffs north of town.",
    "Ending: Dawn\nIf the investigators escape, the Society scatters.",
  ];
  assert.equal((await request(t.gm.token, 'POST', `${t.root}/modules/text`, { title: 'The Lantern Society', pages: PAGES })).status, 'ready');
  await t.post(t.bot, { content: "You step into the Sheriff's Office. Sheriff Dunmore looks up from his desk and stalls you politely.", ...card([{ type: 'text', text: "The Sheriff's Office: Sheriff Dunmore stalls you politely." }, button('go', 'Ask about the key', { act: { say: 'About the key…' } })]) });
  await request(t.gm.token, 'POST', `${t.root}/ai/observe-now`);
  const flow = await request(t.gm.token, 'GET', `${t.root}/script-knowledge?kind=flow`);
  assert.ok(flow.every((e) => e.status === 'pending'), `a card moves nothing: ${JSON.stringify(flow.map((e) => [e.title, e.status]))}`);
  await t.say(t.gm, "You step into the Sheriff's Office. Sheriff Dunmore looks up from his desk and stalls you politely.", { kind: 'narration' });
  await request(t.gm.token, 'POST', `${t.root}/ai/observe-now`);
  assert.equal((await request(t.gm.token, 'GET', `${t.root}/script-knowledge?kind=flow`)).find((e) => /Sheriff/.test(e.title)).status, 'active', 'the same words as narration do');
  // Deleting the server takes the cards and every row behind them.
  await request(t.gm.token, 'DELETE', `/api/servers/${t.server.id}`, { confirm: 'Delete Server' });
  await request(t.gm.token, 'GET', `${t.root}/hypertext?ids=${open.id}`, undefined, 404);
});
