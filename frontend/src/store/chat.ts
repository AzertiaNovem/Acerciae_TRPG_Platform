import { create } from 'zustand';
import { useUi } from './ui';
import { api } from '../api/client';
import type { Message } from '../types';
import { sessionEpoch, isStale } from './session';

function merge(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
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
  requestJump: (messageId: string) => void;
  clearJump: () => void;
  reset: () => void;
}
const olderInFlight = new Set<string>();
export const useChat = create<ChatState>((set, get) => ({
  byWindow: {}, loading: {}, jumpTo: null, references: [],
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
  requestJump: (messageId) => set({ jumpTo: { messageId, nonce: Date.now() } }),
  clearJump: () => set({ jumpTo: null }),
  reset: () => set({ byWindow: {}, loading: {}, jumpTo: null, references: [] }),
}));
