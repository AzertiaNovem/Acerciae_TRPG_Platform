// The pure logic of a card, run natively on every client (no JavaScript engine): default and stored state, the
// binding of each control, conditions, interpolation, what is drawn, and declarative button actions. Ported to
// Kotlin (core/Hypertext.kt) and Swift (AcerciaeCore/Hypertext.swift) and pinned by the fixtures
// mobile/contracts/fixtures/hypertext.json (shared with C++) and hypertext-client.json, so keep it small and explicit.
import type { Action, Cond, Doc, Effect, HxEvent, Lock, Node, Resolved, ResolvedOption, State, StateDecl, StateValue } from './types';
import { LIMITS, findNode, validValue } from './format';
import { has, isObject, utf8Bytes } from './text';

const copy = (v: StateValue): StateValue => Array.isArray(v) ? [...v] : v;
const copyState = (s: State): State => { const out: State = {}; for (const k of Object.keys(s)) out[k] = copy(s[k]); return out; };

export function defaultOf(d: StateDecl): StateValue {
  switch (d.type) {
    case 'bool': return false;
    case 'int': return d.default ?? d.min;
    case 'enum': return d.default ?? null;
    case 'set': return [];
    case 'text': return '';
  }
}
export function defaultState(doc: Doc): State {
  const s: State = {};
  for (const k of Object.keys(doc.state)) s[k] = defaultOf(doc.state[k]);
  return s;
}
/** A stored state laid over the defaults: undeclared keys are dropped, a bad value falls back to its default. */
export function overlay(doc: Doc, stored: unknown): State {
  const s = defaultState(doc);
  if (!isObject(stored)) return s;
  for (const k of Object.keys(s)) if (has(stored, k) && validValue(doc.state[k], stored[k])) s[k] = copy(stored[k] as StateValue);
  return s;
}

/** Exactly the declared keys, each a valid value, at most 8 KiB serialized. */
export function validateState(doc: Doc, state: unknown): { ok: true } | { ok: false; error: string } {
  if (!isObject(state)) return { ok: false, error: 'state must be an object' };
  for (const k of Object.keys(state)) if (!has(doc.state, k)) return { ok: false, error: `state.${k.slice(0, 40)}: not declared` };
  for (const k of Object.keys(doc.state)) {
    if (!has(state, k)) return { ok: false, error: `state.${k}: missing` };
    if (!validValue(doc.state[k], state[k])) return { ok: false, error: `state.${k}: not a valid ${doc.state[k].type}` };
  }
  if (utf8Bytes(JSON.stringify(state)) > LIMITS.stateBytes) return { ok: false, error: 'state is larger than 8 KiB' };
  return { ok: true };
}

export function evalCondition(c: Cond, doc: Doc, state: State): boolean {
  if ('all' in c) return c.all.every((x) => evalCondition(x, doc, state));
  if ('any' in c) return c.any.some((x) => evalCondition(x, doc, state));
  if ('not' in c) return !evalCondition(c.not, doc, state);
  if (!has(doc.state, c.key) || !has(state, c.key)) return false;
  const d = doc.state[c.key], v = state[c.key];
  if ('eq' in c) return v === c.eq;
  if ('in' in c) return (c.in as StateValue[]).includes(v);
  if ('has' in c) return Array.isArray(v) && v.includes(c.has);
  if ('gte' in c) return typeof v === 'number' && v >= c.gte;
  if ('lte' in c) return typeof v === 'number' && v <= c.lte;
  if ('empty' in c) {
    const empty = d.type === 'text' ? v === '' : d.type === 'set' ? Array.isArray(v) && v.length === 0 : d.type === 'enum' ? v === null : false;
    return empty === c.empty;
  }
  return false;
}

/** `{{key}}`: an enum's label ("" when null), a set's labels in schema order joined with ", ", an int in decimal, a
 *  text as is. A bool or an unknown key is a post-time error, so it is left as written. */
export function interpolate(text: string, doc: Doc, state: State): string {
  return text.replace(/\{\{([a-z][a-z0-9_]{0,31})\}\}/g, (all, key: string) => {
    if (!has(doc.state, key) || !has(state, key)) return all;
    const d = doc.state[key], v = state[key];
    switch (d.type) {
      case 'enum': return d.values.find((x) => x.value === v)?.label ?? '';
      case 'set': return Array.isArray(v) ? d.values.filter((x) => v.includes(x.value)).map((x) => x.label).join(', ') : '';
      case 'int': return typeof v === 'number' ? String(v) : '';
      case 'text': return typeof v === 'string' ? v : '';
      default: return all;
    }
  });
}

const optionsOf = (doc: Doc, n: Extract<Node, { type: 'choice' }>) => {
  const d = doc.state[n.bind] as Extract<StateDecl, { type: 'enum' | 'set' }>;
  return n.options ? n.options.map((o) => d.values.find((x) => x.value === o)!) : d.values;
};

/** Every node as drawn, in document order. Any lock disables every control; show_if hides (with the node's children),
 *  enable_if disables; a set's unselected options are disabled once it holds `max` values. */
export function resolve(doc: Doc, state: State, lock: Lock): Resolved[] {
  const out: Resolved[] = [], locked = lock.reason !== null;
  const visit = (nodes: Node[], shown: boolean) => {
    for (const n of nodes) {
      const visible = shown && (!n.show_if || evalCondition(n.show_if, doc, state));
      const r: Resolved = { node: n, visible, disabled: false };
      if (n.type === 'checkbox' || n.type === 'choice' || n.type === 'input' || n.type === 'button') {
        r.disabled = locked || (!!n.enable_if && !evalCondition(n.enable_if, doc, state));
      }
      switch (n.type) {
        case 'text': r.text = interpolate(n.text, doc, state); break;
        case 'group': if (n.title !== undefined) r.label = interpolate(n.title, doc, state); break;
        case 'checkbox': r.label = interpolate(n.label, doc, state); r.value = state[n.bind]; break;
        case 'input': if (n.label !== undefined) r.label = interpolate(n.label, doc, state); r.value = state[n.bind]; break;
        case 'choice': {
          if (n.label !== undefined) r.label = interpolate(n.label, doc, state);
          const v = state[n.bind], d = doc.state[n.bind], full = d.type === 'set' && Array.isArray(v) && v.length >= d.max;
          r.value = copy(v);
          r.options = optionsOf(doc, n).map((o): ResolvedOption => {
            const selected = Array.isArray(v) ? v.includes(o.value) : v === o.value;
            return { value: o.value, label: o.label, selected, disabled: r.disabled || (full && !selected) };
          });
          break;
        }
        case 'button': {
          r.label = interpolate(n.label, doc, state);
          const say = n.act?.say !== undefined ? act(doc, state, n.id)?.effects.find((e) => e.type === 'say') : undefined;
          if (say && say.type === 'say') r.caption = say.text;
          break;
        }
      }
      out.push(r);
      if (n.type === 'row' || n.type === 'group') visit(n.children, visible);
    }
  };
  visit(doc.body, true);
  return out;
}

/** A UI action on a control → the new state and the event its `on` handler gets, or null when the action does not
 *  apply (unknown, hidden or disabled control, wrong action, a value that is not allowed, no change of a choice). */
export function applyAction(doc: Doc, state: State, nodeId: string, action: Action): { state: State; event: HxEvent } | null {
  const r = resolve(doc, state, { reason: null }).find((x) => x.node.id === nodeId);
  if (!r || !r.visible || r.disabled) return null;
  const n = r.node, s = copyState(state);
  switch (n.type) {
    case 'checkbox':
      if (action.type !== 'toggle') return null;
      s[n.bind] = !s[n.bind];
      return { state: s, event: { type: 'change', node: n.id, value: s[n.bind] } };
    case 'choice': {
      if (action.type !== 'select') return null;
      const o = r.options!.find((x) => x.value === action.value);
      if (!o || o.disabled) return null;
      const d = doc.state[n.bind];
      if (d.type === 'set') {
        const v = s[n.bind] as string[], next = o.selected ? v.filter((x) => x !== o.value) : [...v, o.value];
        s[n.bind] = d.values.map((x) => x.value).filter((x) => next.includes(x));   // schema order
      } else {
        if (o.selected) return null;                                                // no deselect
        s[n.bind] = o.value;
      }
      return { state: s, event: { type: 'change', node: n.id, value: copy(s[n.bind]) } };
    }
    case 'input':
      if (action.type !== 'submit' || !validValue(doc.state[n.bind], action.value)) return null;
      s[n.bind] = action.value;
      if (!validateState(doc, s).ok) return null;
      return { state: s, event: { type: 'submit', node: n.id, value: action.value } };
    case 'button':
      if (action.type !== 'click') return null;
      return { state: s, event: { type: 'click', node: n.id, value: null } };
  }
  return null;
}

/** A button's declarative act: `set` first, then `say` interpolated from the new state, then `reply`, whose slots are
 *  filled from the state keys of the same names. Null when the node has no act. The effects are checked like a
 *  script's (effects.ts checkEffects) before anything is sent. */
export function act(doc: Doc, state: State, nodeId: string): { state: State; effects: Effect[] } | null {
  const n = findNode(doc, nodeId);
  if (!n || n.type !== 'button' || !n.act) return null;
  const s = copyState(state), effects: Effect[] = [];
  if (n.act.set) for (const k of Object.keys(n.act.set)) s[k] = copy(n.act.set[k]);
  if (n.act.say !== undefined) effects.push({ type: 'say', text: interpolate(n.act.say, doc, s), kind: n.act.say_kind ?? 'ic' });
  if (n.act.reply !== undefined) {
    const stub = doc.replies.find((x) => x.id === n.act!.reply)!, slots: Record<string, string | number> = {};
    for (const k of Object.keys(stub.slots)) slots[k] = s[k] as string | number;
    effects.push({ type: 'reply', id: stub.id, slots });
  }
  return { state: s, effects };
}
