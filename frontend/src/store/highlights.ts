import { create } from 'zustand';
import { api } from '../api/client';
import type { Highlight } from '../types';

// Short-term attention state, decoupled from document bodies.
interface HighlightState {
  byId: Record<string, Highlight>;
  load: (ch: string) => Promise<void>;
  add: (h: Highlight) => void;
  remove: (ids: string[]) => void;
  dismiss: (ch: string, id: string) => Promise<void>;
  forEntry: (entryId: string) => Highlight[];
  forDocument: (docId: string) => Highlight[];
  prune: () => void;
}
export const useHighlights = create<HighlightState>((set, get) => ({
  byId: {},
  load: async (ch) => { const hs = await api.highlights(ch); const byId: Record<string, Highlight> = {}; for (const h of hs) byId[h.id] = h; set({ byId }); },
  add: (h) => set((s) => ({ byId: { ...s.byId, [h.id]: h } })),
  remove: (ids) => set((s) => { const byId = { ...s.byId }; for (const id of ids) delete byId[id]; return { byId }; }),
  dismiss: async (ch, id) => { get().remove([id]); try { await api.dismissHighlight(ch, id); } catch { /* already gone */ } },
  forEntry: (entryId) => Object.values(get().byId).filter((h) => h.target_entry_id === entryId),
  forDocument: (docId) => Object.values(get().byId).filter((h) => h.document_id === docId),
  prune: () => set((s) => { const now = Date.now(); const byId: Record<string, Highlight> = {}; for (const h of Object.values(s.byId)) if (new Date(h.expires_at).getTime() > now) byId[h.id] = h; return { byId }; }),
}));
