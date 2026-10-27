import { create } from 'zustand';
import type { ConsistencyResult, InspirationResult } from '../types';

interface Toast { id: number; text: string; kind?: 'info' | 'error' | 'ai' }
interface UiState {
  consistency: ConsistencyResult | null; consistencyBusy: boolean;
  inspiration: InspirationResult | null; inspirationBusy: boolean;
  composerInsert: { text: string; nonce: number } | null;
  toasts: Toast[];
  aiActivity: string | null;
  evidenceEventIds: string[] | null;
  setConsistency: (r: ConsistencyResult | null) => void; setConsistencyBusy: (b: boolean) => void;
  setInspiration: (r: InspirationResult | null) => void; setInspirationBusy: (b: boolean) => void;
  insertIntoComposer: (text: string) => void;
  toast: (text: string, kind?: Toast['kind']) => void; dismissToast: (id: number) => void;
  setAiActivity: (s: string | null) => void;
  showEvidence: (ids: string[] | null) => void;
  reset: () => void;
}
export const useUi = create<UiState>((set) => ({
  consistency: null, consistencyBusy: false, inspiration: null, inspirationBusy: false, composerInsert: null, toasts: [], aiActivity: null, evidenceEventIds: null,
  setConsistency: (r) => set({ consistency: r }), setConsistencyBusy: (b) => set({ consistencyBusy: b }),
  setInspiration: (r) => set({ inspiration: r }), setInspirationBusy: (b) => set({ inspirationBusy: b }),
  insertIntoComposer: (text) => set({ composerInsert: { text, nonce: Date.now() } }),
  toast: (text, kind = 'info') => { const id = Date.now() + Math.random(); set((s) => ({ toasts: [...s.toasts, { id, text, kind }] })); setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000); },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setAiActivity: (s) => set({ aiActivity: s }),
  showEvidence: (ids) => set({ evidenceEventIds: ids }),
  reset: () => set({ consistency: null, consistencyBusy: false, inspiration: null, inspirationBusy: false, composerInsert: null, aiActivity: null, evidenceEventIds: null }),
}));
