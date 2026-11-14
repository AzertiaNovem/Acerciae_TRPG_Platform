// Interactive messages: the web store (src/store/hypertext.ts) and the card routes of the API client
// (src/api/client.ts), with stand-ins for the network, the chat store and the engine. Covers the action pipeline every
// client follows: one interaction id per action reused by its retries, 428 confirm-and-resend, 409 adopt, partial
// results, newer pushes only, resets that drop late answers, the feature marked unavailable on an older or switched
// off server, coalesced saves, and status fetched in batches of at most 100 ids.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { load } = require('./hypertext-harness.cjs');

const { parseDoc } = load('format');
const transpile = (file) => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const STORE_JS = transpile('store/hypertext.ts');
const CLIENT_JS = transpile('api/client.ts');
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (cond, label) => { for (let i = 0; i < 400; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 2)); } assert.fail('timed out waiting for ' + label); };

// The store with stand-ins: api requests wait until the test answers them; pushes into the chat store are recorded.
function harness() {
  let epoch = 0;
  const pending = { status: [], save: [], act: [], close: [] }, pushed = [], runs = [];
  const wait = (kind, args) => new Promise((resolve, reject) => pending[kind].push({ ...args, resolve, reject }));
  const api = {
    hypertextStatus: (ch, ids) => wait('status', { ch, ids }),
    hypertextSave: (ch, id, body) => wait('save', { ch, id, body: JSON.parse(JSON.stringify(body)) }),
    hypertextAct: (ch, id, body) => wait('act', { ch, id, body: JSON.parse(JSON.stringify(body)) }),
    hypertextClose: (ch, id) => wait('close', { ch, id }),
  };
  const engine = { result: null, disposed: 0, run: async (card, input, prev) => { runs.push({ card, input, prev }); return typeof engine.result === 'function' ? engine.result(input) : engine.result; }, dispose() { engine.disposed++; } };
  const mod = { exports: {} };
  const req = (name) => {
    if (name === 'zustand') return require('zustand');
    if (name === '../api/client') return { api };
    if (name === './chat') return { useChat: { getState: () => ({ push: (m) => pushed.push(m) }) } };
    if (name === './session') return { sessionEpoch: () => epoch, isStale: (e) => e !== epoch };
    if (name === '../hypertext/client') return { hypertextEngine: () => engine, engineAvailable: () => true };
    if (name.startsWith('../hypertext/')) return load(name.slice('../hypertext/'.length));
    throw Error(name);
  };
  new Function('require', 'module', 'exports', STORE_JS)(req, mod, mod.exports);
  Object.assign(mod.exports.HX_TIMING, { statusDebounceMs: 0, saveDebounceMs: 5, retryMs: [1, 2, 3], statusRetryMs: 10 });
  const store = mod.exports.useHypertext;
  const next = async (kind, label = kind) => { await until(() => pending[kind].length, label); return pending[kind].shift(); };
  return { ...mod.exports, store, api, pending, pushed, runs, engine, next, card: (id) => store.getState().cards[id], bump: () => ++epoch };
}

const DOC = parseDoc({
  v: 1, title: 'The study',
  state: { seen: { type: 'bool' }, done: { type: 'bool' }, pick: { type: 'enum', values: [{ value: 'a' }, { value: 'b' }] } },
  body: [
    { type: 'checkbox', id: 'seen_box', label: 'Seen', bind: 'seen' },
    { type: 'choice', id: 'pick_box', label: 'Pick', bind: 'pick', display: 'buttons' },
    { type: 'button', id: 'roll', label: 'Roll', act: { set: { done: true }, say: '.ra Spot Hidden' }, enable_if: { key: 'done', eq: false } },
    { type: 'button', id: 'sanity', label: 'Sanity', act: { say: '.sc 1/1d6' } },
    { type: 'button', id: 'mark', label: 'Mark', act: { set: { done: true } } },
    { type: 'button', id: 'go', label: 'Go', on: 'go' },
  ],
  script: "on('go', () => { say('I open the door.'); state.done = true; })",
});
assert.ok(DOC, 'the test card parses');
const ctx = (id = 'm1', extra = {}) => ({ message: { id, channel_id: 'c' }, doc: DOC, lock: { reason: null }, viewer: { gm: false, actor: true, character: 'Ada' }, engine: true, ...extra });
const DEFAULT = { seen: false, done: false, pick: null };
const item = (id, extra = {}) => ({ message_id: id, closes_at: '2099-01-01T00:00:00Z', closed_at: null, closed: false, state: null, version: 0, runs_left: 1, ...extra });
const line = (id, extra = {}) => ({ id, seq: 1, channel_id: 'c', chat_window_id: 'w', kind: 'roll', content: '.ra Spot Hidden', ...extra });
// A card whose status has arrived.
async function loaded(h, id = 'm1', extra = {}) {
  h.store.getState().track('c', [id]);
  const r = await h.next('status');
  r.resolve({ enabled: true, items: [item(id, extra)] });
  await until(() => h.card(id).loaded, 'status');
}
const offline = () => new TypeError('Failed to fetch');
const apiError = (status, code, data = {}, apiResponse = true) => Object.assign(new Error(code), { status, code, apiResponse, data: { error: code, ...data } });

test('status: fetched once per card, in one request for the new ones, again for all on refresh and resync', async () => {
  const h = harness();
  h.store.getState().track('c', ['a', 'b']);
  assert.equal(h.card('a').loaded, false, 'controls wait for the status');
  const first = await h.next('status');
  assert.deepEqual([first.ch, first.ids], ['c', ['a', 'b']]);
  first.resolve({ enabled: true, items: [item('a', { state: { seen: true }, version: 2, runs_left: 0 })] });
  await until(() => h.card('a').loaded && h.card('b').loaded, 'loaded');
  assert.deepEqual([h.card('a').state, h.card('a').version, h.card('a').runsLeft], [{ seen: true }, 2, 0]);
  assert.equal(h.card('b').gone, true, 'a card left out of the status (recalled, unreadable) is gone');
  // The set of loaded cards grows: only the new one is asked about.
  h.store.getState().track('c', ['a', 'b', 'c3']);
  const second = await h.next('status');
  assert.deepEqual(second.ids, ['c3']);
  second.resolve({ enabled: true, items: [item('c3')] });
  await until(() => h.card('c3').loaded, 'c3');
  h.store.getState().track('c', ['a', 'b', 'c3']);
  await tick();
  assert.equal(h.pending.status.length, 0, 'nothing new: nothing asked');
  // A window opened again, or the stream subscribed again: all of them.
  h.store.getState().resync();
  const third = await h.next('status');
  assert.deepEqual(third.ids, ['a', 'b', 'c3']);
  third.resolve({ enabled: true, items: [item('a', { state: { seen: false }, version: 3 }), item('b'), item('c3', { closed_at: '2026-01-01T00:00:00Z', closed: true })] });
  await until(() => h.card('a').version === 3, 'refresh adopted');
  assert.equal(h.card('b').gone, false);
  assert.equal(h.card('c3').closedAt, '2026-01-01T00:00:00Z');
  // A failed status request is tried again later; the controls stay "Loading…" meanwhile.
  h.store.getState().track('c', ['d']);
  (await h.next('status')).reject(offline());
  assert.equal(h.card('d').loaded, false);
  const retry = await h.next('status', 'status retry');
  assert.deepEqual(retry.ids, ['d']);
  retry.resolve({ enabled: true, items: [item('d')] });
  await until(() => h.card('d').loaded, 'd');
});

test('the API client asks for at most 100 cards a request and keeps the error body', async () => {
  const requests = [];
  let reply = (url) => ({ status: 200, body: { enabled: true, items: new URL(url, 'http://x').searchParams.get('ids').split(',').map((id) => ({ message_id: id })) } });
  global.fetch = async (url, init) => { requests.push({ url, init }); const r = reply(url, init); return { ok: r.status < 300, status: r.status, statusText: 'x', text: async () => JSON.stringify(r.body) }; };
  const mod = { exports: {} };
  const req = (name) => {
    if (name === '../lib/desktopAccounts') return { createAccountDirectory: () => null };
    if (name === '../lib/platform') return { apiBase: () => '', isDesktop: false, setServerUrl() {} };
    if (name === '../lib/tokenStore') return { createTokenStore: () => ({ initial: () => 'secret', load: async () => 'secret', save: async () => {} }), tauriKeychain: {} };
    throw Error(name);
  };
  new Function('require', 'module', 'exports', CLIENT_JS)(req, mod, mod.exports);
  const { api, HYPERTEXT_STATUS_IDS } = mod.exports;
  assert.equal(HYPERTEXT_STATUS_IDS, 100);
  const ids = Array.from({ length: 230 }, (_, i) => `id${i}`);
  const r = await api.hypertextStatus('c', ids);
  assert.equal(requests.length, 3);
  const asked = requests.map((x) => new URL(x.url, 'http://x').searchParams.get('ids').split(','));
  assert.deepEqual(asked.map((x) => x.length), [100, 100, 30]);
  assert.deepEqual(asked.flat(), ids);
  assert.ok(requests.every((x) => x.url.startsWith('/api/channels/c/hypertext?ids=') && x.init.method === 'GET'));
  assert.deepEqual(r.items.map((x) => x.message_id), ids);
  // Turned off: the answer says so at once.
  requests.length = 0; reply = () => ({ status: 200, body: { enabled: false, items: [] } });
  assert.deepEqual(await api.hypertextStatus('c', ids), { enabled: false, items: [] });
  assert.equal(requests.length, 1);
  // A refusal keeps its whole body (the stored state of a 409, the text of a 428).
  reply = () => ({ status: 409, body: { error: 'state_conflict', message: 'changed', state: { seen: true }, version: 4 } });
  const err = await api.hypertextSave('c', 'm1', { state: { seen: false }, base_version: 1 }).catch((e) => e);
  assert.deepEqual([err.status, err.code, err.apiResponse, err.data.state, err.data.version], [409, 'state_conflict', true, { seen: true }, 4]);
  assert.equal(requests.at(-1).url, '/api/channels/c/messages/m1/hypertext/state');
  assert.equal(requests.at(-1).init.method, 'PUT');
  reply = () => ({ status: 200, body: {} });
  await api.hypertextAct('c', 'm1', { interaction_id: 'x', base_version: 0, say: { text: '.r 1d6' } });
  await api.hypertextClose('c', 'm1');
  assert.deepEqual(requests.slice(-2).map((x) => [x.init.method, x.url]), [['POST', '/api/channels/c/messages/m1/hypertext/act'], ['POST', '/api/channels/c/messages/m1/hypertext/close']]);
  assert.equal(JSON.parse(requests.at(-2).init.body).interaction_id, 'x');
  // An older server without the route answers with its own page, not the API's JSON.
  reply = () => ({ status: 404, body: 'Not Found' });
  const missing = await api.hypertextStatus('c', ['a']).catch((e) => e);
  assert.deepEqual([missing.status, missing.apiResponse], [404, false]);
  delete global.fetch;
});

test('plain changes are saved by one coalesced PUT from the version held; a newer push wins over an older one', async () => {
  const h = harness();
  await loaded(h, 'm1', { state: { seen: false, done: false, pick: null }, version: 2 });
  const s = h.store.getState();
  await s.interact(ctx(), 'seen_box', { type: 'toggle' });
  await s.interact(ctx(), 'pick_box', { type: 'select', value: 'b' });
  await s.interact(ctx(), 'seen_box', { type: 'toggle' });
  await s.interact(ctx(), 'seen_box', { type: 'toggle' });
  assert.deepEqual(h.card('m1').draft, { seen: true, done: false, pick: 'b' }, 'shown at once');
  const put = await h.next('save');
  assert.deepEqual(put.body, { state: { seen: true, done: false, pick: 'b' }, base_version: 2 });
  await tick();
  assert.equal(h.pending.save.length, 0, 'one request for the four changes');
  put.resolve({ message_id: 'm1', state: { seen: true, done: false, pick: 'b' }, version: 3 });
  await until(() => h.card('m1').version === 3, 'saved');
  assert.equal(h.card('m1').draft, null, 'nothing left to save');
  // Pushes: only a newer version applies.
  s.applyState('m1', { seen: false, done: true, pick: 'a' }, 5);
  s.applyState('m1', { seen: true, done: true, pick: 'b' }, 4);
  s.applyState('m1', { seen: true, done: true, pick: 'b' }, 5);
  assert.deepEqual([h.card('m1').state, h.card('m1').version], [{ seen: false, done: true, pick: 'a' }, 5]);
  // A save refused because another device saved first adopts the stored state.
  await s.interact(ctx(), 'seen_box', { type: 'toggle' });
  const conflicting = await h.next('save');
  assert.equal(conflicting.body.base_version, 5);
  conflicting.reject(apiError(409, 'state_conflict', { state: { seen: false, done: false, pick: 'b' }, version: 7 }));
  await until(() => h.card('m1').version === 7, 'conflict adopted');
  assert.deepEqual([h.card('m1').state, h.card('m1').draft, h.card('m1').error], [{ seen: false, done: false, pick: 'b' }, null, 'This message changed on another device.']);
  // hypertext.closed
  s.applyClosed('m1', '2026-11-14T00:00:00Z');
  assert.equal(h.card('m1').closedAt, '2026-11-14T00:00:00Z');
});

test('a network failure retries the action with the same interaction id; its lines are merged and the state adopted', async () => {
  const h = harness();
  await loaded(h, 'm1', { runs_left: 2 });
  const done = h.store.getState().interact(ctx(), 'roll', { type: 'click' });
  const first = await h.next('act');
  assert.equal(h.card('m1').pending, true);
  assert.deepEqual(h.card('m1').draft, { seen: false, done: true, pick: null }, 'the new state shows while it is sent');
  assert.deepEqual({ ...first.body, interaction_id: 'x' }, { interaction_id: 'x', node: 'roll', base_version: 0, state: { seen: false, done: true, pick: null }, say: { text: '.ra Spot Hidden', kind: 'ic' } });
  assert.match(first.body.interaction_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Ignored meanwhile: one action per card at a time.
  await h.store.getState().interact(ctx(), 'seen_box', { type: 'toggle' });
  first.reject(offline());
  const second = await h.next('act');
  second.reject(apiError(502, 'error', {}, false));
  const third = await h.next('act');
  third.reject(apiError(409, 'interaction_in_progress'));
  const fourth = await h.next('act');
  assert.deepEqual([second, third, fourth].map((x) => x.body), [first.body, first.body, first.body], 'every retry sends the same action');
  const roll = line('r1', { via_hypertext_id: 'm1' });
  fourth.resolve({ interaction_id: first.body.interaction_id, replayed: true, partial: false, results: [{ type: 'say', ok: true, message: roll }], state: { state: { seen: false, done: true, pick: null }, version: 1 } });
  await done;
  assert.deepEqual(h.pushed, [roll], 'the posted line goes into the chat (de-duplicated there with its push)');
  const c = h.card('m1');
  assert.deepEqual([c.pending, c.draft, c.version, c.state, c.runsLeft, c.error], [false, null, 1, { seen: false, done: true, pick: null }, 1, null]);
  assert.equal(h.pending.save.length, 0);
});

test('after three retries the action reverts; a refusal reverts with its reason', async () => {
  const h = harness();
  await loaded(h);
  const done = h.store.getState().interact(ctx(), 'roll', { type: 'click' });
  const ids = new Set();
  for (let i = 0; i < 4; i++) { const r = await h.next('act'); ids.add(r.body.interaction_id); r.reject(offline()); }
  await done;
  assert.equal(ids.size, 1);
  assert.deepEqual([h.card('m1').pending, h.card('m1').draft, h.card('m1').error], [false, null, "This message's action could not be sent. Check your connection."]);
  assert.equal(h.pending.act.length, 0, 'no fifth attempt');
  // Refused (403, not an actor): reverted, the reason in the catalog's words; a new click is a new interaction.
  const again = h.store.getState().interact(ctx(), 'roll', { type: 'click' });
  const r = await h.next('act');
  assert.ok(!ids.has(r.body.interaction_id), 'a new action has a new id');
  r.reject(apiError(403, 'not_an_actor'));
  await again;
  assert.deepEqual([h.card('m1').draft, h.card('m1').error], [null, 'This message is for other characters.']);
});

test('428: the viewer confirms, and the same action is sent again with confirmed; cancelling sends nothing', async () => {
  const h = harness();
  await loaded(h);
  const done = h.store.getState().interact(ctx(), 'sanity', { type: 'click' });
  const first = await h.next('act');
  assert.equal(first.body.say.confirmed, undefined);
  first.reject(apiError(428, 'confirmation_required', { text: '.sc 1/1d6' }));
  await until(() => h.card('m1').confirm, 'confirm');
  assert.deepEqual(h.card('m1').confirm, { text: '.sc 1/1d6', kind: 'ic', sheet: true });
  h.store.getState().answer('m1', true);
  const second = await h.next('act');
  assert.equal(second.body.interaction_id, first.body.interaction_id);
  assert.deepEqual(second.body.say, { text: '.sc 1/1d6', kind: 'ic', confirmed: true });
  second.resolve({ interaction_id: first.body.interaction_id, replayed: false, partial: false, results: [{ type: 'say', ok: true, message: line('s1') }], state: { state: DEFAULT, version: 1 } });
  await done;
  assert.equal(h.card('m1').confirm, null);
  // Cancel: reverted, nothing more is sent.
  const cancelled = h.store.getState().interact(ctx(), 'sanity', { type: 'click' });
  (await h.next('act')).reject(apiError(428, 'confirmation_required', { text: '.sc 1/1d6' }));
  await until(() => h.card('m1').confirm, 'confirm 2');
  h.store.getState().answer('m1', false);
  await cancelled;
  await tick();
  assert.equal(h.pending.act.length, 0);
  assert.deepEqual([h.card('m1').pending, h.card('m1').confirm, h.card('m1').draft], [false, null, null]);
});

test('409: the state is adopted from the refusal, or the status fetched again', async () => {
  const h = harness();
  await loaded(h);
  let done = h.store.getState().interact(ctx(), 'roll', { type: 'click' });
  (await h.next('act')).reject(apiError(409, 'state_conflict', { state: { seen: true, done: true, pick: 'a' }, version: 4 }));
  await done;
  assert.deepEqual([h.card('m1').state, h.card('m1').version, h.card('m1').draft, h.card('m1').pending], [{ seen: true, done: true, pick: 'a' }, 4, null, false]);
  // Another 409 (closed, used up): the status again, and it is adopted.
  done = h.store.getState().interact(ctx(), 'sanity', { type: 'click' });
  const act = await h.next('act');
  assert.equal(act.body.base_version, 4, 'from the version adopted');
  act.reject(apiError(409, 'runs_exhausted'));
  await done;
  assert.equal(h.card('m1').error, 'You already used this.');
  const st = await h.next('status');
  assert.deepEqual(st.ids, ['m1']);
  st.resolve({ enabled: true, items: [item('m1', { state: { seen: true, done: true, pick: 'b' }, version: 5, runs_left: 0 })] });
  await until(() => h.card('m1').version === 5, 'refetched');
  assert.equal(h.card('m1').runsLeft, 0);
});

test('partial results: the lines that were posted are merged, the viewer is told the rest failed', async () => {
  const h = harness();
  await loaded(h);
  const done = h.store.getState().interact(ctx(), 'roll', { type: 'click' });
  const said = line('p1');
  (await h.next('act')).resolve({ interaction_id: 'i', replayed: false, partial: true,
    results: [{ type: 'say', ok: true, message: said }, { type: 'reply', ok: false, message: null, error: { error: 'internal', message: 'This line could not be posted' } }],
    state: { state: { seen: false, done: true, pick: null }, version: 1 } });
  await done;
  assert.deepEqual(h.pushed, [said]);
  assert.deepEqual([h.card('m1').version, h.card('m1').error, h.card('m1').pending], [1, 'Part of this action could not be posted.', false]);
  // A line the viewer may not read (a GM-only reply) comes back as null and is not merged.
  const again = h.store.getState().interact(ctx(), 'sanity', { type: 'click' });
  (await h.next('act')).resolve({ interaction_id: 'j', replayed: false, partial: false, results: [{ type: 'say', ok: true, message: null }], state: null });
  await again;
  assert.equal(h.pushed.length, 1);
});

test('a script handler: its state and notices show, its free text waits for the viewer, then the action is sent', async () => {
  const h = harness();
  await loaded(h);
  h.engine.result = (input) => ({ ok: true, state: { ...input.state, done: true }, effects: [{ type: 'say', text: 'I open the door.', kind: 'ic' }], notices: ['Creak.'], logs: ['ran'], confirm: { text: 'I open the door.', kind: 'ic' }, changed: true });
  const done = h.store.getState().interact(ctx(), 'go', { type: 'click' });
  await until(() => h.card('m1').confirm, 'confirm');
  const run = h.runs[0];
  assert.deepEqual([run.card, run.input.handler, run.input.event, run.input.viewer], ['m1', 'go', { type: 'click', node: 'go', value: null }, { gm: false, actor: true, character: 'Ada' }]);
  assert.deepEqual(Object.keys(run.input).sort(), ['doc', 'event', 'handler', 'state', 'viewer'], 'the engine gets the card and the viewer, nothing else');
  assert.deepEqual([h.card('m1').notices, h.card('m1').logs, h.card('m1').draft], [['Creak.'], ['ran'], { seen: false, done: true, pick: null }]);
  assert.equal(h.pending.act.length, 0, 'nothing is sent before the viewer confirms');
  h.store.getState().answer('m1', true);
  const act = await h.next('act');
  assert.deepEqual(act.body.say, { text: 'I open the door.', kind: 'ic', confirmed: true });
  act.resolve({ interaction_id: act.body.interaction_id, replayed: false, partial: false, results: [{ type: 'say', ok: true, message: line('d1') }], state: { state: { seen: false, done: true, pick: null }, version: 1 } });
  await done;
  // A failing script: reverted, nothing sent, the details kept for GMs.
  h.engine.result = { ok: false, error: { code: 'script_error', message: 'boom', line: 1 }, logs: ['before'] };
  await h.store.getState().interact(ctx(), 'go', { type: 'click' });
  const c = h.card('m1');
  assert.deepEqual([c.error, c.failure, c.logs, c.draft, c.pending], ["This message's action failed.", { code: 'script_error', message: 'boom', line: 1 }, ['before'], null, false]);
  assert.equal(h.pending.act.length, 0);
  // No effects: the changed state is saved by a PUT.
  h.engine.result = (input) => ({ ok: true, state: { ...input.state, pick: 'a' }, effects: [], notices: [], logs: [], confirm: null, changed: true });
  await h.store.getState().interact(ctx(), 'go', { type: 'click' });
  const put = await h.next('save');
  assert.deepEqual(put.body.state, { seen: false, done: true, pick: 'a' });
  // Without the engine on this device, a handler does not run.
  const before = h.runs.length;
  await h.store.getState().interact(ctx('m1', { engine: false }), 'go', { type: 'click' });
  assert.equal(h.runs.length, before);
  assert.equal(h.card('m1').error, 'Interactive actions are unavailable on this device.');
});

test('a reset (logout, channel switch, new epoch) drops late answers, cancels confirmations and stops the engine', async () => {
  const h = harness();
  await loaded(h);
  const act = h.store.getState().interact(ctx(), 'roll', { type: 'click' });
  const sent = await h.next('act');
  h.store.getState().track('c', ['m1', 'm2']);
  const late = await h.next('status');
  h.engine.result = (input) => ({ ok: true, state: input.state, effects: [{ type: 'say', text: 'Hi', kind: 'ic' }], notices: [], logs: [], confirm: { text: 'Hi', kind: 'ic' }, changed: false });
  h.store.getState().track('c', ['m3']);
  (await h.next('status')).resolve({ enabled: true, items: [item('m3')] });
  await until(() => h.card('m3').loaded, 'm3');
  const asking = h.store.getState().interact(ctx('m3'), 'go', { type: 'click' });
  await until(() => h.card('m3').confirm, 'confirm');
  h.bump(); h.store.getState().reset();
  assert.deepEqual(h.store.getState().cards, {});
  assert.equal(h.engine.disposed, 1, 'the worker goes with the session');
  await asking;
  sent.resolve({ interaction_id: 'x', replayed: false, partial: false, results: [{ type: 'say', ok: true, message: line('late') }], state: { state: DEFAULT, version: 1 } });
  late.resolve({ enabled: true, items: [item('m1'), item('m2')] });
  await act; await tick();
  assert.deepEqual(h.store.getState().cards, {}, 'nothing from before the reset comes back');
  assert.deepEqual(h.pushed, []);
  assert.equal(h.pending.act.length, 0);
  // Pushes for cards not tracked are ignored.
  h.store.getState().applyState('m1', { seen: true }, 9);
  assert.equal(h.card('m1'), undefined);
});

test('the feature is unavailable on 404/405 from these routes and 403 feature_disabled; the API\'s own 404 is a card gone', async () => {
  let h = harness();
  h.store.getState().track('c', ['m1']);
  (await h.next('status')).reject(apiError(404, 'error', {}, false));
  await until(() => h.card('m1').loaded, 'loaded');
  assert.equal(h.store.getState().unavailable, 'missing');
  await h.store.getState().interact(ctx(), 'roll', { type: 'click' });
  assert.equal(h.pending.act.length, 0, 'nothing is sent while unavailable');

  h = harness();
  h.store.getState().track('c', ['m1']);
  (await h.next('status')).resolve({ enabled: false, items: [] });
  await until(() => h.card('m1').loaded, 'loaded');
  assert.equal(h.store.getState().unavailable, 'disabled');

  h = harness();
  await loaded(h);
  let done = h.store.getState().interact(ctx(), 'roll', { type: 'click' });
  (await h.next('act')).reject(apiError(403, 'feature_disabled'));
  await done;
  assert.deepEqual([h.store.getState().unavailable, h.card('m1').draft, h.card('m1').pending], ['disabled', null, false]);

  h = harness();
  await loaded(h);
  await h.store.getState().interact(ctx(), 'seen_box', { type: 'toggle' });
  (await h.next('save')).reject(apiError(405, 'error', {}, false));
  await until(() => h.store.getState().unavailable === 'missing', 'missing');
  assert.equal(h.card('m1').draft, null);

  // The API's own 404 (the card was recalled meanwhile): reverted, and its status asked again.
  h = harness();
  await loaded(h);
  done = h.store.getState().interact(ctx(), 'roll', { type: 'click' });
  (await h.next('act')).reject(apiError(404, 'not_found'));
  await done;
  assert.equal(h.store.getState().unavailable, null);
  const st = await h.next('status');
  st.resolve({ enabled: true, items: [] });
  await until(() => h.card('m1').gone, 'gone');
});

test('a declarative act that posts nothing is a PUT; closing a card adopts its closing time', async () => {
  const h = harness();
  await loaded(h);
  await h.store.getState().interact(ctx(), 'mark', { type: 'click' });
  const put = await h.next('save');
  assert.deepEqual(put.body, { state: { seen: false, done: true, pick: null }, base_version: 0 });
  assert.equal(h.pending.act.length, 0);
  put.resolve({ message_id: 'm1', state: put.body.state, version: 1 });
  await until(() => h.card('m1').version === 1, 'saved');
  // A control the lock disables does nothing.
  await h.store.getState().interact(ctx('m1', { lock: { reason: 'closed' } }), 'seen_box', { type: 'toggle' });
  await tick();
  assert.equal(h.card('m1').draft, null);
  const closing = h.store.getState().close('c', 'm1');
  const c = await h.next('close');
  c.resolve({ message_id: 'm1', closes_at: '2099-01-01T00:00:00Z', closed_at: '2026-11-14T10:00:00Z', closed_by: 'gm', closed: true });
  await closing;
  assert.equal(h.card('m1').closedAt, '2026-11-14T10:00:00Z');
});

test('a change back to the saved value while a save is on its way is saved too', async () => {
  const h = harness();
  await loaded(h, 'm1', { state: { seen: false, done: false, pick: null }, version: 2 });
  const s = h.store.getState();
  await s.interact(ctx(), 'seen_box', { type: 'toggle' });
  const first = await h.next('save');
  assert.deepEqual(first.body, { state: { seen: true, done: false, pick: null }, base_version: 2 });
  // Unticked again before the PUT answered: that equals the server's last copy, yet must still be stored.
  await s.interact(ctx(), 'seen_box', { type: 'toggle' });
  assert.deepEqual(h.card('m1').draft, { seen: false, done: false, pick: null }, 'the untick shows and is kept to be saved');
  first.resolve({ message_id: 'm1', state: first.body.state, version: 3 });
  const second = await h.next('save', 'the second save');
  assert.deepEqual(second.body, { state: { seen: false, done: false, pick: null }, base_version: 3 });
  second.resolve({ message_id: 'm1', state: second.body.state, version: 4 });
  await until(() => h.card('m1').version === 4, 'saved again');
  assert.deepEqual([h.card('m1').draft, h.card('m1').state.seen], [null, false]);
  await tick();
  assert.equal(h.pending.save.length, 0, 'nothing more to save');
  // Without a save on its way, a change back to the server's copy needs no request.
  await s.interact(ctx(), 'seen_box', { type: 'toggle' });
  await s.interact(ctx(), 'seen_box', { type: 'toggle' });
  assert.equal(h.card('m1').draft, null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.pending.save.length, 0);
});

test('an action refused as closed or used up keeps the change made just before it, and saves it', async () => {
  const h = harness();
  await loaded(h);
  const s = h.store.getState();
  await s.interact(ctx(), 'seen_box', { type: 'toggle' });            // its save is still waiting for its timer…
  const done = s.interact(ctx(), 'sanity', { type: 'click' });         // …and goes with the action
  const act = await h.next('act');
  assert.equal(act.body.state.seen, true);
  act.reject(apiError(409, 'reply_exhausted'));
  await done;
  assert.deepEqual([h.card('m1').draft, h.card('m1').error], [{ seen: true, done: false, pick: null }, 'This answer is no longer available.']);
  const [put, st] = [await h.next('save', 'the tick saved on its own'), await h.next('status')];
  assert.deepEqual(put.body.state, { seen: true, done: false, pick: null });
  assert.deepEqual(st.ids, ['m1']);
});

test('a script whose lines can no longer be posted (runs used up) asks nothing and sends nothing', async () => {
  const h = harness();
  await loaded(h, 'm1', { runs_left: 0 });
  h.engine.result = (input) => ({ ok: true, state: { ...input.state, done: true }, effects: [{ type: 'say', text: 'brb, need a sec', kind: 'ooc' }], notices: ['Hm.'], logs: ['ran'], confirm: { text: 'brb, need a sec', kind: 'ooc' }, changed: true });
  await h.store.getState().interact(ctx(), 'go', { type: 'click' });
  const c = h.card('m1');
  assert.deepEqual([c.confirm, c.pending, c.draft, c.error, c.notices, c.logs], [null, false, null, 'You already used this.', [], ['ran']]);
  await tick();
  assert.equal(h.pending.act.length + h.pending.save.length, 0);
  // A handler that only changes the state still works.
  h.engine.result = (input) => ({ ok: true, state: { ...input.state, pick: 'a' }, effects: [], notices: [], logs: [], confirm: null, changed: true });
  await h.store.getState().interact(ctx(), 'go', { type: 'click' });
  assert.deepEqual((await h.next('save')).body.state, { seen: false, done: false, pick: 'a' });
});

test('the line goes out as the composer\'s character; with the server\'s dice off every script line is confirmed', async () => {
  const h = harness();
  await loaded(h, 'm1', { runs_left: 5 });
  // The composer speaks as another of the viewer's characters: the say names it.
  let done = h.store.getState().interact(ctx('m1', { sayCharacterId: 'bea' }), 'roll', { type: 'click' });
  let act = await h.next('act');
  assert.deepEqual(act.body.say, { text: '.ra Spot Hidden', kind: 'ic', character_id: 'bea' });
  act.resolve({ interaction_id: act.body.interaction_id, replayed: false, partial: false, results: [], state: { state: { seen: false, done: true, pick: null }, version: 1 } });
  await done;
  assert.equal(h.store.getState().cards.m1.version, 1);
  // Dice off: a bare roll from a script is plain text, so the viewer confirms it (no sheet warning).
  h.engine.result = (input) => ({ ok: true, state: input.state, effects: [{ type: 'say', text: '.ra I betray Bob', kind: 'ic' }], notices: [], logs: [], confirm: null, changed: false });
  done = h.store.getState().interact(ctx('m1', { dice: false }), 'go', { type: 'click' });
  await until(() => h.card('m1').confirm, 'confirm');
  assert.deepEqual(h.card('m1').confirm, { text: '.ra I betray Bob', kind: 'ic' });
  h.store.getState().answer('m1', true);
  act = await h.next('act');
  assert.deepEqual(act.body.say, { text: '.ra I betray Bob', kind: 'ic', confirmed: true });
  act.resolve({ interaction_id: act.body.interaction_id, replayed: false, partial: false, results: [], state: null });
  await done;
  // The server asks for it (an older or unaware client): its 428 says whether the sheet changes.
  done = h.store.getState().interact(ctx(), 'sanity', { type: 'click' });
  (await h.next('act')).reject(apiError(428, 'confirmation_required', { text: '.sc 1/1d6', sheet: false }));
  await until(() => h.card('m1').confirm, 'confirm 2');
  assert.deepEqual(h.card('m1').confirm, { text: '.sc 1/1d6', kind: 'ic' });
  h.store.getState().answer('m1', false);
  await done;
});
