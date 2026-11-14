// The guest prelude: evaluated in each fresh QuickJS context before the card's script. It removes eval, WeakRef and
// FinalizationRegistry, replaces Math.random, and defines the Script API (docs/HYPERTEXT.md) as non-writable,
// non-configurable globals. Its bookkeeping (one say, one reply, three notices, twenty logs, top-level `on`) gives the
// author early, readable errors only: a script can still forge __run's output, so effects.ts validates everything.
// Plain ES5-style JavaScript on purpose: it is identical bytes on every platform, and no host function is ever
// passed in (the engine never calls newFunction).
export const PRELUDE = String.raw`(function (g) {
  'use strict';
  var O = Object, define = O.defineProperty, freeze = O.freeze, keys = O.keys, own = O.prototype.hasOwnProperty;
  var stringify = JSON.stringify, parse = JSON.parse, isArray = Array.isArray, from = Array.from;
  var Err = Error, TypeErr = TypeError, Str = String, NAME = /^[a-z][a-z0-9_]{0,31}$/, test = RegExp.prototype.test;
  delete g.eval; delete g.WeakRef; delete g.FinalizationRegistry;
  define(Math, 'random', { value: function random() { throw new TypeErr("Math.random is not available: roll dice with say('.r 1d6')"); }, writable: false, configurable: false, enumerable: false });

  var handlers = O.create(null), phase = 0;               // 0: top level, 1: inside the handler, 2: done
  var S = null, V = null, C = null, effects = [], notices = [], logs = [], says = 0, replies = 0;
  function api(name, value) { define(g, name, { value: value, writable: false, configurable: false, enumerable: false }); }
  function getter(name, get) { define(g, name, { get: get, configurable: false, enumerable: false }); }
  function inHandler(name) { if (phase !== 1) throw new Err(name + '() can only be called inside a handler'); }
  function cut(s) { var cps = from(s); return cps.length > 200 ? cps.slice(0, 200).join('') : s; }
  function show(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Err) return Str(v.name) + ': ' + Str(v.message);
    if (typeof v === 'function') return '[function]';
    try { var j = stringify(v); return j === undefined ? Str(v) : j; } catch (e) { return Str(v); }
  }
  function deepFreeze(v) { if (v && typeof v === 'object') { keys(v).forEach(function (k) { deepFreeze(v[k]); }); freeze(v); } return v; }

  api('on', function on(name, fn) {
    if (phase !== 0) throw new Err('on() can only be called at the top level of the script');
    if (typeof name !== 'string' || !test.call(NAME, name)) throw new TypeErr('on(name, fn): name must match ^[a-z][a-z0-9_]{0,31}$');
    if (typeof fn !== 'function') throw new TypeErr('on(name, fn): fn must be a function');
    if (own.call(handlers, name)) throw new Err('on(): a handler named "' + name + '" is already registered');
    handlers[name] = fn;
  });
  getter('state', function () { return S; });
  getter('viewer', function () { return V; });
  getter('card', function () { return C; });
  api('say', function say(text, kind) {
    inHandler('say');
    if (kind === undefined) kind = 'ic';
    if (typeof text !== 'string') throw new TypeErr('say(text, kind): text must be a string');
    if (kind !== 'ic' && kind !== 'ooc') throw new TypeErr("say(text, kind): kind must be 'ic' or 'ooc'");
    if (says++) throw new Err('say() can only be called once per action');
    effects[effects.length] = { type: 'say', text: text, kind: kind };
  });
  api('reply', function reply(id, slots) {
    inHandler('reply');
    if (slots === undefined) slots = {};
    if (typeof id !== 'string' || C.replies.indexOf(id) < 0) throw new TypeErr('reply(id, slots): "' + Str(id) + '" is not one of card.replies');
    if (!slots || typeof slots !== 'object' || isArray(slots)) throw new TypeErr('reply(id, slots): slots must be an object');
    if (replies++) throw new Err('reply() can only be called once per action');
    effects[effects.length] = { type: 'reply', id: id, slots: parse(stringify(slots)) };
  });
  api('notify', function notify(text) {
    inHandler('notify');
    if (typeof text !== 'string') throw new TypeErr('notify(text): text must be a string');
    if (notices.length >= 3) throw new Err('notify() can only be called 3 times per action');
    notices[notices.length] = text;
  });
  api('log', function log() {
    if (logs.length >= 20) return;
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts[i] = show(arguments[i]);
    logs[logs.length] = cut(parts.join(' '));
  });
  api('__logs', function __logs() { return stringify(logs); });
  api('__run', function __run(inputJson) {
    if (phase !== 0) throw new Err('__run() runs once');
    var input = parse(inputJson), ev = input.event;
    S = input.state;
    V = freeze({ gm: input.viewer.gm === true, actor: input.viewer.actor === true, character: typeof input.viewer.character === 'string' ? input.viewer.character : null });
    C = freeze({ title: input.card.title, replies: freeze(input.card.replies.slice()) });
    if (!own.call(handlers, input.handler)) { phase = 2; return stringify({ ok: false, error: { code: 'no_handler', message: 'no handler named "' + Str(input.handler) + '": add on("' + Str(input.handler) + '", fn)' }, logs: logs }); }
    var fn = handlers[input.handler];
    phase = 1;
    var result = fn(deepFreeze({ type: ev.type, node: ev.node, value: ev.value }));
    phase = 2;
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
      return stringify({ ok: false, error: { code: 'script_error', message: 'handlers must be synchronous' }, logs: logs });
    }
    return stringify({ ok: true, state: S, effects: effects, notices: notices, logs: logs });
  });
})(globalThis);
`;
