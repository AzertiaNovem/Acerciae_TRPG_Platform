// Runs card scripts in the hypertext worker for the web and desktop app. The worker is created on the first run (only
// cards with `on` handlers ever run), runs one action at a time, and is replaced when a run passes the wall-clock
// backstop (1 s, 5 s for the first run, which includes compiling the WASM), after 500 runs, when it could not load the
// engine (so the next run fetches it again), and on dispose (logout, session epoch bump). At most one action per card
// is in flight and at most 4 wait per device. The result is validated here, on the main thread, before the UI uses
// it; a reply that is too large or not JSON fails the run at once.
import type { EngineInput, RunResult, State } from './types';
import { failure, validateOutput } from './effects';
import { utf8Bytes } from './text';

export const CLIENT_LIMITS = { timeoutMs: 1000, coldTimeoutMs: 5000, recycleAfter: 500, queue: 4, messageBytes: 65536 } as const;

interface Job { card: string; input: EngineInput; prev: State; resolve: (r: RunResult) => void }
interface Running extends Job { id: number; timer: ReturnType<typeof setTimeout> }

export function engineAvailable() { return typeof WebAssembly !== 'undefined'; }

export function createEngineClient(spawn: () => Worker) {
  let worker: Worker | null = null, warm = false, runs = 0, nextId = 1, running: Running | null = null;
  const waiting: Job[] = [];

  const stop = () => { worker?.terminate(); worker = null; warm = false; runs = 0; };
  const finish = (r: Running, result: RunResult) => {
    clearTimeout(r.timer);
    if (running === r) running = null;
    r.resolve(result);
    if (runs >= CLIENT_LIMITS.recycleAfter) stop();
    pump();
  };
  const ensure = () => {
    if (worker) return worker;
    const w = spawn();
    w.onmessage = (e: MessageEvent) => {
      const r = running;
      if (w !== worker || !r) return;
      // The worker answers one request at a time, so whatever it sends now is the answer to `r`.
      let msg: { id?: unknown; out?: unknown; reload?: unknown } | null = null;
      if (typeof e.data === 'string' && utf8Bytes(e.data) <= CLIENT_LIMITS.messageBytes) try { msg = JSON.parse(e.data); } catch { msg = null; }
      if (!msg || typeof msg !== 'object') { finish(r, failure('invalid_effect', 'the engine sent a reply that is too large or not valid')); return; }
      if (msg.id !== r.id) return;
      warm = true;
      const result = validateOutput(r.input.doc, r.prev, msg.out);
      if (msg.reload === true) stop();           // the engine did not load (offline?): the next run starts a new worker
      finish(r, result);
    };
    w.onerror = () => {
      if (w !== worker) return;
      const r = running; stop();
      if (r) finish(r, failure('engine_unavailable', 'the engine could not start'));
    };
    worker = w;
    return w;
  };
  function pump() {
    if (running || !waiting.length) return;
    const job = waiting.shift()!, id = nextId++;
    const message = JSON.stringify({ id, input: job.input });
    if (utf8Bytes(message) > CLIENT_LIMITS.messageBytes) { job.resolve(failure('invalid_state', 'the action is too large to run')); pump(); return; }
    let w: Worker;
    try { w = ensure(); } catch { job.resolve(failure('engine_unavailable', 'the engine could not start')); pump(); return; }
    const r: Running = { ...job, id, timer: setTimeout(() => {
      if (running !== r) return;
      stop();                                  // a run that does not come back: the worker is replaced
      finish(r, failure('timeout', 'the script did not finish in time'));
    }, warm ? CLIENT_LIMITS.timeoutMs : CLIENT_LIMITS.coldTimeoutMs) };
    running = r; runs++;
    w.postMessage(message);
  }

  return {
    /** One action of `card`. `prev` is the state shown before the action, before its binding change (the result's
     *  `changed` compares with it; `input.state` would miss the binding change itself). */
    run(card: string, input: EngineInput, prev: State): Promise<RunResult> {
      if (!engineAvailable()) return Promise.resolve(failure('engine_unavailable', 'WebAssembly is not available on this device'));
      if (running?.card === card || waiting.some((j) => j.card === card)) return Promise.resolve(failure('engine', 'an action of this message is still running'));
      if (waiting.length >= CLIENT_LIMITS.queue) return Promise.resolve(failure('engine', 'too many actions are waiting'));
      return new Promise((resolve) => { waiting.push({ card, input, prev, resolve }); pump(); });
    },
    /** Logout or a new session epoch: the worker goes, and pending actions fail without effects. */
    dispose() {
      const pending = [...(running ? [running] : []), ...waiting.splice(0)];
      if (running) clearTimeout(running.timer);
      running = null; stop();
      for (const j of pending) j.resolve(failure('engine', 'the engine was stopped'));
    },
    get busy() { return !!running || waiting.length > 0; },
  };
}
export type EngineClient = ReturnType<typeof createEngineClient>;

let shared: EngineClient | null = null;
/** The app's engine; the worker itself starts on the first run. */
export const hypertextEngine = () => shared ??= createEngineClient(() => new Worker(new URL('./hypertext-worker.ts', import.meta.url), { type: 'module' }));
