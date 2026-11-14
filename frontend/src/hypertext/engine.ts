// One run of a card's script in QuickJS (quickjs-emscripten-core + @jitl/quickjs-wasmfile-release-sync, exact pins).
// Every run gets a fresh WASM instance from the host's compiled WebAssembly.Module, so it starts on a clean heap and
// its memory and step cut-offs are the same on every platform. The context and runtime are never disposed: the whole
// instance is dropped instead (disposing after the script made an async function aborts the WASM, and a fresh
// instance per run makes disposal unnecessary). No host function is passed into the guest. The output is a JSON
// string; effects.ts validates it on the trusted side.
//
// The step budget counts bytecode, not time: a C built-in can do any amount of work between two polls. The prelude
// meters the worst of them; the rest is bounded by time. The interrupt handler also checks a wall-clock deadline
// (`timeout`), and the hosts end a run that stops polling altogether (client.ts on the web, the page of the mobile
// bundle). So a script that only does bytecode fails the same way everywhere, while one near the deadline can succeed
// on a fast device and time out on a slow one.
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import type { EngineInput, ErrorCode } from './types';
import { PRELUDE } from './prelude';
import { cpPrefix, jsonDepth, sanitize, utf8Bytes } from './text';

/** The engine protocol (v1 cards) and the pinned QuickJS packages; the bundle reports it as MobileHypertext.version. */
export const ENGINE_VERSION = 'hypertext-1 quickjs-emscripten-0.32.0';
/** Fixture `engine.limits`. QuickJS polls the interrupt handler about every 10k steps; 50 polls ≈ 250k loop
 *  iterations, 10–20 ms on a desktop. The stack limit is below the 256 KiB of the first measurements: in a Chromium
 *  dedicated worker, plain recursion at 256 KiB overflows the host's own stack first (reported as `engine`), while
 *  128 KiB reports `stack` there too (about 740 nested calls). Recursion inside C built-ins (toJSON, deeply nested
 *  JSON, the parser) can still exhaust a small host stack first: that is `engine`, and the action fails all the same.
 *  The deadline is checked at each poll, well inside the hosts' 1 s backstop. */
export const ENGINE_LIMITS = { interruptPolls: 50, memoryBytes: 8 << 20, stackBytes: 128 << 10, outputBytes: 16384, deadlineMs: 500 } as const;
const INTRINSICS = { BaseObjects: true, Eval: true, JSON: true, RegExp: true, RegExpCompiler: true, MapSet: true, StringNormalize: true } as const;
/** The only error codes a script can produce itself (the prelude's); every other code is the host's to give. */
const GUEST_CODES: readonly unknown[] = ['script_error', 'no_handler'];

/** A host error, with at most 20 logs of 200 code points, and never over outputBytes. */
function error(code: ErrorCode, message: string, line?: number, logs?: unknown): string {
  const e = { code, message: cpPrefix(sanitize(message), 200), ...(line ? { line } : {}) };
  const list = Array.isArray(logs) ? logs.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => cpPrefix(sanitize(x), 200)) : [];
  const out = JSON.stringify({ ok: false, error: e, ...(list.length ? { logs: list } : {}) });
  return utf8Bytes(out) <= ENGINE_LIMITS.outputBytes ? out : JSON.stringify({ ok: false, error: e });
}

/** The script's own output (it can forge any JSON): a host-only error code becomes script_error, so a card cannot
 *  claim that the engine is unavailable, timed out or ran out of memory. Everything else is effects.ts's to check. */
function fromGuest(out: string): string {
  if (utf8Bytes(out) > ENGINE_LIMITS.outputBytes) return error('invalid_effect', 'the script output is larger than 16 KiB');
  if (jsonDepth(out) > 16) return out;
  let o: any;
  try { o = JSON.parse(out); } catch { return out; }
  if (o === null || typeof o !== 'object' || o.ok !== false) return out;
  const e = o.error !== null && typeof o.error === 'object' && !Array.isArray(o.error) ? o.error : {};
  return GUEST_CODES.includes(e.code) ? out : JSON.stringify({ ...o, error: { ...e, code: 'script_error' } });
}

function guestError(ctx: QuickJSContext, handle: QuickJSHandle, interrupted: boolean, late: boolean): { code: ErrorCode; message: string; line?: number } {
  if (interrupted) return { code: 'budget', message: 'the script ran too long' };
  if (late) return { code: 'timeout', message: 'the script did not finish in time' };
  let e: any;
  try { e = ctx.dump(handle); } catch { return { code: 'memory', message: 'the script ran out of memory' }; }
  const name = typeof e?.name === 'string' ? e.name : '', message = typeof e?.message === 'string' ? e.message : typeof e === 'string' ? e : String(e);
  // QuickJS's own errors (InternalError, or SyntaxError from the JSON and source parsers). A script can throw the same
  // messages itself: that only changes which error it reports.
  if (message === 'out of memory') return { code: 'memory', message: 'the script ran out of memory' };
  if (message === 'stack overflow') return { code: 'stack', message: 'the script recursed too deeply' };
  if (message === 'interrupted') return { code: 'budget', message: 'the script ran too long' };
  const at = typeof e?.stack === 'string' ? /card\.js:(\d+)/.exec(e.stack) : null;
  return { code: 'script_error', message: name ? `${name}: ${message}` : message, ...(at ? { line: Number(at[1]) } : {}) };
}

/** A fresh QuickJS instance of the compiled module. The hook is ours rather than newVariant's `wasmModule`: the
 *  emscripten loader wraps instantiateWasm in a promise that never rejects, so a failed instantiation (a phone that
 *  cannot allocate the 16 MiB memory) would leave the run pending forever. Here it rejects. */
function instantiate(module: WebAssembly.Module): Promise<QuickJSWASMModule> {
  let failed!: (e: unknown) => void;
  const failure = new Promise<never>((_, reject) => { failed = reject; });
  const emscriptenModule = {
    instantiateWasm(imports: WebAssembly.Imports, ok: (instance: WebAssembly.Instance) => void) {
      WebAssembly.instantiate(module, imports).then((instance) => ok(instance)).catch(failed);
      return {};
    },
  };
  return Promise.race([newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { emscriptenModule } as Parameters<typeof newVariant>[1])), failure]);
}

/** Runs `input.handler` with `input.event` on `input.state`. Resolves to the output JSON string (never rejects). */
export async function runAction(module: WebAssembly.Module, input: EngineInput, meter?: { polls: number }): Promise<string> {
  if (!input.doc.script) return error('no_handler', 'this message has no script');
  const payload = JSON.stringify({
    handler: input.handler, state: input.state, event: input.event,
    viewer: { gm: input.viewer.gm, actor: input.viewer.actor, character: input.viewer.character },
    card: { title: input.doc.title, replies: input.doc.replies.map((r) => r.id) },
  });
  const deadline = Date.now() + ENGINE_LIMITS.deadlineMs;
  let polls = 0, late = false;
  try {
    const qjs = await instantiate(module);
    const rt = qjs.newRuntime();
    rt.setMemoryLimit(ENGINE_LIMITS.memoryBytes);
    rt.setMaxStackSize(ENGINE_LIMITS.stackBytes);
    rt.setInterruptHandler(() => ++polls > ENGINE_LIMITS.interruptPolls || (late = Date.now() > deadline));
    const ctx = rt.newContext({ intrinsics: INTRINSICS });
    const prelude = ctx.evalCode(PRELUDE, 'prelude.js', { type: 'global' });
    if (prelude.error) return error('engine', 'the engine could not start');
    const steps = ['"use strict";' + input.doc.script, '__run(' + JSON.stringify(payload) + ')'];
    let value: QuickJSHandle | null = null;
    for (let i = 0; i < steps.length; i++) {
      const r = ctx.evalCode(steps[i], i ? 'run.js' : 'card.js', { type: 'global' });
      if (r.error) {
        const e = guestError(ctx, r.error, polls > ENGINE_LIMITS.interruptPolls, late);
        let logs: unknown;
        if (e.code === 'script_error') {
          // The script can shape this JSON too (a toJSON on Array.prototype): it is capped like any output.
          const l = ctx.evalCode('__logs()', 'logs.js', { type: 'global' });
          const raw = !l.error && ctx.typeof(l.value) === 'string' ? ctx.getString(l.value) : '';
          try { if (raw.length <= ENGINE_LIMITS.outputBytes && jsonDepth(raw) <= 2) logs = JSON.parse(raw); } catch { logs = undefined; }
        }
        return error(e.code, e.message, e.line, logs);
      }
      value = r.value;
    }
    if (!value || ctx.typeof(value) !== 'string') return error('invalid_effect', 'the script output is not a string');
    return fromGuest(ctx.getString(value));
  } catch (e) {
    // A WASM trap (WebAssembly.RuntimeError), the host's own stack running out before QuickJS's stack check (a
    // RangeError: some C-recursive paths such as toJSON or deeply nested JSON on a small host stack), or a failed
    // instantiation. The instance is dropped with this call; the next run starts a new one.
    return error('engine', e instanceof Error ? e.message : String(e));
  } finally {
    if (meter) meter.polls = polls;
  }
}
