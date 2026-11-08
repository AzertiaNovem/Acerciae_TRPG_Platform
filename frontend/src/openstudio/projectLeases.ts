/** Views and generation tasks hold independent leases; releasing twice is harmless. */
export class ProjectLeases {
  private counts = new Map<string, { view: number; task: number }>();
  active(id: string): boolean { const n = this.counts.get(id); return Boolean(n && (n.view || n.task)); }
  retain(id: string, kind: 'view' | 'task', idle: () => void): () => void {
    const n = this.counts.get(id) ?? { view: 0, task: 0 };
    this.counts.set(id, n); n[kind]++;
    let released = false;
    return () => { if (released) return; released = true; n[kind]--; if (!this.active(id)) { this.counts.delete(id); idle(); } };
  }
}
