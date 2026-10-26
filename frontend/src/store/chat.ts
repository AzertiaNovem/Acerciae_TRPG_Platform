import { create } from 'zustand';
import { api } from '../api/client';
import type { Message } from '../types';

interface ChatState {
  byWindow: Record<string, Message[]>;
  loading: Record<string, boolean>;
  jumpTo: { messageId: string; nonce: number } | null;
  load: (channelId: string, windowId: string) => Promise<void>;
  loadOlder: (channelId: string, windowId: string) => Promise<void>;
  push: (m: Message) => void;
  requestJump: (messageId: string) => void;
}
export const useChat = create<ChatState>((set, get) => ({
  byWindow: {}, loading: {}, jumpTo: null,
  load: async (ch, w) => {
    set((s) => ({ loading: { ...s.loading, [w]: true } }));
    const msgs = await api.messages(ch, w);
    set((s) => ({ byWindow: { ...s.byWindow, [w]: msgs }, loading: { ...s.loading, [w]: false } }));
  },
  loadOlder: async (ch, w) => {
    const cur = get().byWindow[w] ?? [];
    if (!cur.length) return;
    const older = await api.messages(ch, w, cur[0].seq);
    if (!older.length) return;
    set((s) => ({ byWindow: { ...s.byWindow, [w]: [...older, ...(s.byWindow[w] ?? [])] } }));
  },
  push: (m) => set((s) => {
    const list = s.byWindow[m.chat_window_id] ?? [];
    if (list.some((x) => x.id === m.id)) return s;
    return { byWindow: { ...s.byWindow, [m.chat_window_id]: [...list, m].sort((a, b) => a.seq - b.seq) } };
  }),
  requestJump: (messageId) => set({ jumpTo: { messageId, nonce: Date.now() } }),
}));
