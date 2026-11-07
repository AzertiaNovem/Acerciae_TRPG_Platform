import { create } from 'zustand';
import { useUi } from './ui';
import { api } from '../api/client';
import type { Message } from '../types';
import { sessionEpoch, isStale } from './session';

// A recall is final: a copy fetched before it (a reload still in flight) never replaces the tombstone.
const keep = (prev: Message | undefined, next: Message) => !(prev?.recalled_at && !next.recalled_at);
function merge(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) if (keep(byId.get(m.id), m)) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

// When each message stops being recallable, from `recall_seconds_left` the first time it arrived (local clock).
const recallDeadlines = new Map<string, number>();
export function recallDeadline(m: Message): number | null {
  if (m.recalled_at || !m.recall_seconds_left) return null;
  const seen = recallDeadlines.get(m.id);
  const now = Date.now() + m.recall_seconds_left * 1000;
  if (seen === undefined || now < seen) recallDeadlines.set(m.id, now);
  return recallDeadlines.get(m.id)!;
}
// The server's refusals, in words the interface translates.
export function recallError(err: any): string {
  if (err?.code === 'recall_expired') return 'Messages can only be recalled within 2 minutes of sending.';
  if (err?.code === 'not_recallable') return "This message can't be recalled.";
  return err?.message ?? String(err);
}

interface ChatState {
  byWindow: Record<string, Message[]>;
  loading: Record<string, boolean>;
  references: Message[];
  addReference: (message: Message) => void;
  removeReference: (id: string) => void;
  clearReferences: () => void;
  jumpTo: { messageId: string; nonce: number } | null;
  load: (channelId: string, windowId: string) => Promise<void>;
  loadOlder: (channelId: string, windowId: string) => Promise<void>;
  push: (m: Message) => void;
  // A recalled line's tombstone takes its place in every window that shows it (forks show their parents' lines).
  applyRecall: (tombstone: Message) => void;
  // The author's own recall; the text comes back as a draft for "Re-edit".
  recall: (m: Message) => Promise<void>;
  recallDrafts: Record<string, string>;
  requestJump: (messageId: string) => void;
  clearJump: () => void;
  reset: () => void;
}
const olderInFlight = new Set<string>();
export const useChat = create<ChatState>((set, get) => ({
  byWindow: {}, loading: {}, jumpTo: null, references: [], recallDrafts: {},
  addReference: (m) => set(s=>({references:s.references.some(r=>r.id===m.id)?s.references:[...s.references,m].slice(0,5)})),
  removeReference: (id) => set(s=>({references:s.references.filter(m=>m.id!==id)})),
  clearReferences: () => set({references:[]}),
  load: async (ch, w) => {
    const e = sessionEpoch();
    set((s) => ({ loading: { ...s.loading, [w]: true } }));
    try {
      const msgs = await api.messages(ch, w);
      if (isStale(e)) return;
      // Merge: messages that arrived over the WebSocket while the request was in flight are kept.
      set((s) => ({ byWindow: { ...s.byWindow, [w]: merge(s.byWindow[w] ?? [], msgs) } }));
    } catch (err: any) { if (!isStale(e)) useUi.getState().toast(err.message, 'error'); }
    finally { if (!isStale(e)) set((s) => ({ loading: { ...s.loading, [w]: false } })); }
  },
  loadOlder: async (ch, w) => {
    const cur = get().byWindow[w] ?? [];
    if (!cur.length || olderInFlight.has(w)) return;   // scrolling fires this many times; one request at a time
    olderInFlight.add(w);
    const e = sessionEpoch();
    try {
      const older = await api.messages(ch, w, cur[0].seq);
      if (isStale(e) || !older.length) return;
      set((s) => ({ byWindow: { ...s.byWindow, [w]: merge(s.byWindow[w] ?? [], older) } }));
    } catch (err: any) { useUi.getState().toast(err.message, 'error'); }
    finally { olderInFlight.delete(w); }
  },
  push: (m) => set((s) => {
    const list = s.byWindow[m.chat_window_id] ?? [];
    if (list.some((x) => x.id === m.id)) return s;
    return { byWindow: { ...s.byWindow, [m.chat_window_id]: [...list, m].sort((a, b) => a.seq - b.seq) } };
  }),
  applyRecall: (tombstone) => set((s) => {
    const byWindow: Record<string, Message[]> = {};
    for (const [w, list] of Object.entries(s.byWindow)) byWindow[w] = list.some((m) => m.id === tombstone.id) ? list.map((m) => (m.id === tombstone.id ? tombstone : m)) : list;
    return { byWindow, references: s.references.filter((m) => m.id !== tombstone.id) };
  }),
  recall: async (m) => {
    const e = sessionEpoch();
    try {
      const r = await api.recallMessage(m.channel_id, m.id);
      if (isStale(e)) return;
      get().applyRecall(r.message);
      if (r.content) set((s) => ({ recallDrafts: { ...s.recallDrafts, [m.id]: r.content } }));
    } catch (err: any) { if (!isStale(e)) useUi.getState().toast(recallError(err), 'error'); }
  },
  requestJump: (messageId) => set({ jumpTo: { messageId, nonce: Date.now() } }),
  clearJump: () => set({ jumpTo: null }),
  reset: () => { recallDeadlines.clear(); set({ byWindow: {}, loading: {}, jumpTo: null, references: [], recallDrafts: {} }); },
}));
