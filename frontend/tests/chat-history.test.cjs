const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { chatStore, msg } = require('./chat-harness.cjs');

const ids = (list) => list.map((m) => m.id);
const lines = (from, to, extra) => Array.from({ length: to - from + 1 }, (_, i) => msg(`m${from + i}`, from + i, extra));

// A clock the test moves: the store reads Date.now().
function clock(at = Date.parse('2026-11-07T12:00:00Z')) {
  const real = Date.now;
  Date.now = () => at;
  return { advance: (ms) => { at += ms; }, restore: () => { Date.now = real; } };
}

test('pushed lines show at once but do not count as checked; with the stream subscribed the window is checked every 30 s', async () => {
  const time = clock();
  try {
    const h = chatStore();
    h.store.getState().streamUp('c');
    const opening = h.store.getState().open('c', 'w', 'player');
    const first = await h.next('messages');
    assert.equal(first.before, undefined);
    first.resolve(lines(1, 3));
    await opening;
    assert.deepEqual(ids(h.store.getState().byWindow.w), ['m1', 'm2', 'm3']);
    assert.deepEqual(h.store.getState().spans.w, { channelId: 'c', access: 'player', from: 1, through: 3, complete: true, checkedAt: Date.now() });
    assert.equal(h.kept.get('w').through, 3, 'kept on this device');

    // m4 is lost on the way; m5 is pushed. It shows, but the window is not taken to be complete through it.
    h.store.getState().push(msg('m5', 5)); h.store.getState().push(msg('x9', 9, { chat_window_id: 'other' }));
    assert.deepEqual(ids(h.store.getState().byWindow.w), ['m1', 'm2', 'm3', 'm5']);
    assert.equal(h.store.getState().spans.w.through, 3);

    // Within 30 s: neither reopening nor the timer asks the server.
    time.advance(29_000);
    await h.store.getState().open('c', 'w', 'player');
    await h.store.getState().refresh('c', 'w', 'player');
    await h.idle();
    assert.equal(h.pending.messages.length + h.pending.messagesAfter.length, 0, 'checked a moment ago');

    // At 30 s the timer checks from the last checked line, and the lost line turns up.
    time.advance(1_000);
    const check = h.store.getState().refresh('c', 'w', 'player');
    const ask = await h.next('messagesAfter');
    assert.equal(ask.after, 3);
    ask.resolve([msg('m4', 4), msg('m5', 5)]);
    await check;
    assert.deepEqual(ids(h.store.getState().byWindow.w), ['m1', 'm2', 'm3', 'm4', 'm5']);
    assert.equal(h.store.getState().spans.w.through, 5);
  } finally { time.restore(); }
});

test('while the stream is not subscribed the window is checked every 5 s', async () => {
  const time = clock();
  try {
    const h = chatStore();
    h.store.getState().streamUp('c');
    const opening = h.store.getState().open('c', 'w', 'player');
    (await h.next('messages')).resolve(lines(1, 3));
    await opening;
    h.store.getState().streamDown();
    time.advance(4_000);
    await h.store.getState().refresh('c', 'w', 'player');
    assert.equal(h.pending.messagesAfter.length, 0);
    time.advance(1_000);
    const check = h.store.getState().refresh('c', 'w', 'player');
    const ask = await h.next('messagesAfter');
    assert.equal(ask.after, 3);
    ask.resolve([msg('m4', 4)]);
    await check;
    assert.equal(h.store.getState().spans.w.through, 4);
    // Subscribed again: back to every 30 s.
    h.store.getState().streamUp('c');
    time.advance(5_000);
    await h.store.getState().refresh('c', 'w', 'player');
    await h.idle();
    assert.equal(h.pending.messagesAfter.length, 0);
  } finally { time.restore(); }
});

test('a check asked for while one is running for the window waits for it instead of sending another', async () => {
  const h = chatStore();
  const opening = h.store.getState().open('c', 'w', 'player');
  (await h.next('messages')).resolve(lines(1, 2));
  await opening;
  const one = h.store.getState().catchUp('c', 'w', 'player');
  const two = h.store.getState().catchUp('c', 'w', 'player');
  (await h.next('messagesAfter')).resolve([]);
  await Promise.all([one, two]);
  await h.idle();
  assert.equal(h.pending.messagesAfter.length, 0);
});

test('a check running when the stream subscribes again is followed by one more, however many asked meanwhile', async () => {
  const h = chatStore();
  const opening = h.store.getState().open('c', 'w', 'player');
  (await h.next('messages')).resolve(lines(1, 2));
  await opening;
  const one = h.store.getState().catchUp('c', 'w', 'player');
  const first = await h.next('messagesAfter');
  h.store.getState().streamUp('c');   // pushes from here on; one sent before this may have been lost
  const two = h.store.getState().catchUp('c', 'w', 'player');
  const three = h.store.getState().catchUp('c', 'w', 'player');
  first.resolve([]);
  const again = await h.next('messagesAfter');
  again.resolve([msg('m3', 3)]);
  await Promise.all([one, two, three]);
  await h.idle();
  assert.equal(h.pending.messagesAfter.length, 0, 'only one more');
  assert.deepEqual(ids(h.store.getState().byWindow.w), ['m1', 'm2', 'm3']);
  assert.equal(h.store.getState().spans.w.through, 3);
});

test('after a reload the kept lines show at once, then only what came after them is fetched', async () => {
  const kept = new Map([['w', { windowId: 'w', channelId: 'c', access: 'player', messages: lines(10, 12), from: 10, through: 12, complete: false }]]);
  const h = chatStore({ kept });
  h.store.getState().streamUp('c');
  const opening = h.store.getState().open('c', 'w', 'player');
  const ask = await h.next('messagesAfter');
  assert.deepEqual(ids(h.store.getState().byWindow.w), ['m10', 'm11', 'm12'], 'shown before the server answers');
  assert.equal(ask.after, 12);
  ask.resolve([msg('m13', 13)]);
  await opening;
  assert.deepEqual(ids(h.store.getState().byWindow.w), ['m10', 'm11', 'm12', 'm13']);
  assert.equal(h.store.getState().spans.w.complete, false);
});

test('history kept under another access is thrown away unread', async () => {
  const kept = new Map([['w', { windowId: 'w', channelId: 'c', access: 'gm', messages: [msg('secret', 1)], from: 1, through: 1, complete: true }]]);
  const h = chatStore({ kept });
  const opening = h.store.getState().open('c', 'w', 'player|group|2');
  const ask = await h.next('messages');
  assert.deepEqual(h.store.getState().byWindow.w ?? [], [], 'never shown');
  ask.resolve([msg('m2', 2)]);
  await opening;
  assert.deepEqual(ids(h.store.getState().byWindow.w), ['m2']);
  assert.ok(h.drops.some((d) => d.windowId === 'w'));
  // A change of access while open drops what the window holds too.
  h.store.getState().push(msg('m3', 3));
  const changed = h.store.getState().open('c', 'w', 'player|group|3');
  (await h.next('messages')).resolve([msg('m4', 4)]);
  await changed;
  assert.deepEqual(ids(h.store.getState().byWindow.w), ['m4']);
});

test('recent lines are read again on catching up, so a recall made meanwhile turns into its tombstone', async () => {
  const now = new Date().toISOString();
  const kept = new Map([['w', { windowId: 'w', channelId: 'c', access: 'player', messages: [msg('old', 1), msg('fresh', 7, { created_at: now }), msg('fresher', 8, { created_at: now })], from: 1, through: 8, complete: true }]]);
  const h = chatStore({ kept });
  const opening = h.store.getState().open('c', 'w', 'player');
  const ask = await h.next('messagesAfter');
  assert.equal(ask.after, 6, 'from just before the oldest recent line');
  ask.resolve([{ ...msg('fresh', 7, { created_at: now }), content: '', recalled_at: now }, msg('fresher', 8, { created_at: now })]);
  await opening;
  assert.equal(h.store.getState().byWindow.w.find((m) => m.id === 'fresh').recalled_at, now);
  assert.equal(h.store.getState().spans.w.through, 8);
});

test('a gap too long to page through starts again from the newest lines', async () => {
  const kept = new Map([['w', { windowId: 'w', channelId: 'c', access: 'player', messages: lines(1, 3), from: 1, through: 3, complete: true }]]);
  const h = chatStore({ kept });
  const opening = h.store.getState().open('c', 'w', 'player');
  for (let page = 0; page < h.CATCH_UP_PAGES; page++) {
    const ask = await h.next('messagesAfter');
    const start = 4 + page * h.CATCH_UP_PAGE;
    ask.resolve(lines(start, start + h.CATCH_UP_PAGE - 1));
  }
  const newest = await h.next('messages');
  newest.resolve(lines(5000, 5000 + h.PAGE - 1));
  await opening;
  const s = h.store.getState();
  assert.equal(s.byWindow.w[0].seq, 5000, 'the old block is not joined to the new one');
  assert.deepEqual([s.spans.w.from, s.spans.w.through, s.spans.w.complete], [5000, 5000 + h.PAGE - 1, false]);
});

test('scrolling up goes back from the block, page by page, and stops at the first line', async () => {
  const h = chatStore();
  h.store.getState().push(msg('early', 500));
  await h.store.getState().loadOlder('c', 'w');
  assert.equal(h.pending.messages.length, 0, 'not before the window has been opened');
  const opening = h.store.getState().open('c', 'w', 'player');
  (await h.next('messages')).resolve(lines(100, 100 + h.PAGE - 1));
  await opening;
  h.store.getState().push(msg('island', 5));   // a message opened from a reference, far back
  const older = h.store.getState().loadOlder('c', 'w');
  const ask = await h.next('messages');
  assert.equal(ask.before, 100, 'from the block, not from the lone message');
  ask.resolve(lines(90, 99));
  await older;
  assert.equal(h.store.getState().spans.w.from, 90);
  assert.equal(h.store.getState().spans.w.complete, true);
  await h.store.getState().loadOlder('c', 'w');
  await h.idle();
  assert.equal(h.pending.messages.length, 0, 'the first line is here: nothing more to ask');
});

test('kept history: the newest lines only, no stale recall offer, no search vector', () => {
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/chatHistory.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)((name) => { if (name === './storage') return { readStorage: () => null, writeStorage: () => undefined }; throw Error(name); }, mod, mod.exports);
  const { trimHistory } = mod.exports;
  const entry = { windowId: 'w', channelId: 'c', access: 'a', messages: [msg('island', 1), ...lines(10, 14, { recall_seconds_left: 60, search: "'lantern':1" })], from: 10, through: 14, complete: true };
  const all = trimHistory(entry);
  assert.deepEqual(ids(all.messages), ['m10', 'm11', 'm12', 'm13', 'm14'], 'only the contiguous block');
  assert.ok(all.messages.every((m) => !('recall_seconds_left' in m) && !('search' in m)));
  assert.equal(all.complete, true);
  const newest = trimHistory(entry, 2);
  assert.deepEqual(ids(newest.messages), ['m13', 'm14']);
  assert.deepEqual([newest.from, newest.complete], [13, false]);
});
