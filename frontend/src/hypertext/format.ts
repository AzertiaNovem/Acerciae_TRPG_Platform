// Tolerant reading of a stored card (messages.hypertext). The server is the validator: it accepts only v1 and refuses
// unknown keys. A client only needs to know whether it can draw and run the card safely, so parseDoc returns a fresh,
// normalized copy (known fields only) or null for an unknown `v` or anything malformed; the message then shows its
// plain-text `content`. It never throws. Every reference is checked here (binds, act keys, reply ids, condition types),
// so bindings.ts can trust the shape.
//
// What it fills in, as the server's normalize does (so a post body reads the same as the stored card): title "",
// a value's label = its value, text style body and tone neutral, choice display list, button style primary, enum
// default null, script null, actors null, runs_per_viewer 1, closes_at null, replies [], a stub's slots {}, audience
// card and group null; act.say is kept ASCII-trimmed, as it is posted. Everything else is required.
import type { Act, Cond, Doc, EnumValue, Leaf, Node, ReplyStub, SlotDecl, StateDecl, StateValue } from './types';
import { asciiTrim, boundedText, has, isId, isObject, utf8Bytes } from './text';

export const LIMITS = {
  title: 120, stateKeys: 32, enumValues: 20, valueLen: 64, labelLen: 120, setMax: 20, textMax: 500, int: 1e9,
  nodes: 64, text: 2000, label: 120, buttonLabel: 60, submitLabel: 40, groupTitle: 80, script: 16384, actors: 10,
  runs: 100, replies: 16, slots: 4, condDepth: 3, condLeaves: 8, say: 500, stateBytes: 8192,
} as const;

const fail = (): never => { throw new Error('malformed card'); };
const need = (ok: unknown) => { if (!ok) fail(); };
const isInt = (v: unknown, lim: number = LIMITS.int): v is number => Number.isInteger(v) && Math.abs(v as number) <= lim;
const optText = (v: unknown, max: number) => v === undefined || boundedText(v, max);
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => {
  if (v === undefined) return dflt;
  need(typeof v === 'string' && (allowed as readonly string[]).includes(v)); return v as T;
};

function enumValues(v: unknown): EnumValue[] {
  need(Array.isArray(v) && v.length >= 2 && v.length <= LIMITS.enumValues);
  const seen = new Set<string>();
  return (v as unknown[]).map((x) => {
    need(isObject(x) && boundedText(x.value, LIMITS.valueLen, false, 1) && (x.label === undefined || boundedText(x.label, LIMITS.labelLen)) && !seen.has(x.value as string));
    seen.add((x as any).value); return { value: (x as any).value, label: (x as any).label ?? (x as any).value };
  });
}
function stateDecl(v: unknown): StateDecl {
  need(isObject(v)); const d = v as Record<string, unknown>;
  switch (d.type) {
    case 'bool': return { type: 'bool' };
    case 'int': {
      need(isInt(d.min) && isInt(d.max) && (d.min as number) <= (d.max as number));
      if (d.default === undefined) return { type: 'int', min: d.min as number, max: d.max as number };
      need(isInt(d.default) && (d.default as number) >= (d.min as number) && (d.default as number) <= (d.max as number));
      return { type: 'int', min: d.min as number, max: d.max as number, default: d.default as number };
    }
    case 'enum': {
      const values = enumValues(d.values);
      if (d.default === undefined || d.default === null) return { type: 'enum', values, default: null };
      need(values.some((x) => x.value === d.default)); return { type: 'enum', values, default: d.default as string };
    }
    case 'set': { const values = enumValues(d.values); need(isInt(d.max) && (d.max as number) >= 1 && (d.max as number) <= LIMITS.setMax); return { type: 'set', values, max: d.max as number }; }
    case 'text': need(isInt(d.max) && (d.max as number) >= 1 && (d.max as number) <= LIMITS.textMax); return { type: 'text', max: d.max as number };
  }
  return fail();
}

/** Whether a value fits a reply slot: a declared enum string, or an integer within the slot's range. */
export const slotOk = (d: SlotDecl, v: unknown): v is string | number =>
  d.type === 'enum' ? typeof v === 'string' && d.values.includes(v) : Number.isInteger(v) && (v as number) >= d.min && (v as number) <= d.max;

/** Whether a literal is a valid value of a declaration (also the check of validateState, per key). */
export function validValue(d: StateDecl, v: unknown): v is StateValue {
  switch (d.type) {
    case 'bool': return typeof v === 'boolean';
    case 'int': return Number.isInteger(v) && (v as number) >= d.min && (v as number) <= d.max;
    case 'enum': return v === null || (typeof v === 'string' && d.values.some((x) => x.value === v));
    case 'set': return Array.isArray(v) && v.length <= d.max && new Set(v).size === v.length && v.every((x) => typeof x === 'string' && d.values.some((y) => y.value === x));
    case 'text': return boundedText(v, d.max);
  }
}

type Decls = Record<string, StateDecl>;
const declOf = (decls: Decls, key: unknown): StateDecl => { need(isId(key) && has(decls, key as string)); return decls[key as string]; };
const isValue = (d: StateDecl, v: unknown) => d.type === 'enum' ? typeof v === 'string' && d.values.some((x) => x.value === v) : d.type === 'int' ? isInt(v) : false;

function cond(v: unknown, decls: Decls, depth: number, leaves: { n: number }): Cond {
  need(isObject(v) && depth <= LIMITS.condDepth); const c = v as Record<string, unknown>;
  const list = (x: unknown) => { need(Array.isArray(x) && (x as unknown[]).length >= 1); return (x as unknown[]).map((y) => cond(y, decls, depth + 1, leaves)); };
  if (has(c, 'all')) { need(Object.keys(c).length === 1); return { all: list(c.all) }; }
  if (has(c, 'any')) { need(Object.keys(c).length === 1); return { any: list(c.any) }; }
  if (has(c, 'not')) { need(Object.keys(c).length === 1); return { not: cond(c.not, decls, depth + 1, leaves) }; }
  need(++leaves.n <= LIMITS.condLeaves);
  const ops = Object.keys(c).filter((k) => k !== 'key'); need(ops.length === 1);
  const key = c.key as string, d = declOf(decls, key), op = ops[0], x = c[op];
  switch (op) {
    case 'eq':
      need(d.type === 'bool' ? typeof x === 'boolean' : d.type === 'int' ? isInt(x) : d.type === 'enum' ? x === null || isValue(d, x) : d.type === 'text' ? boundedText(x, d.max) : false);
      return { key, eq: x as any };
    case 'in': need((d.type === 'enum' || d.type === 'int') && Array.isArray(x) && x.length >= 1 && x.length <= LIMITS.enumValues && x.every((y) => isValue(d, y))); return { key, in: [...(x as any[])] };
    case 'has': need(d.type === 'set' && typeof x === 'string' && d.values.some((y) => y.value === x)); return { key, has: x as string };
    case 'gte': need(d.type === 'int' && isInt(x)); return { key, gte: x as number };
    case 'lte': need(d.type === 'int' && isInt(x)); return { key, lte: x as number };
    case 'empty': need((d.type === 'text' || d.type === 'set' || d.type === 'enum') && typeof x === 'boolean'); return { key, empty: x as boolean };
  }
  return fail();
}

function slotDecl(v: unknown): SlotDecl {
  need(isObject(v)); const s = v as Record<string, unknown>;
  if (s.type === 'int') { need(isInt(s.min) && isInt(s.max) && (s.min as number) <= (s.max as number)); return { type: 'int', min: s.min as number, max: s.max as number }; }
  need(s.type === 'enum' && Array.isArray(s.values) && s.values.length >= 1 && s.values.length <= LIMITS.enumValues && s.values.every((x) => boundedText(x, LIMITS.valueLen, false, 1)));
  return { type: 'enum', values: [...(s.values as string[])] };
}
function replyStub(v: unknown): ReplyStub {
  need(isObject(v)); const r = v as Record<string, unknown>;
  need(isId(r.id) && (r.slots === undefined || isObject(r.slots)));
  const slots: Record<string, SlotDecl> = {};
  const names = Object.keys((r.slots ?? {}) as object); need(names.length <= LIMITS.slots);
  for (const k of names) { need(isId(k)); slots[k] = slotDecl((r.slots as any)[k]); }
  need(r.group === undefined || r.group === null || isId(r.group));
  return { id: r.id as string, slots, audience: pick(r.audience, ['card', 'viewer', 'gm'] as const, 'card'), group: (r.group as string | undefined) ?? null };
}

function act(v: unknown, decls: Decls, replies: ReplyStub[]): Act {
  need(isObject(v)); const a = v as Record<string, unknown>, out: Act = {};
  if (a.set !== undefined) {
    need(isObject(a.set)); out.set = {};
    for (const k of Object.keys(a.set as object)) { const x = (a.set as any)[k]; need(validValue(declOf(decls, k), x)); out.set[k] = Array.isArray(x) ? [...x] : x; }
  }
  // Checked and kept as posted: ASCII-trimmed, as the server checks it (sayError) and the say is posted.
  if (a.say !== undefined) { need(typeof a.say === 'string' && boundedText(asciiTrim(a.say), LIMITS.say, true, 1)); out.say = asciiTrim(a.say as string); }
  if (a.say_kind !== undefined) { need(a.say !== undefined); out.say_kind = pick(a.say_kind, ['ic', 'ooc'] as const, 'ic'); }
  if (a.reply !== undefined) {
    const stub = replies.find((r) => r.id === a.reply); need(stub);
    // Each slot is filled from the state key of the same name.
    for (const k of Object.keys(stub!.slots)) { const d = declOf(decls, k), s = stub!.slots[k]; need(s.type === 'int' ? d.type === 'int' : d.type === 'enum'); }
    out.reply = a.reply as string;
  }
  need(out.set || out.say !== undefined || out.reply);
  return out;
}

function node(v: unknown, decls: Decls, replies: ReplyStub[], level: 0 | 1 | 2, ids: Set<string>, count: { n: number }): Node {
  need(isObject(v) && ++count.n <= LIMITS.nodes); const n = v as Record<string, unknown>;
  const base: { id?: string; show_if?: Cond } = {};
  if (n.id !== undefined) { need(isId(n.id) && !ids.has(n.id as string)); ids.add(n.id as string); base.id = n.id as string; }
  if (n.show_if !== undefined) base.show_if = cond(n.show_if, decls, 1, { n: 0 });
  const control = () => {
    need(base.id !== undefined);
    const c: { id: string; show_if?: Cond; enable_if?: Cond; on?: string } = { ...base, id: base.id! };
    if (n.enable_if !== undefined) c.enable_if = cond(n.enable_if, decls, 1, { n: 0 });
    if (n.on !== undefined) { need(isId(n.on)); c.on = n.on as string; }
    return c;
  };
  const bound = (types: StateDecl['type'][]) => { const d = declOf(decls, n.bind); need(types.includes(d.type)); return d; };
  const children = (lv: 1 | 2) => { need(Array.isArray(n.children)); return (n.children as unknown[]).map((c) => node(c, decls, replies, lv, ids, count)); };
  switch (n.type) {
    case 'text':
      need(boundedText(n.text, LIMITS.text, true));
      return { ...base, type: 'text', text: n.text as string, style: pick(n.style, ['body', 'muted', 'heading', 'strong'] as const, 'body'), tone: pick(n.tone, ['neutral', 'good', 'bad', 'warn'] as const, 'neutral') };
    case 'divider': return { ...base, type: 'divider' };
    case 'checkbox': { const c = control(); bound(['bool']); need(boundedText(n.label, LIMITS.label)); return { ...c, type: 'checkbox', label: n.label as string, bind: n.bind as string }; }
    case 'choice': {
      const c = control(), d = bound(['enum', 'set']) as Extract<StateDecl, { values: EnumValue[] }>;
      need(optText(n.label, LIMITS.label));
      const out: Leaf = { ...c, type: 'choice', bind: n.bind as string, display: pick(n.display, ['list', 'buttons', 'menu'] as const, 'list') };
      if (n.label !== undefined) out.label = n.label as string;
      if (n.options !== undefined) {
        need(Array.isArray(n.options) && n.options.length >= 1 && new Set(n.options).size === n.options.length && n.options.every((o) => d.values.some((x) => x.value === o)));
        out.options = [...(n.options as string[])];
      }
      return out;
    }
    case 'input': {
      const c = control(); bound(['text']);
      need(optText(n.label, LIMITS.label) && optText(n.placeholder, LIMITS.label) && optText(n.submit_label, LIMITS.submitLabel));
      const out: Leaf = { ...c, type: 'input', bind: n.bind as string };
      if (n.label !== undefined) out.label = n.label as string;
      if (n.placeholder !== undefined) out.placeholder = n.placeholder as string;
      if (n.submit_label !== undefined) out.submit_label = n.submit_label as string;
      return out;
    }
    case 'button': {
      const c = control(); need(boundedText(n.label, LIMITS.buttonLabel) && (c.on === undefined) !== (n.act === undefined));
      const out: Leaf = { ...c, type: 'button', label: n.label as string, style: pick(n.style, ['primary', 'secondary', 'danger'] as const, 'primary') };
      if (n.act !== undefined) out.act = act(n.act, decls, replies);
      return out;
    }
    case 'row': need(level < 2); return { ...base, type: 'row', children: children(2) as Leaf[] };
    case 'group': {
      need(level === 0 && optText(n.title, LIMITS.groupTitle));
      const out: Node = { ...base, type: 'group', children: children(1) as (Leaf | Extract<Node, { type: 'row' }>)[] };
      if (n.title !== undefined) out.title = n.title as string;
      return out;
    }
  }
  return fail();
}

export function parseDoc(raw: unknown): Doc | null {
  try {
    need(isObject(raw)); const r = raw as Record<string, unknown>;
    need(r.v === 1 && (r.title === undefined || boundedText(r.title, LIMITS.title)));
    need(r.state === undefined || isObject(r.state));
    const decls: Decls = {}, keys = Object.keys((r.state ?? {}) as object);
    need(keys.length <= LIMITS.stateKeys);
    for (const k of keys) { need(isId(k)); decls[k] = stateDecl((r.state as any)[k]); }
    need(r.replies === undefined || (Array.isArray(r.replies) && r.replies.length <= LIMITS.replies));
    const replies = ((r.replies ?? []) as unknown[]).map(replyStub);
    need(new Set(replies.map((x) => x.id)).size === replies.length);
    need(Array.isArray(r.body) && (r.body as unknown[]).length >= 1);
    const ids = new Set<string>(), count = { n: 0 };
    const body = (r.body as unknown[]).map((n) => node(n, decls, replies, 0, ids, count));
    need(r.script === undefined || r.script === null || (typeof r.script === 'string' && utf8Bytes(r.script) <= LIMITS.script));
    need(r.actors === undefined || r.actors === null || (Array.isArray(r.actors) && r.actors.length <= LIMITS.actors && r.actors.every((a) => typeof a === 'string')));
    need(r.runs_per_viewer === undefined || (isInt(r.runs_per_viewer) && (r.runs_per_viewer as number) >= 1 && (r.runs_per_viewer as number) <= LIMITS.runs));
    need(r.closes_at === undefined || r.closes_at === null || typeof r.closes_at === 'string');
    return {
      v: 1, title: (r.title as string | undefined) ?? '', state: decls, body, script: (r.script as string | undefined) || null,
      actors: r.actors ? [...(r.actors as string[])] : null, runs_per_viewer: (r.runs_per_viewer as number | undefined) ?? 1,
      closes_at: (r.closes_at as string | undefined) ?? null, replies,
    };
  } catch { return null; }
}

/** Every node, depth first in document order. */
export function walk(body: Node[], visit: (n: Node, depth: number) => void, depth = 0) {
  for (const n of body) { visit(n, depth); if (n.type === 'row' || n.type === 'group') walk(n.children, visit, depth + 1); }
}
export function findNode(doc: Doc, id: string): Node | null {
  let found: Node | null = null;
  walk(doc.body, (n) => { if (!found && n.id === id) found = n; });
  return found;
}
/** Whether any control runs a script handler (only such cards ever start the engine). */
export const scripted = (doc: Doc) => { let s = false; walk(doc.body, (n) => { if ((n as { on?: string }).on) s = true; }); return s && !!doc.script; };
