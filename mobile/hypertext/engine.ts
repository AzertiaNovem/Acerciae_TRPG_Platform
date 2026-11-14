// The card engine for Android and iOS: bundled by mobile/scripts/build-hypertext.mjs into
// mobile/contracts/hypertext/hypertext-engine.js and run in a hidden, network-blocked WebView (HypertextEngine.kt,
// HypertextEngine.swift) that has no bridge. The same engine.ts, prelude and effects.ts as the web, and the same WASM
// bytes (inlined, never fetched). Native code checks the result again before it calls REST.
//
// window.MobileHypertext, for native code without a bridge:
// - ready: true once a request can run (poll it after the page loads, as OpenStudio does); version: ENGINE_VERSION.
// - start(id, json), then take(id): the result JSON once the run is done, null while it runs. Android polls take()
//   through evaluateJavascript, which does not wait for promises. At most 32 results wait to be taken.
// - run(json): a Promise of the result JSON, for iOS callAsyncJavaScript.
// Request: {doc, state, prev, handler, event, viewer}: doc as stored in messages.hypertext, state after the binding
// change, prev the state before it (required: the result's `changed` compares with it). Result: effects.ts RunResult.
//
// Each run happens in a dedicated worker started from this same file (a blob: URL of its own source, so the page's
// CSP has worker-src blob:, and the native hosts must let blob: workers load). This page's thread stays free and ends
// a run that has not answered in 1 s (5 s while a worker starts) with `timeout`, terminating its worker: on Android
// every WebView of the app shares one renderer thread, so a script stuck in a C built-in must not run on it. Only
// where a worker cannot start does a run happen on this page, with the native timeout as the backstop.
/*! quickjs-emscripten: The MIT License. quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis.
 *  QuickJS Javascript Engine: The MIT License. Copyright (c) 2017-2021 Fabrice Bellard, Copyright (c) 2017-2021 Charlie Gordon.
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 *  documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 *  rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 *  persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice
 *  and this permission notice shall be included in all copies or substantial portions of the Software.
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 *  WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 *  COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *  OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. */
import wasm from '@jitl/quickjs-wasmfile-release-sync/wasm';
import { ENGINE_VERSION, runAction } from '../../frontend/src/hypertext/engine';
import { failure, validateOutput } from '../../frontend/src/hypertext/effects';
import { parseDoc } from '../../frontend/src/hypertext/format';
import { validateState } from '../../frontend/src/hypertext/bindings';
import { isId, isObject } from '../../frontend/src/hypertext/text';
import type { ErrorCode, HxEvent, Viewer } from '../../frontend/src/hypertext/types';

/** The function build-hypertext.mjs wraps the whole bundle in: its source starts the worker. */
declare const __hypertextBundle: (() => void) | undefined;
/** Fixture engine.limits timeout_ms and cold_timeout_ms (the web's client.ts uses the same). */
const LIMITS = { timeoutMs: 1000, coldTimeoutMs: 5000, results: 32, queue: 8 } as const;
const g = globalThis as any;
const fail = (code: ErrorCode, message: string) => JSON.stringify(failure(code, message));

let compiled: Promise<WebAssembly.Module | null> | null = null;
const compile = () => compiled ??= typeof WebAssembly === 'undefined' ? Promise.resolve(null)
  : WebAssembly.compile(wasm as unknown as Uint8Array).catch(() => null);

/** One request: parse, check, run, validate. Resolves to the result JSON, never rejects. */
async function execute(json: string): Promise<string> {
  try {
    const req = JSON.parse(json);
    const doc = parseDoc(req?.doc);
    if (!doc) return fail('engine', 'this message cannot be run by this app version');
    const st = validateState(doc, req.state), pv = validateState(doc, req.prev);
    if (!st.ok) return fail('invalid_state', st.error);
    if (!pv.ok) return fail('invalid_state', req.prev === undefined ? 'prev (the state before the action) is required' : 'the previous state is not valid');
    const ev = req.event, vw = req.viewer;
    if (!isId(req.handler) || !isObject(ev) || !['change', 'submit', 'click'].includes(ev.type as string) || !isId(ev.node) || !isObject(vw)) {
      return fail('engine', 'malformed request');
    }
    const module = await compile();
    if (!module) return fail('engine_unavailable', 'WebAssembly is not available on this device');
    const event: HxEvent = { type: ev.type as HxEvent['type'], node: ev.node as string, value: (ev.value ?? null) as HxEvent['value'] };
    const viewer: Viewer = { gm: vw.gm === true, actor: vw.actor === true, character: typeof vw.character === 'string' ? vw.character : null };
    const out = await runAction(module, { doc, state: st.state, handler: req.handler, event, viewer });
    return JSON.stringify(validateOutput(doc, pv.state, out));
  } catch (e) {
    return fail('engine', e instanceof Error ? e.message : String(e));
  }
}

/** Inside the worker: {ready} once compiled, then {id, out} for each {id, json}. */
function serveWorker() {
  void compile().then(() => g.postMessage(JSON.stringify({ ready: true })));
  g.onmessage = (e: MessageEvent) => {
    let m: { id?: unknown; json?: unknown };
    try { m = JSON.parse(e.data); } catch { return; }
    void execute(String(m.json)).then((out) => g.postMessage(JSON.stringify({ id: m.id, out })));
  };
}

interface Job { json: string; resolve: (out: string) => void }
interface Running extends Job { id: number; timer: ReturnType<typeof setTimeout> | null }

function servePage() {
  const results = new Map<string, string>(), queue: Job[] = [];
  let worker: Worker | null = null, warm = false, current: Running | null = null, nextId = 1, url: string | null = null;
  let inline = typeof g.Worker !== 'function' || typeof g.Blob !== 'function' || typeof g.URL?.createObjectURL !== 'function'
    || typeof g.setTimeout !== 'function' || typeof __hypertextBundle !== 'function';
  const api = { ready: false, version: ENGINE_VERSION, run, start, take };
  g.MobileHypertext = api;

  const finish = (r: Running, out: string) => {
    if (current !== r) return;
    if (r.timer !== null) clearTimeout(r.timer);
    current = null; r.resolve(out); pump();
  };
  const goInline = () => { inline = true; void compile().then(() => { api.ready = true; }); };
  function spawn(): Worker | null {
    if (inline) return null;
    try {
      url ??= URL.createObjectURL(new Blob(['(' + String(__hypertextBundle) + ')();\n'], { type: 'text/javascript' }));
      const w: Worker = new g.Worker(url);
      warm = false;
      w.onmessage = (e: MessageEvent) => {
        if (w !== worker) return;
        let m: { ready?: unknown; id?: unknown; out?: unknown };
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.ready === true) { warm = true; api.ready = true; return; }
        if (current && m.id === current.id) finish(current, typeof m.out === 'string' ? m.out : fail('engine', 'the engine sent no result'));
      };
      w.onerror = (e: Event) => {
        if (w !== worker) return;
        e.preventDefault?.();
        w.terminate(); worker = null;
        const r = current, started = warm;
        if (!started) goInline();                    // it never started (blocked or unsupported): run on this page
        if (r) { if (r.timer !== null) clearTimeout(r.timer); r.timer = null; }
        if (r && !started) void execute(r.json).then((out) => finish(r, out));
        else if (r) finish(r, fail('engine', 'the engine stopped'));
        else if (started) worker = spawn();
      };
      return w;
    } catch {
      goInline();
      return null;
    }
  }
  function pump() {
    if (current || !queue.length) return;
    const job = queue.shift()!, r: Running = { ...job, id: nextId++, timer: null };
    current = r;
    const w = worker ??= spawn();
    if (!w) { void execute(r.json).then((out) => finish(r, out)); return; }
    r.timer = setTimeout(() => {
      if (current !== r) return;
      w.terminate(); worker = null;                  // stuck, maybe in a C built-in: a new worker for the next run
      finish(r, fail('timeout', 'the script did not finish in time'));
      worker ??= spawn();
    }, warm ? LIMITS.timeoutMs : LIMITS.coldTimeoutMs);
    w.postMessage(JSON.stringify({ id: r.id, json: r.json }));
  }
  function run(json: string): Promise<string> {
    if (queue.length >= LIMITS.queue) return Promise.resolve(fail('engine', 'too many actions are waiting'));
    return new Promise((resolve) => { queue.push({ json: String(json), resolve }); pump(); });
  }
  function start(id: string, json: string): void {
    const key = String(id);
    void run(json).then((out) => {
      results.set(key, out);
      for (const k of results.keys()) { if (results.size <= LIMITS.results) break; results.delete(k); }
    });
  }
  function take(id: string): string | null {
    const key = String(id), out = results.get(key);
    if (out === undefined) return null;
    results.delete(key);
    return out;
  }

  worker = spawn();                                  // started now, so the first click finds it compiled
  if (!worker) goInline();
}

if (typeof g.WorkerGlobalScope !== 'undefined' && typeof g.document === 'undefined') serveWorker();
else servePage();
