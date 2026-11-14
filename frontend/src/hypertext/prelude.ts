// The guest prelude: evaluated in each fresh QuickJS context before the card's script. It removes eval, WeakRef and
// FinalizationRegistry, replaces Math.random, meters the built-ins that work in C without polling the interrupt
// handler (below), and defines the Script API (docs/HYPERTEXT.md) as non-writable, non-configurable globals. Its
// bookkeeping (one say, one reply, three notices, twenty logs, top-level `on`) gives the author early, readable errors
// only: a script can still forge __run's output, so effects.ts validates everything.
// Plain ES5-style JavaScript on purpose: it is identical bytes on every platform, and no host function is ever
// passed in (the engine never calls newFunction).
export const PRELUDE = String.raw`(function (g) {
  'use strict';
  var O = Object, define = O.defineProperty, freeze = O.freeze, keys = O.keys, own = O.prototype.hasOwnProperty;
  var stringify = JSON.stringify, parse = JSON.parse, isArray = Array.isArray, from = Array.from;
  var Err = Error, TypeErr = TypeError, RangeErr = RangeError, Str = String, NAME = /^[a-z][a-z0-9_]{0,31}$/, test = RegExp.prototype.test;
  var apply = Reflect.apply, gopd = O.getOwnPropertyDescriptor, proto = O.getPrototypeOf, floor = Math.floor, clz = Math.clz32;
  var AP = Array.prototype, SP = Str.prototype, RP = RegExp.prototype, slice = AP.slice, join = AP.join, cutText = SP.slice, source = gopd(RP, 'source').get;
  delete g.eval; delete g.WeakRef; delete g.FinalizationRegistry;
  function fixed(o, name, value) { define(o, name, { value: value, writable: false, configurable: false, enumerable: false }); }
  fixed(Math, 'random', function random() { throw new TypeErr("Math.random is not available: roll dice with say('.r 1d6')"); });

  // Built-ins that loop in C without polling the interrupt handler, so the step budget alone does not bound them: the
  // generic Array methods walk 'length' (which costs no memory: {length: 2 ** 53 - 1}, or a sparse array), substring
  // search is naive (haystack x needle), and repeat, padding and JSON grow with their text. Every call is charged to
  // one work budget per run before it runs (JSON.stringify after), the same on every platform; past the budget the
  // call throws a RangeError instead. Receivers and arguments are converted first, so no script code can run between
  // the charge and the built-in's own reads; an Array method refuses an array-like whose length is an accessor or an
  // object, and a non-RegExp pattern or separator is used as its string. Anything still heavy (BigInt arithmetic,
  // nested arrays in flat) is bounded by the wall clock (engine.ts and the hosts), which can depend on the device.
  var WORK = 1048576, work = 0;                                 // about 25 ms of the slowest of these on a desktop
  function charge(n, what) { if (!(n <= WORK - work)) throw new RangeErr(what + ' is too much work for an interactive message'); if (n > 0) work += n; }
  function lengthOf(o) {
    if (isArray(o) || typeof o === 'string') return o.length;
    if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return 0;
    for (var p = o; p !== null; p = proto(p)) {
      var d = gopd(p, 'length');
      if (!d) continue;
      if (!apply(own, d, ['value'])) return Infinity;
      var v = d.value;
      if (v !== null && (typeof v === 'object' || typeof v === 'function')) return Infinity;
      if (typeof v === 'symbol' || typeof v === 'bigint') return 0;
      v = +v; return v > 0 ? (v < 9007199254740991 ? floor(v) : 9007199254740991) : 0;
    }
    return 0;
  }
  function text(v) { if (typeof v === 'symbol') throw new TypeErr('cannot convert a symbol to a string'); return Str(v); }
  function isRegExp(v) { try { apply(source, v, []); return v !== RP; } catch (e) { return false; } }
  function each(list, fn) { for (var i = 0; i < list.length; i++) fn(list[i]); }
  function meter(o, name, run) {
    var f = o[name];
    if (typeof f !== 'function') return;
    var w = function () { return run(f, this, arguments, name + '()'); };
    define(w, 'name', { value: name }); define(w, 'length', { value: f.length });
    fixed(o, name, w);
  }
  each(['concat', 'copyWithin', 'every', 'fill', 'filter', 'flat', 'flatMap', 'forEach', 'includes', 'indexOf', 'join', 'lastIndexOf', 'map', 'reduce',
   'reduceRight', 'reverse', 'shift', 'slice', 'some', 'splice', 'toLocaleString', 'toReversed', 'toSpliced', 'unshift', 'with'], function (name) {
    meter(AP, name, function (f, self, args, what) {
      var n = lengthOf(self);
      if (name === 'concat') for (var i = 0; i < args.length; i++) n += args[i] !== null && (typeof args[i] === 'object' || typeof args[i] === 'function') ? lengthOf(args[i]) : 1;
      charge(n, what); return apply(f, self, args);
    });
  });
  each(['sort', 'toSorted'], function (name) {                // n log n comparisons, each a string conversion
    meter(AP, name, function (f, self, args, what) { var n = lengthOf(self); charge(n > 1 ? n * (32 - clz(n)) * 4 : n, what); return apply(f, self, args); });
  });
  function receiver(self, what) { if (self === null || self === undefined) throw new TypeErr(what + ' called on null or undefined'); return text(self); }
  each(['indexOf', 'lastIndexOf', 'includes'], function (name) {
    meter(SP, name, function (f, self, args, what) {
      var s = receiver(self, what);
      if (name === 'includes' && isRegExp(args[0])) throw new TypeErr('includes() does not take a regular expression');
      var t = text(args[0]); charge(s.length * (t.length || 1), what); return apply(f, s, [t, args[1]]);
    });
  });
  each(['split', 'replace', 'replaceAll'], function (name) {
    meter(SP, name, function (f, self, args, what) {
      var s = receiver(self, what), p = args[0];
      if (isRegExp(p) || (name === 'split' && p === undefined)) return apply(f, s, args);
      var t = text(p); charge(s.length * (t.length || 1), what); return apply(f, s, [t, args[1]]);
    });
  });
  meter(SP, 'repeat', function (f, self, args, what) { var s = receiver(self, what), n = +args[0]; charge(n > 0 ? s.length * n : 0, what); return apply(f, s, [n]); });
  each(['padStart', 'padEnd'], function (name) {
    meter(SP, name, function (f, self, args, what) { var s = receiver(self, what), n = +args[0]; charge(n > s.length ? n - s.length : 0, what); return apply(f, s, [n, args[1]]); });
  });
  meter(JSON, 'parse', function (f, self, args, what) { var t = text(args[0]); charge(t.length, what); return apply(f, JSON, [t, args[1]]); });
  meter(JSON, 'stringify', function (f, self, args, what) {
    if (work >= WORK) charge(1, what);                          // the cost is known after: refuse once spent
    var out = apply(f, JSON, args); charge(typeof out === 'string' ? out.length : 0, what); return out;
  });
  var jsonText = JSON.stringify;                              // the metered one, for log()

  var handlers = O.create(null), phase = 0;               // 0: top level, 1: inside the handler, 2: done
  var S = null, V = null, C = null, effects = [], notices = [], logs = [], says = 0, replies = 0;
  function api(name, value) { define(g, name, { value: value, writable: false, configurable: false, enumerable: false }); }
  function getter(name, get) { define(g, name, { get: get, configurable: false, enumerable: false }); }
  function inHandler(name) { if (phase !== 1) throw new Err(name + '() can only be called inside a handler'); }
  // The prelude's own work uses the captured built-ins, so a script that spent the budget still gets readable errors.
  function cut(s) {                                         // 200 code points, from at most 400 code units
    var head = s.length > 400 ? apply(cutText, s, [0, 400]) : s, cps = from(head);
    return cps.length > 200 ? apply(join, apply(slice, cps, [0, 200]), ['']) : head;
  }
  function listed(list, x) { for (var i = 0; i < list.length; i++) if (list[i] === x) return true; return false; }
  function show(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Err) return Str(v.name) + ': ' + Str(v.message);
    if (typeof v === 'function') return '[function]';
    try { var j = jsonText(v); return j === undefined ? Str(v) : j; } catch (e) { return Str(v); }
  }
  function deepFreeze(v) { if (v && typeof v === 'object') { var k = keys(v); for (var i = 0; i < k.length; i++) deepFreeze(v[k[i]]); freeze(v); } return v; }

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
    if (typeof id !== 'string' || !listed(C.replies, id)) throw new TypeErr('reply(id, slots): "' + Str(id) + '" is not one of card.replies');
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
    logs[logs.length] = cut(apply(join, parts, [' ']));
  });
  api('__logs', function __logs() { return stringify(logs); });
  api('__run', function __run(inputJson) {
    if (phase !== 0) throw new Err('__run() runs once');
    var input = parse(inputJson), ev = input.event;
    S = input.state;
    V = freeze({ gm: input.viewer.gm === true, actor: input.viewer.actor === true, character: typeof input.viewer.character === 'string' ? input.viewer.character : null });
    C = freeze({ title: input.card.title, replies: freeze(apply(slice, input.card.replies, [])) });
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
