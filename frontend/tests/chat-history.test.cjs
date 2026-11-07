const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { chatStore, msg } = require('./chat-harness.cjs');

const ids = (list) => list.map((m) => m.id);
const lines = (from, to, extra) => Array.from({ length: to - from + 1 }, (_, i) => msg(`m${from + i}`, from + i, extra));

test('the first opening shows the newest lines and keeps them; while the stream stays subscribed, opening again asks for nothing', async () => {
  const h = chatStore();
  h.store.getState().streamUp('c');
  const opening = h.store.getState().open('c', 'w', 'player');
  const first = await h.next('messages');
  assert.equal(first.before, undefined);
  first.resolve(lines(1, 3));
  await opening;
  assert.deepEqual(ids(h.store.getState().byWindow.w), ['m1', 'm2', 'm3']);
  assert.deepEqual(h.store.getState().spans.w, { channelId: 'c', access: 'player', from: 1, through: 3, complete: true, live: h.store.getState().spans.w.live });
  assert.ok(h.store.getState().spans.w.live, 'brought up to date while the stream was subscribed: kept current by it');
  assert.equal(h.kept.get('w').through, 3, 'kept on this device');

  // Pushed lines are recorded in the window and extend what is known complete.
  h.store.getState().push(msg('m4', 4)); h.store.getState().push(msg('x9', 9, { chat_window_id: 'other' }));
  assert.equal(h.store.getState().spans.w.through, 4);
  assert.deepEqual(ids(h.kept.get('w').messages), ['m1', 'm2', 'm3', 'm4']);
  await h.store.getState().open('c', 'w', 'player');
  await h.idle();
  assert.equal(h.pending.messages.length + h.pending.messagesAfter.length, 0, 'nothing fetched: every line was pushed');
});

test('after the stream dropped, opening asks only for the lines after the last one kept, and is current again', async () => {
  const h = chatStore();
  h.store.getState().streamUp('c');
  const opening = h.store.getState().open('c', 'w', 'player');
  (await h.next('messages')).resolve(lines(1, 3));
  await opening;
  h.store.getState().streamDown();
  h.store.getState().push(msg('m5', 5));   // arrived, but m4 was missed while the socket was down
  assert.equal(h.store.getState().spans.w.through, 3, 'not live: a push does not prove the lines before it arrived');
  h.store.getState().streamUp('c');
  const again = h.store.getState().open('c', 'w', 'player');
  const ask = await h.next('messagesAfter');
  assert.equal(ask.after, 3);
  ask.resolve([msg('m4', 4), msg('m5', 5)]);
  await again;
  assert.deepEqual(ids(h.store.getState().byWindow.w), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(h.store.getState().spans.w.through, 5);
  assert.ok(h.store.getState().spans.w.live);
});

test('a catch-up made while the stream was down leaves the window to catch up again next time', async () => {
  const h = chatStore();
  const opening = h.store.getState().open('c', 'w', 'player');
  (await h.next('messages')).resolve(lines(1, 2));
  await opening;
  assert.equal(h.store.getState().spans.w.live, null);
  const again = h.store.getState().open('c', 'w', 'player');
  (await h.next('messagesAfter')).resolve([]);
  await again;
  assert.equal(h.store.getState().spans.w.through, 2);
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
