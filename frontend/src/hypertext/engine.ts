// One run of a card's script in QuickJS (quickjs-emscripten-core + @jitl/quickjs-wasmfile-release-sync, exact pins).
// Every run gets a fresh WASM instance from the host's compiled WebAssembly.Module, so it starts on a clean heap and
// its memory and step cut-offs are the same on every platform. The context and runtime are never disposed: the whole
// instance is dropped instead (disposing after the script made an async function aborts the WASM, and a fresh
// instance per run makes disposal unnecessary). No host function is passed into the guest. The output is a JSON
// string; effects.ts validates it on the trusted side.
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import type { EngineInput, ErrorCode } from './types';
import { PRELUDE } from './prelude';
import { cpPrefix, sanitize, utf8Bytes } from './text';

/** The engine protocol (v1 cards) and the pinned QuickJS packages; the bundle reports it as MobileHypertext.version. */
export const ENGINE_VERSION = 'hypertext-1 quickjs-emscripten-0.32.0';
/** Fixture `engine.limits`. QuickJS polls the interrupt handler about every 10k steps; 50 polls ≈ 250k loop
 *  iterations, 10–20 ms on a desktop. The stack limit is below the 256 KiB of the first measurements: in a Chromium
 *  dedicated worker, plain recursion at 256 KiB overflows the host's own stack first (reported as `engine`), while
 *  128 KiB reports `stack` there too (about 740 nested calls). Recursion inside C built-ins (toJSON, deeply nested
 *  JSON, the parser) can still exhaust a small host stack first: that is `engine`, and the action fails all the same. */
export const ENGINE_LIMITS = { interruptPolls: 50, memoryBytes: 8 << 20, stackBytes: 128 << 10, outputBytes: 16384 } as const;
const INTRINSICS = { BaseObjects: true, Eval: true, JSON: true, RegExp: true, RegExpCompiler: true, MapSet: true, StringNormalize: true } as const;

const error = (code: ErrorCode, message: string, line?: number, logs?: string[]) =>
  JSON.stringify({ ok: false, error: { code, message: cpPrefix(sanitize(message), 200), ...(line ? { line } : {}) }, ...(logs?.length ? { logs } : {}) });

function guestError(ctx: QuickJSContext, handle: QuickJSHandle, interrupted: boolean): { code: ErrorCode; message: string; line?: number } {
  if (interrupted) return { code: 'budget', message: 'the script ran too long' };
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

/** Runs `input.handler` with `input.event` on `input.state`. Resolves to the output JSON string (never rejects). */
export async function runAction(module: WebAssembly.Module, input: EngineInput, meter?: { polls: number }): Promise<string> {
  if (!input.doc.script) return error('no_handler', 'this message has no script');
  const payload = JSON.stringify({
    handler: input.handler, state: input.state, event: input.event,
    viewer: { gm: input.viewer.gm, actor: input.viewer.actor, character: input.viewer.character },
    card: { title: input.doc.title, replies: input.doc.replies.map((r) => r.id) },
  });
  let polls = 0;
  try {
    const qjs = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule: module }));
    const rt = qjs.newRuntime();
    rt.setMemoryLimit(ENGINE_LIMITS.memoryBytes);
    rt.setMaxStackSize(ENGINE_LIMITS.stackBytes);
    rt.setInterruptHandler(() => ++polls > ENGINE_LIMITS.interruptPolls);
    const ctx = rt.newContext({ intrinsics: INTRINSICS });
    const prelude = ctx.evalCode(PRELUDE, 'prelude.js', { type: 'global' });
    if (prelude.error) return error('engine', 'the engine could not start');
    const steps = ['"use strict";' + input.doc.script, '__run(' + JSON.stringify(payload) + ')'];
    let value: QuickJSHandle | null = null;
    for (let i = 0; i < steps.length; i++) {
      const r = ctx.evalCode(steps[i], i ? 'run.js' : 'card.js', { type: 'global' });
      if (r.error) {
        const e = guestError(ctx, r.error, polls > ENGINE_LIMITS.interruptPolls);
        let logs: string[] | undefined;
        if (e.code === 'script_error') {
          const l = ctx.evalCode('__logs()', 'logs.js', { type: 'global' });
          try { if (!l.error && ctx.typeof(l.value) === 'string') logs = JSON.parse(ctx.getString(l.value)); } catch { logs = undefined; }
        }
        return error(e.code, e.message, e.line, Array.isArray(logs) ? logs.filter((x) => typeof x === 'string') : undefined);
      }
      value = r.value;
    }
    if (!value || ctx.typeof(value) !== 'string') return error('invalid_effect', 'the script output is not a string');
    const out = ctx.getString(value);
    return utf8Bytes(out) > ENGINE_LIMITS.outputBytes ? error('invalid_effect', 'the script output is larger than 16 KiB') : out;
  } catch (e) {
    // A WASM trap (WebAssembly.RuntimeError), the host's own stack running out before QuickJS's 256 KiB check (a
    // RangeError: some C-recursive paths such as toJSON or deeply nested JSON on a small host stack), or a failed
    // instantiation. The instance is dropped with this call; the next run starts a new one.
    return error('engine', e instanceof Error ? e.message : String(e));
  } finally {
    if (meter) meter.polls = polls;
  }
}
