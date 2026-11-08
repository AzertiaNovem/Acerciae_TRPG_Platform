/** One serial writer per project. Versions describe edits, never wall-clock time. */
export interface SaveState { edited: number; saved: number; writing: boolean; error: unknown }
interface Entry extends SaveState { timer?: ReturnType<typeof setTimeout>; pending?: Promise<boolean>; discarded: boolean }
export class SaveQueue<T> {
  private entries = new Map<string, Entry>();
  constructor(private io: { read: (id: string) => T | undefined; write: (value: T) => Promise<void>; error: (id: string, error: unknown) => void; saved: (id: string) => void }, private delay = 500) {}
  state(id: string): SaveState { const e = this.entries.get(id); return e ? { edited: e.edited, saved: e.saved, writing: e.writing, error: e.error } : { edited: 0, saved: 0, writing: false, error: null }; }
  dirty(id?: string): boolean { return id === undefined ? [...this.entries.values()].some(e => !e.discarded && e.edited > e.saved) : this.state(id).edited > this.state(id).saved; }
  edited(id: string) {
    let e = this.entries.get(id);
    if (!e) { e = { edited: 0, saved: 0, writing: false, error: null, discarded: false }; this.entries.set(id, e); }
    e.edited++;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => { void this.flush(id); }, this.delay);
  }
  flush(id: string): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e || e.discarded) return Promise.resolve(true);
    if (e.pending) return e.pending;
    clearTimeout(e.timer);
    const task = Promise.resolve().then(async () => {
      while (!e.discarded && e.saved < e.edited) {
        const version = e.edited, value = this.io.read(id);
        if (value === undefined) return false;
        e.writing = true;
        try { await this.io.write(value); }
        catch (error) { if (!e.discarded) { e.error = error; this.io.error(id, error); } return false; }
        finally { e.writing = false; }
        if (!e.discarded) { e.saved = version; e.error = null; this.io.saved(id); }
      }
      return true;
    }).finally(() => { if (e.pending === task) e.pending = undefined; });
    e.pending = task;
    return task;
  }
  /** Stop scheduling, then drain an already-started write before the caller deletes storage. */
  async discard(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    e.discarded = true;
    clearTimeout(e.timer);
    await e.pending;
    if (this.entries.get(id) === e) this.entries.delete(id);
  }
}
