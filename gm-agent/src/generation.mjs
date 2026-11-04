// Each generation job keeps the signal from when it was queued. Resuming the table
// creates a new signal, so late replies and continuations from before /pause stay cancelled.
import { AsyncLocalStorage } from "node:async_hooks";

export class Generation {
  constructor(paused = false) {
    this.tasks = new AsyncLocalStorage();
    this.controller = new AbortController();
    if (paused) this.pause();
  }
  get paused() { return this.controller.signal.aborted; }
  get signal() { return this.tasks.getStore() ?? this.controller.signal; }
  pause() { this.controller.abort(new DOMException("Table paused by a player", "AbortError")); }
  resume() { if (this.paused) this.controller = new AbortController(); }

  task(fn) {
    const signal = this.signal;
    return () => signal.aborted ? undefined : this.tasks.run(signal, fn);
  }
}
