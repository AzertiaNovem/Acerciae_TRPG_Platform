// The web/desktop host of the card engine: a dedicated module worker (created by client.ts). It fetches the QuickJS
// WASM once, compiles it once, and then removes the network, storage and font-loading APIs from its own scope before
// it handles any message, as defence in depth (the boundary is WASM: the guest gets no host function; the response
// CSP for /assets/hypertext-worker-* in public/_headers and nginx.conf is the next layer). Dynamic import() is syntax
// and stays: the worker loads its own chunks with it, which that CSP limits to 'self'. It never receives a token:
// requests and replies are JSON strings of at most 64 KiB, {id, input} in and {id, out, reload?} back, where `out` is
// the engine's output for effects.ts to validate on the main thread, and `reload` says the engine could not be loaded
// (the worker cannot fetch it again, so client.ts replaces it). The `/*!` comment below is the engine's MIT notice; the
// build keeps it in the worker asset (mobile/hypertext/engine.ts has the same one for the app bundle).
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
import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import { runAction } from './engine';
import type { EngineInput } from './types';

const MAX_MESSAGE = 65536;
const unavailable = (message: string) => JSON.stringify({ ok: false, error: { code: 'engine_unavailable', message } });

const scope = self as any;
const compiled: Promise<WebAssembly.Module | { message: string; reload: boolean }> = typeof WebAssembly === 'undefined'
  ? Promise.resolve({ message: 'WebAssembly is not available', reload: false })
  : scope.fetch(wasmUrl).then((r: Response) => r.ok ? r.arrayBuffer() : Promise.reject(Error(`HTTP ${r.status}`))).then((b: ArrayBuffer) => WebAssembly.compile(b))
    .catch((e: unknown) => ({ message: `the engine could not be loaded: ${e instanceof Error ? e.message : String(e)}`, reload: true }));

// The bytes are already requested: nothing here needs the network again. Each name goes from the object and its
// prototypes, then is pinned to undefined on the object (and on WorkerGlobalScope.prototype for the scope).
function drop(target: any, names: string[], protoTarget?: any) {
  if (!target) return;
  for (const name of names) {
    for (let o = target; o; o = Object.getPrototypeOf(o)) if (Object.prototype.hasOwnProperty.call(o, name)) { try { delete o[name]; } catch { /* kept: shadowed below */ } }
    for (const t of [target, protoTarget].filter(Boolean)) {
      try { Object.defineProperty(t, name, { value: undefined, writable: false, configurable: false }); } catch { /* already gone */ }
    }
  }
}
drop(scope, ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel',
  'Worker', 'SharedWorker', 'FontFace', 'fonts'], scope.WorkerGlobalScope?.prototype);
drop(scope.navigator, ['storage', 'locks', 'serviceWorker']);   // persistent storage (OPFS), cross-tab locks

let queue = Promise.resolve();
scope.onmessage = (e: MessageEvent) => {
  queue = queue.then(async () => {
    let id = 0;
    try {
      if (typeof e.data !== 'string' || e.data.length > MAX_MESSAGE) return;
      const req = JSON.parse(e.data) as { id: number; input: EngineInput };
      id = Number(req.id) || 0;
      const mod = await compiled;
      if ('message' in mod) { scope.postMessage(JSON.stringify({ id, out: unavailable(mod.message), ...(mod.reload ? { reload: true } : {}) })); return; }
      scope.postMessage(JSON.stringify({ id, out: await runAction(mod, req.input) }));
    } catch (err) {
      scope.postMessage(JSON.stringify({ id, out: JSON.stringify({ ok: false, error: { code: 'engine', message: String(err).slice(0, 200) } }) }));
    }
  });
};
