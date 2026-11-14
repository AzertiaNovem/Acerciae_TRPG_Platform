// The web/desktop host of the card engine: a dedicated module worker (created by client.ts). It fetches the QuickJS
// WASM once, compiles it once, and then removes the network and storage APIs from its own scope before it handles
// any message, as defence in depth (the boundary is WASM: the guest gets no host function). It never receives a
// token: requests and replies are JSON strings of at most 64 KiB, {id, input} in and {id, out} back, where `out` is
// the engine's output for effects.ts to validate on the main thread.
import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import { runAction } from './engine';
import type { EngineInput } from './types';

const MAX_MESSAGE = 65536;
const unavailable = (message: string) => JSON.stringify({ ok: false, error: { code: 'engine_unavailable', message } });

const compiled: Promise<WebAssembly.Module | string> = typeof WebAssembly === 'undefined'
  ? Promise.resolve('WebAssembly is not available')
  : fetch(wasmUrl).then((r) => r.ok ? r.arrayBuffer() : Promise.reject(Error(`HTTP ${r.status}`))).then((b) => WebAssembly.compile(b))
    .catch((e) => `the engine could not be loaded: ${e instanceof Error ? e.message : String(e)}`);

// The bytes are already requested: nothing here needs the network again.
const scope = self as any;
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker']) {
  for (let o = scope; o; o = Object.getPrototypeOf(o)) if (Object.prototype.hasOwnProperty.call(o, name)) { try { delete o[name]; } catch { /* kept: shadowed below */ } }
  for (const target of [scope, scope.WorkerGlobalScope?.prototype].filter(Boolean)) {
    try { Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false }); } catch { /* already gone */ }
  }
}

let queue = Promise.resolve();
scope.onmessage = (e: MessageEvent) => {
  queue = queue.then(async () => {
    let id = 0;
    try {
      if (typeof e.data !== 'string' || e.data.length > MAX_MESSAGE) return;
      const req = JSON.parse(e.data) as { id: number; input: EngineInput };
      id = Number(req.id) || 0;
      const mod = await compiled;
      const out = typeof mod === 'string' ? unavailable(mod) : await runAction(mod, req.input);
      scope.postMessage(JSON.stringify({ id, out }));
    } catch (err) {
      scope.postMessage(JSON.stringify({ id, out: JSON.stringify({ ok: false, error: { code: 'engine', message: String(err).slice(0, 200) } }) }));
    }
  });
};
