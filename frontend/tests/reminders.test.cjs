const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function harness() {
  let epoch = 0;
  const requests = [], dismissals = [];
  const api = {
    reminders: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    dismissReminder: () => new Promise((resolve, reject) => dismissals.push({ resolve, reject })),
  };
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/store/reminders.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  const req = name => {
    if (name === 'zustand') return require('zustand');
    if (name === '../api/client') return { api };
    if (name === './session') return { sessionEpoch: () => epoch, isStale: e => e !== epoch };
    throw Error(name);
  };
  new Function('require', 'module', 'exports', js)(req, mod, mod.exports);
  return { store: mod.exports.useReminders, requests, dismissals, switchSession: () => ++epoch };
}
const reminder = (id, extra = {}) => ({ id, version: 1, expires_at: new Date(Date.now() + 60000).toISOString(), ...extra });
test('reconciliation removes resolved reminders, refreshes versions and ignores out-of-order loads', async () => {
  const { store, requests } = harness();
  const initial = store.getState().load('c'); requests[0].resolve([reminder('old'), reminder('kept')]); await initial;
  store.getState().open('old');
  const slow = store.getState().load('c'), fresh = store.getState().load('c');
  requests[2].resolve([reminder('kept', { version: 2 }), reminder('new')]); await fresh;
  requests[1].resolve([reminder('old')]); await slow;
  assert.deepEqual(store.getState().list.map(r => [r.id, r.version]), [['kept', 2], ['new', 1]]);
  assert.equal(store.getState().openId, null);
});
test('reset, session switch, dismissal and expiry cannot resurrect stale reminders', async () => {
  const { store, requests, dismissals, switchSession } = harness();
  let pending = store.getState().load('c'); store.getState().reset(); requests[0].resolve([reminder('old')]); await pending;
  assert.equal(store.getState().list.length, 0);
  pending = store.getState().load('c'); switchSession(); requests[1].resolve([reminder('old')]); await pending;
  assert.equal(store.getState().list.length, 0);
  store.getState().add(reminder('a')); store.getState().open('a');
  const failed = store.getState().dismiss('c', 'a'); dismissals[0].reject(Error('offline')); await assert.rejects(failed);
  assert.equal(store.getState().openId, 'a');
  pending = store.getState().load('c'); const success = store.getState().dismiss('c', 'a'); dismissals[1].resolve({}); await success;
  requests[2].resolve([reminder('a')]); await pending;
  assert.equal(store.getState().list.length, 0);
  store.getState().add(reminder('expired', { expires_at: '2000-01-01T00:00:00Z' })); store.getState().open('expired'); store.getState().prune();
  assert.equal(store.getState().list.length, 0); assert.equal(store.getState().openId, null);
});
