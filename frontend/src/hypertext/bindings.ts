// The pure logic of a card, run natively on every client (no JavaScript engine): default and stored state, the
// binding of each control, conditions, interpolation, what is drawn, and declarative button actions. Ported to
// Kotlin (core/Hypertext.kt) and Swift (AcerciaeCore/Hypertext.swift) and pinned by the fixtures
// mobile/contracts/fixtures/hypertext.json (shared with C++) and hypertext-client.json, so keep it small and explicit.
import type { Action, Cond, Doc, Effect, HxEvent, Lock, Node, Resolved, ResolvedOption, State, StateDecl, StateValue } from './types';
import { LIMITS, findNode, slotOk, validValue } from './format';
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

/** A state as the server's validateState reads it (PUT /hypertext/state, /act): only declared keys, each a valid value;
 *  a missing key takes its default. `state` is the completed state (sets in schema order), at most 8 KiB serialized.
 *  On failure `key` is the offending key ("" for the whole state), the first in sorted order as on the server. The
 *  engine's own output must be complete as well (effects.ts). */
export function validateState(doc: Doc, state: unknown): { ok: true; state: State } | { ok: false; key: string; error: string } {
  if (!isObject(state)) return { ok: false, key: '', error: 'state must be an object' };
  const full = defaultState(doc);
  for (const k of Object.keys(state).sort()) {
    if (!has(doc.state, k)) return { ok: false, key: k, error: `state.${k.slice(0, 40)}: not declared` };
    const d = doc.state[k];
    if (!validValue(d, state[k])) return { ok: false, key: k, error: `state.${k}: not a valid ${d.type}` };
    full[k] = d.type === 'set' ? d.values.map((x) => x.value).filter((x) => (state[k] as string[]).includes(x)) : copy(state[k] as StateValue);
  }
  if (utf8Bytes(JSON.stringify(full)) > LIMITS.stateBytes) return { ok: false, key: '', error: 'state is larger than 8 KiB' };
  return { ok: true, state: full };
}

/** A key's value for conditions and interpolation: the state's when it is valid, else the default (C++ valueOf). */
const valueAt = (doc: Doc, state: State, key: string): StateValue =>
  has(state, key) && validValue(doc.state[key], state[key]) ? state[key] : defaultOf(doc.state[key]);

export function evalCondition(c: Cond, doc: Doc, state: State): boolean {
  if ('all' in c) return c.all.every((x) => evalCondition(x, doc, state));
  if ('any' in c) return c.any.some((x) => evalCondition(x, doc, state));
  if ('not' in c) return !evalCondition(c.not, doc, state);
  if (!has(doc.state, c.key)) return false;
  const d = doc.state[c.key], v = valueAt(doc, state, c.key);
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

const keyChar = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f;
/** `{{key}}`: an enum's label ("" when null), a set's labels in schema order joined with ", ", an int in decimal, a
 *  text as is. A bool or an unknown key is a post-time error, so it is left as written. The same scan as the server's
 *  interpolate: each "{{" either starts a declared key followed by "}}" or is kept, and the scan resumes after it. */
export function interpolate(text: string, doc: Doc, state: State): string {
  let out = '', start = 0, i: number;
  while ((i = text.indexOf('{{', start)) >= 0) {
    out += text.slice(start, i);
    let j = i + 2;
    while (j < text.length && keyChar(text.charCodeAt(j))) j++;
    const key = text.slice(i + 2, j);
    const d = j > i + 2 && text.startsWith('}}', j) && has(doc.state, key) ? doc.state[key] : null;
    if (!d || d.type === 'bool') { out += '{{'; start = i + 2; continue; }
    const v = valueAt(doc, state, key);
    out += d.type === 'enum' ? d.values.find((x) => x.value === v)?.label ?? ''
      : d.type === 'set' ? d.values.filter((x) => (v as string[]).includes(x.value)).map((x) => x.label).join(', ')
      : String(v);
    start = j + 2;
  }
  return out + text.slice(start);
}

const optionsOf = (doc: Doc, n: Extract<Node, { type: 'choice' }>) => {
  const d = doc.state[n.bind] as Extract<StateDecl, { type: 'enum' | 'set' }>;
  return n.options ? n.options.map((o) => d.values.find((x) => x.value === o)!) : d.values;
};

/** Every node as drawn, in document order. Any lock disables every control; show_if hides (with the node's children),
 *  enable_if disables; a set's unselected options are disabled once it holds `max` values; a button whose act replies
 *  is disabled while a slot cannot be filled from the state (a null enum, or a value the slot does not list). */
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
          const a = n.act ? act(doc, state, n.id) : null;
          for (const e of a?.effects ?? []) {
            if (e.type === 'say') r.caption = e.text;
            else if (!replyFits(doc, e.id, e.slots)) r.disabled = true;
          }
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

const replyFits = (doc: Doc, id: string, slots: Record<string, unknown>) => {
  const stub = doc.replies.find((x) => x.id === id);
  return !!stub && Object.keys(stub.slots).every((k) => slotOk(stub.slots[k], slots[k]));
};

/** A UI action on a control → the new state and the event its `on` handler gets (null for a commit, which fires no
 *  handler), or null when the action does not apply: an unknown, hidden or disabled control (under `lock` as well),
 *  the wrong action, a value that is not allowed, no change of a choice. */
export function applyAction(doc: Doc, state: State, nodeId: string, action: Action, lock: Lock = { reason: null }): { state: State; event: HxEvent | null } | null {
  const r = resolve(doc, state, lock).find((x) => x.node.id === nodeId);
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
      if ((action.type !== 'submit' && action.type !== 'commit') || !validValue(doc.state[n.bind], action.value)) return null;
      s[n.bind] = action.value;
      if (!validateState(doc, s).ok) return null;
      return { state: s, event: action.type === 'commit' ? null : { type: 'submit', node: n.id, value: action.value } };
    case 'button':
      if (action.type !== 'click') return null;
      return { state: s, event: { type: 'click', node: n.id, value: null } };
  }
  return null;
}

/** A button's declarative act: `set` first, then `say` interpolated from the new state, then `reply`, whose slots are
 *  filled from the state keys of the same names. Null when the node has no act. It does not check the lock, show_if
 *  or enable_if: call it only for a click that applyAction accepted. The effects are checked like a script's
 *  (effects.ts checkEffects) before anything is sent. */
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
