const test = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, shared, sharedPath, docOf } = require('./hypertext-harness.cjs');
// Interactive messages: the pure card logic (src/hypertext/bindings.ts, text.ts, format.ts, dice.ts) over the client
// fixture (mobile/contracts/fixtures/hypertext-client.json) and, once the backend phase has written it, the sections of
// the shared fixture hypertext.json that every platform reads.
const { parseDoc, LIMITS } = load('format');
const B = load('bindings');
const T = load('text');
const { parseCommand, verdict } = load('dice');

const docs = Object.fromEntries(Object.entries(fixture.docs).map(([k, d]) => [k, parseDoc(d)]));
const project = (r) => {
  const o = { type: r.node.type, id: r.node.id ?? null };
  for (const k of ['text', 'label', 'caption', 'value', 'options']) if (r[k] !== undefined) o[k] = r[k];
  o.visible = r.visible; o.disabled = r.disabled;
  return o;
};

test('the fixture documents parse, and parsing keeps known fields only', () => {
  for (const [k, d] of Object.entries(docs)) assert.ok(d, k);
  assert.equal(docs.study.body[0].style, 'heading');
  assert.equal(docs.small.body[0].style, 'body');
  assert.equal(docs.small.body[2].style, 'primary');
  assert.equal(docs.small.runs_per_viewer, 1);
  assert.deepEqual(parseDoc({ ...fixture.docs.small, extra: { x: 1 } }), docs.small);
});

test('bindings: applyAction over the fixture', () => {
  assert.ok(fixture.bindings.length >= 20);
  for (const c of fixture.bindings) assert.deepEqual(B.applyAction(docs[c.doc], c.state, c.node, c.action), c.expect, c.name);
});

test('resolve over the fixture, every lock reason', () => {
  const reasons = new Set(fixture.resolve.map((c) => c.lock.reason));
  for (const r of [null, 'closed', 'recalled', 'not_actor', 'spectator', 'history', 'archived', 'paused', 'loading']) assert.ok(reasons.has(r), String(r));
  for (const c of fixture.resolve) assert.deepEqual(B.resolve(docs[c.doc], c.state, c.lock).map(project), c.expect, c.name);
});

test('act over the fixture', () => {
  for (const c of fixture.act) assert.deepEqual(B.act(docs[c.doc], c.state, c.node), c.expect, c.name);
});

test('defaults, overlay and validateState', () => {
  const d = docs.study;
  assert.deepEqual(B.defaultState(d), { done: false, lamp: false, count: 2, path: null, tools: [], note: '' });
  assert.deepEqual(B.overlay(d, null), B.defaultState(d));
  assert.deepEqual(B.overlay(d, { count: 9, path: 'window', tools: ['key', 'key'], note: 'ok', lamp: 'yes', other: 1 }),
    { done: false, lamp: false, count: 2, path: 'window', tools: [], note: 'ok' });
  // Untrusted stored keys never reach Object.prototype.
  const stored = JSON.parse('{"__proto__": {"lamp": true}, "constructor": 1, "done": true}');
  assert.deepEqual(B.overlay(d, stored), { ...B.defaultState(d), done: true });
  assert.equal({}.lamp, undefined);
  assert.equal(B.validateState(d, B.defaultState(d)).ok, true);
  assert.equal(B.validateState(d, { ...B.defaultState(d), tools: ['rope', 'lamp', 'key'] }).ok, false);
  assert.equal(B.validateState(d, { ...B.defaultState(d), note: '\u2066x' }).ok, false);
  assert.equal(B.validateState(d, { ...B.defaultState(d), count: 1.5 }).ok, false);
  assert.equal(B.validateState(d, { ...B.defaultState(d), extra: 1 }).ok, false);
  const { done, ...partial } = B.defaultState(d); void done;
  assert.equal(B.validateState(d, partial).ok, false);
  assert.equal(B.validateState(d, [1]).ok, false);
  // At most 8 KiB serialized: five texts of 500 four-byte code points are each valid but too large together.
  const big = parseDoc({ v: 1, title: 'Big', state: Object.fromEntries(['t0', 't1', 't2', 't3', 't4'].map((k) => [k, { type: 'text', max: 500 }])), body: [{ type: 'input', id: 'i', bind: 't0' }] });
  const four = { t0: '', t1: '😀'.repeat(500), t2: '😀'.repeat(500), t3: '😀'.repeat(500), t4: '😀'.repeat(500) };
  assert.equal(B.validateState(big, four).ok, true);
  assert.equal(B.validateState(big, { ...four, t0: '😀'.repeat(500) }).ok, false);
  assert.equal(B.applyAction(big, four, 'i', { type: 'submit', value: '😀'.repeat(500) }), null);
  assert.equal(B.applyAction(big, four, 'i', { type: 'submit', value: 'short' }).state.t0, 'short');
});

test('conditions and interpolation', () => {
  const d = docs.study, s = { done: false, lamp: true, count: 3, path: 'door', tools: ['rope'], note: '' };
  const ev = (c) => B.evalCondition(c, d, s);
  assert.equal(ev({ key: 'lamp', eq: true }), true);
  assert.equal(ev({ key: 'path', eq: null }), false);
  assert.equal(ev({ key: 'path', in: ['window', 'door'] }), true);
  assert.equal(ev({ key: 'tools', has: 'rope' }), true);
  assert.equal(ev({ key: 'count', gte: 3 }), true);
  assert.equal(ev({ key: 'count', lte: 2 }), false);
  assert.equal(ev({ key: 'note', empty: true }), true);
  assert.equal(ev({ key: 'tools', empty: true }), false);
  assert.equal(ev({ all: [{ key: 'lamp', eq: true }, { not: { key: 'done', eq: true } }] }), true);
  assert.equal(ev({ any: [{ key: 'lamp', eq: false }, { key: 'count', eq: 4 }] }), false);
  assert.equal(ev({ key: 'constructor', eq: 1 }), false);
  assert.equal(B.interpolate('{{path}}/{{tools}}/{{count}}/{{note}}/{{lamp}}/{{nope}}/{{ path }}', d, s), 'The door/Rope/3//{{lamp}}/{{nope}}/{{ path }}');
  assert.equal(B.interpolate('{{tools}}', d, { ...s, tools: ['key', 'rope'] }), 'Rope, Key');
  assert.equal(B.interpolate('{{count}}', d, { ...s, count: -0 }), '0');
});

test('text rules: code points, refused characters, trimming, ids', () => {
  assert.equal(T.cpLength('a😀é'), 3);
  assert.equal(T.cpPrefix('😀😀😀', 2), '😀😀');
  assert.equal(T.utf8Bytes('aé😀中'), 1 + 2 + 4 + 3);
  assert.equal(T.utf8Bytes('\ud800'), 3);
  for (const bad of ['\u0000', '\t', '\r', '\u001f', '\u202a', '\u202e', '\u2066', '\u2069', '\ud800', 'x\udc00', '\ufdd0', '\ufffe', '\uffff', '\ud83f\udffe']) assert.equal(T.textOk('a' + bad), false, JSON.stringify(bad));
  for (const good of ['plain', '中文 😀', '\u007f', '\u200f', '😀', 'é']) assert.equal(T.textOk(good), true, JSON.stringify(good));
  assert.equal(T.textOk('a\nb'), false);
  assert.equal(T.textOk('a\nb', true), true);
  assert.equal(T.sanitize('a\u202eb\ud800c'), 'a\ufffdb\ufffdc');
  assert.equal(T.asciiTrim(' \t\n.r 1d6\v\f\r '), '.r 1d6');
  assert.equal(T.asciiTrim('\u3000.r\u00a0'), '\u3000.r\u00a0');
  for (const id of ['a', 'roll_2', 'a'.repeat(32)]) assert.equal(T.isId(id), true, id);
  for (const id of ['', 'A', '1a', '_a', 'a-b', 'a'.repeat(33), '__proto__', 'constructor', 'valueof', 'tostring', 'hasownproperty', 'isprototypeof', 'propertyisenumerable', 'tolocalestring', 'toString', 5, null]) assert.equal(T.isId(id), false, String(id));
  assert.equal(T.has({}, 'toString'), false);
  assert.equal(T.has(JSON.parse('{"__proto__":1}'), '__proto__'), true);
});

test('format: malformed or unknown documents are null, never a throw', () => {
  const base = fixture.docs.small;
  const body = (b) => ({ ...base, body: b });
  const state = (s) => ({ ...base, state: s });
  const malformed = {
    'not an object': 'card', array: [base], null: null,
    'unknown version': { ...base, v: 2 }, 'version as a string': { ...base, v: '1' },
    'missing title': { ...base, title: undefined }, 'title too long': { ...base, title: 'x'.repeat(121) }, 'bidi in the title': { ...base, title: 'a\u202eb' },
    'empty body': body([]), 'body not a list': body({}),
    'a __proto__ key': JSON.parse('{"v":1,"title":"x","state":{"__proto__":{"type":"bool"}},"body":[{"type":"divider"}]}'),
    'a constructor key': state({ constructor: { type: 'bool' } }), 'a valueof key': state({ valueof: { type: 'bool' } }),
    'an uppercase key': state({ Seen: { type: 'bool' } }),
    'too many keys': state(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, { type: 'bool' }]))),
    'unknown state type': state({ seen: { type: 'float' } }),
    'int bounds reversed': state({ seen: { type: 'int', min: 2, max: 1 } }), 'int beyond 1e9': state({ seen: { type: 'int', min: 0, max: 1e9 + 1 } }),
    'int default out of range': state({ seen: { type: 'int', min: 0, max: 3, default: 4 } }),
    'enum with one value': state({ seen: { type: 'enum', values: [{ value: 'a', label: 'A' }] } }),
    'enum duplicate values': state({ seen: { type: 'enum', values: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] } }),
    'enum default not declared': state({ seen: { type: 'enum', values: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'c' } }),
    'set max 0': state({ seen: { type: 'set', values: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], max: 0 } }),
    'text max 501': state({ seen: { type: 'text', max: 501 } }),
    'unknown node type': body([{ type: 'image', id: 'i' }]),
    'duplicate node ids': body([{ type: 'checkbox', id: 'a', label: 'A', bind: 'seen' }, { type: 'checkbox', id: 'a', label: 'B', bind: 'seen' }]),
    'control without an id': body([{ type: 'checkbox', label: 'A', bind: 'seen' }]),
    'bind to an undeclared key': body([{ type: 'checkbox', id: 'a', label: 'A', bind: 'gone' }]),
    'bind to a prototype name': body([{ type: 'checkbox', id: 'a', label: 'A', bind: 'constructor' }]),
    'checkbox bound to a text': { ...base, state: { t: { type: 'text', max: 5 } }, body: [{ type: 'checkbox', id: 'a', label: 'A', bind: 't' }] },
    'button with on and act': body([{ type: 'button', id: 'b', label: 'B', on: 'x', act: { say: 'hi' } }]),
    'button with neither': body([{ type: 'button', id: 'b', label: 'B' }]),
    'button label over 60': body([{ type: 'button', id: 'b', label: 'x'.repeat(61), on: 'x' }]),
    'act with nothing': body([{ type: 'button', id: 'b', label: 'B', act: {} }]),
    'act set of the wrong type': body([{ type: 'button', id: 'b', label: 'B', act: { set: { seen: 1 } } }]),
    'act reply not declared': body([{ type: 'button', id: 'b', label: 'B', act: { reply: 'nope' } }]),
    'act say_kind narration': body([{ type: 'button', id: 'b', label: 'B', act: { say: 'x', say_kind: 'narration' } }]),
    'act say over 500': body([{ type: 'button', id: 'b', label: 'B', act: { say: 'x'.repeat(501) } }]),
    'a row inside a row': body([{ type: 'row', children: [{ type: 'row', children: [] }] }]),
    'a group inside a group': body([{ type: 'group', children: [{ type: 'group', children: [] }] }]),
    'a group inside a row': body([{ type: 'row', children: [{ type: 'group', children: [] }] }]),
    'more than 64 nodes': body(Array.from({ length: 65 }, () => ({ type: 'divider' }))),
    'condition on an undeclared key': body([{ type: 'divider', show_if: { key: 'gone', eq: true } }]),
    'condition of the wrong type': body([{ type: 'divider', show_if: { key: 'seen', eq: 1 } }]),
    'condition with two operators': body([{ type: 'divider', show_if: { key: 'seen', eq: true, empty: true } }]),
    'unknown condition operator': body([{ type: 'divider', show_if: { key: 'seen', like: true } }]),
    'condition deeper than 3': body([{ type: 'divider', show_if: { not: { not: { not: { key: 'seen', eq: true } } } } }]),
    'more than 8 leaves': body([{ type: 'divider', show_if: { any: Array.from({ length: 9 }, () => ({ key: 'seen', eq: true })) } }]),
    'has on a bool': body([{ type: 'text', text: 'x', show_if: { key: 'seen', has: 'a' } }]),
    'enable_if on a control of the wrong type': body([{ type: 'checkbox', id: 'a', label: 'A', bind: 'seen', enable_if: { key: 'seen', gte: 1 } }]),
    'choice options not declared': { ...base, state: { p: { type: 'enum', values: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } }, body: [{ type: 'choice', id: 'c', bind: 'p', options: ['c'] }] },
    'script over 16 KiB': { ...base, script: 'x'.repeat(16385) },
    'runs_per_viewer 0': { ...base, runs_per_viewer: 0 }, 'runs_per_viewer 101': { ...base, runs_per_viewer: 101 },
    'more than 10 actors': { ...base, actors: Array.from({ length: 11 }, (_, i) => String(i)) },
    'reply stub with a bad slot': { ...base, replies: [{ id: 'r', slots: { n: { type: 'int', min: 3, max: 1 } } }] },
    'duplicate reply stubs': { ...base, replies: [{ id: 'r', slots: {} }, { id: 'r', slots: {} }] },
    'a getter that throws': Object.defineProperty({ ...base }, 'title', { get() { throw Error('boom'); }, enumerable: true }),
  };
  for (const [name, raw] of Object.entries(malformed)) assert.equal(parseDoc(raw), null, name);
  assert.equal({}.type, undefined);
  // Accepted: the same documents written correctly.
  assert.ok(parseDoc(body([{ type: 'row', children: [{ type: 'text', text: 'a' }, { type: 'checkbox', id: 'a', label: 'A', bind: 'seen', enable_if: { key: 'seen', eq: false } }] }])));
  assert.ok(parseDoc(body([{ type: 'divider', show_if: { not: { not: { key: 'seen', eq: true } } } }])));
  assert.ok(parseDoc({ ...base, script: 'é'.repeat(8192), closes_at: '2026-11-21T00:00:00Z', actors: ['c1'], runs_per_viewer: 100 }));
  assert.equal(LIMITS.nodes, 64);
});

// Dice: a mirror of dice::parseCommand (backend/src/dice/Dice.cpp). hypertext::diceVerdict in C++ is authoritative;
// the shared fixture's dice_policy pins both (run below when hypertext.json exists).
test('dice: parseCommand mirrors the server literals, their order and the next-character rule', () => {
  const cases = [
    ['.r', 'r', ''], ['.r1d6', 'r', '1d6'], ['.rd20', 'r', 'd20'], ['.RD20', 'r', 'D20'], ['.rh', 'r', '', true], ['.rh 1d4', 'r', '1d4', true],
    ['.ra Spot Hidden', 'ra', 'Spot Hidden'], ['.RA spot', 'ra', 'spot'], ['.rah Listen', 'ra', 'Listen', true], ['.rch', 'ra', '', true], ['.rc 50', 'ra', '50'],
    ['.ri', 'ri', ''], ['.rih', 'ri', '', true], ['.ri+3', 'ri', '+3'], ['.sc 1/1d6', 'sc', '1/1d6'], ['.st STR 50', 'st', 'STR 50'], ['.en Library', 'en', 'Library'],
    ['.ds', 'ds', ''], ['.ss', 'ss', ''], ['.init', 'init', ''], ['.move 3', 'move', '3'], ['。ra 侦查', 'ra', '侦查'], ['．r', 'r', ''],
    ['  .r 2d6  ', 'r', '2d6'], ['.ra侦查', 'ra', '侦查'], ['.r(1d6)', 'r', '(1d6)'], ['.r%', 'r', '%'], ['.r#2', 'r', '#2'], ['.r/2', 'r', '/2'], ['.r-1', 'r', '-1'],
    ['.ra\tx', 'ra', 'x'], ['.ri\u0000', 'ri', '\u0000'],
  ];
  for (const [text, name, args, hidden = false] of cases) {
    const c = parseCommand(text);
    assert.ok(c, text); assert.equal(c.name, name, text); assert.equal(c.args, args, text); assert.equal(c.hidden, hidden, text);
  }
  for (const text of ['', '.', '。', 'r', '..r', '\u3000.r', '.rx', '.rcx', '.rhx', '.rend', '.endurance', '.inita', '.stx', '.r\u000bx', 'hello .r', '.Ｒ']) assert.equal(parseCommand(text), null, JSON.stringify(text));
  assert.equal(parseCommand('.rah').raw, '.rah');
});

test('dice: the policy for lines posted as the clicker', () => {
  const policy = {
    allowed: ['.r', '.rh', '.r 1d100', '.ra Spot Hidden', '.rc 50', '.rah', '.rch', '.ri', '.rih', '.ri +2', '.ri -1 +3', '.ri+1', '.RI +10', '。ri', '.ri +9999'],
    confirm: ['.sc 1/1d6', '.ds', '．SC'],
    refused: ['.ri Bob', '.ri 3', '.ri +12345', '.ri +2 Bob', '.rih Alice', '.st STR 50', '.en', '.ss', '.init', '.move', '.MOVE 2'],
    none: ['hello', 'I open the door.', '.rx', '', '。', '. r', '.resume'],
  };
  for (const [v, texts] of Object.entries(policy)) for (const t of texts) assert.equal(verdict(t), v, JSON.stringify(t));
});

// The shared fixture (written by the backend phase) pins the logic every platform shares. Its cases are read
// leniently: a section is a list, or {cases: [...]}, or (dice_policy) a map of text to verdict.
const sectionCases = (s) => Array.isArray(s) ? s : Array.isArray(s?.cases) ? s.cases : s && typeof s === 'object' ? Object.entries(s).filter(([k]) => !k.startsWith('_')).map(([text, expect]) => ({ text, expect })) : [];
const pickField = (c, names, what) => {
  for (const n of names) if (c[n] !== undefined) return c[n];
  assert.fail(`hypertext.json ${what}: unrecognised case ${JSON.stringify(c).slice(0, 200)}`);
};
const sharedDoc = (c) => { const d = parseDoc(docOf(c, shared.docs ?? {})); assert.ok(d, `hypertext.json: the document of ${c.name ?? JSON.stringify(c).slice(0, 80)} does not parse`); return d; };
const sharedCase = (section, run) => (t) => {
  if (!shared) { t.skip(`${sharedPath} is not there yet (written by the backend phase)`); return; }
  if (!shared[section]) { t.skip(`hypertext.json has no ${section}`); return; }
  const cases = sectionCases(shared[section]);
  assert.ok(cases.length, section);
  for (const c of cases) run(c);
};
test('shared fixture: defaults', sharedCase('defaults', (c) => {
  assert.deepEqual(B.defaultState(sharedDoc(c)), pickField(c, ['expect', 'state', 'defaults', 'default'], 'defaults'), c.name);
}));
test('shared fixture: state_validation', sharedCase('state_validation', (c) => {
  const ok = c.ok ?? c.valid ?? (typeof c.expect === 'boolean' ? c.expect : c.expect?.ok) ?? (c.error !== undefined ? false : undefined);
  assert.equal(typeof ok, 'boolean', `hypertext.json state_validation: unrecognised case ${JSON.stringify(c).slice(0, 200)}`);
  assert.equal(B.validateState(sharedDoc(c), c.state).ok, ok, c.name ?? JSON.stringify(c.state));
}));
test('shared fixture: conditions', sharedCase('conditions', (c) => {
  const d = sharedDoc(c);
  assert.equal(B.evalCondition(pickField(c, ['cond', 'condition', 'if'], 'conditions'), d, B.overlay(d, c.state)), pickField(c, ['expect', 'result', 'value'], 'conditions'), c.name);
}));
test('shared fixture: interpolation', sharedCase('interpolation', (c) => {
  const d = sharedDoc(c);
  assert.equal(B.interpolate(pickField(c, ['text', 'template', 'input'], 'interpolation'), d, B.overlay(d, c.state)), pickField(c, ['expect', 'result', 'output'], 'interpolation'), c.name);
}));
test('shared fixture: dice_policy', sharedCase('dice_policy', (c) => {
  const text = pickField(c, ['text', 'input', 'command', 'line'], 'dice_policy');
  assert.equal(verdict(text), pickField(c, ['verdict', 'expect', 'policy', 'result'], 'dice_policy'), JSON.stringify(text));
}));
