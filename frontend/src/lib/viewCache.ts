import { snapshots } from './viewSnapshots';
// A session's authorized JSON views. Subscribers can paint a snapshot immediately, while callers
// awaiting the promise always receive the verified result (including after a write).
export interface ViewOptions<T> { cached?: (value: T) => void; maxAge?: number }
export interface Snapshot<T> { value: T; tag: string; checked: number }
export type ViewResponse<T> = { unchanged: true } | { unchanged: false; tag: string; value: T };
export class ViewCache {
  private account = '';
  setAccount(account: string) { this.clear(); this.account = account; }
  private entries = new Map<string, Snapshot<unknown>>();
  private pending = new Map<string, Promise<unknown>>();
  clear(prefix = '') {
    for (const map of [this.entries, this.pending]) for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
  }
  async read<T>(key: string, fetcher: (tag: string) => Promise<ViewResponse<T>>, options?: ViewOptions<T>): Promise<T> {
    const old = this.entries.get(key) as Snapshot<T> | undefined;
    if (old) options?.cached?.(old.value);
    const running = this.pending.get(key);
    if (running) return running as Promise<T>;
    if (old && options?.maxAge && Date.now() - old.checked < options.maxAge) return old.value;
    const diskKey = this.account && this.account + '|' + key;
    // A memory hit is immediate. After reload, recheck access before exposing even an identical body.
    let candidate = old;
    const run = Promise.resolve().then(async () => {
      if (!candidate && diskKey) candidate = await snapshots.get(diskKey) as Snapshot<T> | undefined;
      if (this.pending.get(key) !== run) throw new DOMException('View changed','AbortError');
      return fetcher(candidate?.tag ?? '');
    }).then(result => {
      if (this.pending.get(key) !== run) throw new DOMException('View changed', 'AbortError');
      if (result.unchanged && !candidate) throw Error('Missing cached view');
      const entry = result.unchanged ? candidate! : { value: result.value, tag: result.tag, checked: 0 };
      entry.checked = Date.now(); this.entries.set(key, entry);
      if (!result.unchanged && diskKey && entry.tag) void snapshots.put(diskKey,entry);
      return entry.value;
    }).catch(err => {
      if (this.pending.get(key) === run && [401,403,404].includes(err?.status)) { this.entries.delete(key); if (diskKey) void snapshots.put(diskKey); }
      throw err;
    }).finally(() => { if (this.pending.get(key) === run) this.pending.delete(key); });
    this.pending.set(key, run);
    return run;
  }
}
export const views = new ViewCache();
