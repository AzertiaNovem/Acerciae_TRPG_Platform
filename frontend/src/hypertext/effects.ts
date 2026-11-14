// Host validation of what a run produced, on the trusted side (the main thread on the web, the bundle on mobile, where
// the native side checks again). The guest's own bookkeeping (prelude.ts) is never trusted: everything is re-checked
// here, and again by the server. Also decides whether a say needs the viewer's confirmation, from the dice policy.
import type { Confirm, Doc, Effect, EngineError, ErrorCode, RunResult, State } from './types';
import { validateState } from './bindings';
import { bareRoll, verdict } from './dice';
import { slotOk } from './format';
import { asciiTrim, boundedText, cpLength, cpPrefix, has, isObject, jsonDepth, lineCount, sanitize, utf8Bytes } from './text';

export const OUTPUT_LIMITS = { bytes: 16384, depth: 16, sayCp: 500, sayLines: 5, notices: 3, noticeCp: 200, logs: 20, logCp: 200, messageCp: 200 } as const;
const CODES: ErrorCode[] = ['script_error', 'no_handler', 'budget', 'memory', 'stack', 'timeout', 'invalid_state', 'invalid_effect', 'engine_unavailable', 'engine'];

export const failure = (code: ErrorCode, message: string, line?: number): { ok: false; error: EngineError } =>
  ({ ok: false, error: { code, message: cpPrefix(sanitize(message), OUTPUT_LIMITS.messageCp), ...(line !== undefined ? { line } : {}) } });

/** The say's text as it will be posted (ASCII-trimmed, as the server trims), or an error message. */
export function checkSay(text: unknown, kind: unknown): { text: string } | { error: string } {
  if (kind !== 'ic' && kind !== 'ooc') return { error: "say: kind must be 'ic' or 'ooc'" };
  if (typeof text !== 'string') return { error: 'say: text must be a string' };
  const t = asciiTrim(text);
  if (!boundedText(t, OUTPUT_LIMITS.sayCp, true, 1)) return { error: 'say: 1 to 500 characters, no control or direction characters' };
  if (lineCount(t) > OUTPUT_LIMITS.sayLines) return { error: 'say: at most 5 lines' };   // U+0085, U+2028 and U+2029 break lines too
  if (verdict(t) === 'refused') return { error: 'say: this command cannot be posted from an interactive message' };
  return { text: t };
}

/** At most one say and one reply; a reply only to a declared stub, with exactly its slots and allowed values. */
export function checkEffects(doc: Doc, raw: unknown): { effects: Effect[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length > 2) return { error: 'effects: at most one say and one reply' };
  const effects: Effect[] = [];
  for (const e of raw) {
    if (!isObject(e)) return { error: 'effects: each effect must be an object' };
    if (e.type === 'say') {
      if (effects.some((x) => x.type === 'say')) return { error: 'say: at most once per action' };
      if (Object.keys(e).some((k) => k !== 'type' && k !== 'text' && k !== 'kind')) return { error: 'say: unknown field' };
      const s = checkSay(e.text, e.kind);
      if ('error' in s) return s;
      effects.push({ type: 'say', text: s.text, kind: e.kind as 'ic' | 'ooc' });
    } else if (e.type === 'reply') {
      if (effects.some((x) => x.type === 'reply')) return { error: 'reply: at most once per action' };
      if (Object.keys(e).some((k) => k !== 'type' && k !== 'id' && k !== 'slots')) return { error: 'reply: unknown field' };
      const stub = typeof e.id === 'string' ? doc.replies.find((r) => r.id === e.id) : undefined;
      if (!stub) return { error: 'reply: not one of this message\'s replies' };
      const slots = e.slots === undefined ? {} : e.slots;
      if (!isObject(slots)) return { error: 'reply: slots must be an object' };
      const names = Object.keys(stub.slots);
      if (Object.keys(slots).length !== names.length || !names.every((k) => has(slots, k))) return { error: `reply ${stub.id}: slots must be exactly ${names.join(', ') || '(none)'}` };
      const out: Record<string, string | number> = {};
      for (const k of names) {
        const v = slots[k];
        if (!slotOk(stub.slots[k], v)) return { error: `reply ${stub.id}: slot ${k} is not an allowed value` };
        out[k] = v;
      }
      effects.push({ type: 'reply', id: stub.id, slots: out });
    } else return { error: 'effects: unknown effect type' };
  }
  return { effects };
}

/** Free text (not a command) needs the viewer's confirmation; sc/ds too, with a sheet warning. An allowed roll runs
 *  directly only when it is a bare roll (dice.ts bareRoll: one line, nothing but the expression or a short skill);
 *  any other text riding on a roll is confirmed like free text. */
export function confirmFor(effects: Effect[]): Confirm | null {
  const say = effects.find((e) => e.type === 'say');
  if (!say || say.type !== 'say') return null;
  const v = verdict(say.text);
  if (v === 'confirm') return { text: say.text, kind: say.kind, sheet: true };
  return v === 'allowed' && bareRoll(say.text) ? null : { text: say.text, kind: say.kind };
}

const logList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.slice(0, OUTPUT_LIMITS.logs).map((x) => cpPrefix(sanitize(String(typeof x === 'string' ? x : JSON.stringify(x))), OUTPUT_LIMITS.logCp)) : [];

/** The engine's output (a JSON string from the worker or the WebView) → a validated result. `changed`: whether the
 *  state differs from the one the run started from (no effects and no change: nothing to save). */
export function validateOutput(doc: Doc, prevState: State, raw: unknown): RunResult {
  if (typeof raw !== 'string') return failure('engine', 'the engine returned no output');
  if (utf8Bytes(raw) > OUTPUT_LIMITS.bytes) return failure('invalid_effect', 'the script output is larger than 16 KiB');
  if (jsonDepth(raw) > OUTPUT_LIMITS.depth) return failure('invalid_effect', 'the script output is nested too deeply');
  let out: unknown;
  try { out = JSON.parse(raw); } catch { return failure('invalid_effect', 'the script output is not JSON'); }
  if (!isObject(out) || typeof out.ok !== 'boolean') return failure('invalid_effect', 'the script output has no result');
  if (!out.ok) {
    const e = isObject(out.error) ? out.error : {};
    const code = CODES.includes(e.code as ErrorCode) ? e.code as ErrorCode : 'script_error';
    const line = Number.isInteger(e.line) && (e.line as number) > 0 ? e.line as number : undefined;
    const f = failure(code, typeof e.message === 'string' ? e.message : 'the script failed', line), logs = logList(out.logs);
    return logs.length ? { ...f, logs } : f;
  }
  for (const k of Object.keys(out)) if (!['ok', 'state', 'effects', 'notices', 'logs'].includes(k)) return failure('invalid_effect', `unknown output field ${cpPrefix(k, 40)}`);
  // The prelude hands the script every key and returns them all: a missing one was deleted by the script.
  const missing = isObject(out.state) ? Object.keys(doc.state).find((k) => !has(out.state as object, k)) : undefined;
  if (missing !== undefined) return failure('invalid_state', `state.${missing}: missing`);
  const st = validateState(doc, out.state);
  if (!st.ok) return failure('invalid_state', st.error);
  const fx = checkEffects(doc, out.effects ?? []);
  if ('error' in fx) return failure('invalid_effect', fx.error);
  const notices = out.notices ?? [];
  if (!Array.isArray(notices) || notices.length > OUTPUT_LIMITS.notices) return failure('invalid_effect', 'notify: at most 3 per action');
  if (!notices.every((n) => boundedText(n, OUTPUT_LIMITS.noticeCp, true, 1))) return failure('invalid_effect', 'notify: 1 to 200 characters, no control or direction characters');
  if (out.logs !== undefined && (!Array.isArray(out.logs) || out.logs.length > OUTPUT_LIMITS.logs || !out.logs.every((l) => typeof l === 'string' && cpLength(l) <= OUTPUT_LIMITS.logCp))) {
    return failure('invalid_effect', 'log: at most 20 entries of 200 characters');
  }
  const state = st.state;
  const changed = Object.keys(doc.state).some((k) => JSON.stringify(state[k]) !== JSON.stringify(prevState[k]));
  return { ok: true, state, effects: fx.effects, notices: [...notices] as string[], logs: logList(out.logs), confirm: confirmFor(fx.effects), changed };
}
