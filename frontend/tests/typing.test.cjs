const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// The typing store (src/store/typing.ts): who is being written as, fed by the chat socket.
function load() {
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/store/typing.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)((name) => { if (name === 'zustand') return require('zustand'); throw Error(name); }, mod, mod.exports);
  return mod.exports.useTyping;
}
test('a typing flag stays up until it is lowered: the server announces it once and relays no heartbeats', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const store = load();
  store.getState().changed({ character_id: 'ada', chat_window_id: 'w1', active: true });
  t.mock.timers.tick(5 * 60000); store.getState().prune();
  assert.deepEqual(Object.keys(store.getState().byCharacter), ['ada'], 'the pen is still there after five minutes of steady typing');
  assert.equal(store.getState().byCharacter.ada.windowId, 'w1');
  store.getState().changed({ character_id: 'ada', chat_window_id: 'w1', active: false });
  assert.deepEqual(store.getState().byCharacter, {});
  // The snapshot after a subscription replaces what was known; a fall that never arrived goes after a long while.
  store.getState().changed({ character_id: 'ada', chat_window_id: 'w1', active: true });
  store.getState().snapshot([{ character_id: 'mo', chat_window_id: 'w2' }]);
  assert.deepEqual(Object.keys(store.getState().byCharacter), ['mo']);
  t.mock.timers.tick(11 * 60000); store.getState().prune();
  assert.deepEqual(store.getState().byCharacter, {});
  store.getState().changed({ character_id: 'ada', chat_window_id: 'w1', active: true }); store.getState().reset();
  assert.deepEqual(store.getState().byCharacter, {});
});
