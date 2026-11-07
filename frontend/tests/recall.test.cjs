const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The chat store with a stand-in api: requests resolve when the test says so.
function harness() {
  let epoch = 0;
  const pending = { messages: [], recall: [] }, toasts = [];
  const api = {
    messages: () => new Promise((resolve, reject) => pending.messages.push({ resolve, reject })),
    recallMessage: (ch, id) => new Promise((resolve, reject) => pending.recall.push({ ch, id, resolve, reject })),
  };
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/store/chat.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;   // as the app is built: an ES5 spread of a Map iterator is empty
  const mod = { exports: {} };
  const req = (name) => {
    if (name === 'zustand') return require('zustand');
    if (name === '../api/client') return { api };
    if (name === './ui') return { useUi: { getState: () => ({ toast: (text, kind) => toasts.push({ text, kind }) }) } };
    if (name === './session') return { sessionEpoch: () => epoch, isStale: (e) => e !== epoch };
    throw Error(name);
  };
  new Function('require', 'module', 'exports', js)(req, mod, mod.exports);
  return { ...mod.exports, store: mod.exports.useChat, pending, toasts, switchSession: () => ++epoch };
}
const msg = (id, seq, extra = {}) => ({ id, seq, channel_id: 'c', chat_window_id: 'w', author_id: 'u', content: `line ${id}`, kind: 'ic', recall_seconds_left: 120, ...extra });
const tomb = (m) => ({ ...m, content: '', dice: null, reference_ids: [], recalled_at: '2026-11-07T00:00:00Z', recall_seconds_left: null });

test('a tombstone takes the line\'s place in every window showing it, and leaves the composer\'s references', () => {
  const { store } = harness();
  const a = msg('a', 1), b = msg('b', 2);
  store.setState({ byWindow: { w: [a, b], fork: [a, msg('c', 3, { chat_window_id: 'fork' })] }, references: [a] });
  store.getState().applyRecall(tomb(a));
  const s = store.getState();
  assert.deepEqual(s.byWindow.w.map((m) => [m.id, m.content]), [['a', ''], ['b', 'line b']]);
  assert.equal(s.byWindow.fork[0].recalled_at, '2026-11-07T00:00:00Z', 'a fork showing its parent\'s line gets the tombstone too');
  assert.deepEqual(s.references, []);
});

test('a reload that left before the recall cannot bring the line back', async () => {
  const { store, pending } = harness();
  const a = msg('a', 1);
  store.setState({ byWindow: { w: [a] } });
  const load = store.getState().load('c', 'w');
  store.getState().applyRecall(tomb(a));
  pending.messages[0].resolve([a, msg('b', 2)]);   // the copy fetched before the recall
  await load;
  assert.deepEqual(store.getState().byWindow.w.map((m) => [m.id, m.content]), [['a', ''], ['b', 'line b']]);
});

test('the author\'s recall keeps the text for "Re-edit"; refusals are told in words the interface translates', async () => {
  const { store, pending, toasts, recallError } = harness();
  const a = msg('a', 1);
  store.setState({ byWindow: { w: [a] } });
  const done = store.getState().recall(a);
  assert.deepEqual([pending.recall[0].ch, pending.recall[0].id], ['c', 'a']);
  pending.recall[0].resolve({ message: tomb(a), content: 'line a' });
  await done;
  assert.equal(store.getState().byWindow.w[0].content, '');
  assert.equal(store.getState().recallDrafts.a, 'line a');
  const late = store.getState().recall(msg('b', 2));
  pending.recall[1].reject(Object.assign(new Error('Messages can only be recalled within 2 minutes of sending'), { code: 'recall_expired' }));
  await late;
  assert.deepEqual(toasts, [{ text: 'Messages can only be recalled within 2 minutes of sending.', kind: 'error' }]);
  assert.equal(recallError({ code: 'not_recallable' }), "This message can't be recalled.");
  store.getState().reset();
  assert.deepEqual(store.getState().recallDrafts, {});
});

test('the recall deadline comes from the first arrival and never grows; tombstones and old lines have none', () => {
  const { recallDeadline } = harness();
  const now = Date.now();
  const first = recallDeadline(msg('a', 1, { recall_seconds_left: 100 }));
  assert.ok(first >= now + 99000 && first <= Date.now() + 100000);
  assert.equal(recallDeadline(msg('a', 1, { recall_seconds_left: 110 })), first, 'a later copy saying more time does not extend it');
  assert.ok(recallDeadline(msg('a', 1, { recall_seconds_left: 5 })) < first, 'one saying less shortens it');
  assert.equal(recallDeadline(tomb(msg('b', 2))), null);
  assert.equal(recallDeadline(msg('c', 3, { recall_seconds_left: null })), null);
});
