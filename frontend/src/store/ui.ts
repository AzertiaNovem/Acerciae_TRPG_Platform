import { create } from 'zustand';
import type { RecallResult } from '../types';

interface Toast { id: number; text: string; kind?: 'info' | 'error' | 'ai' }
interface UiState {
  recall: RecallResult | null; recallBusy: boolean;
  composerInsert: { text: string; nonce: number } | null;
  toasts: Toast[];
  aiActivity: string | null;
  evidenceEventIds: string[] | null;
  setRecall: (r: RecallResult | null) => void; setRecallBusy: (b: boolean) => void;
  insertIntoComposer: (text: string) => void;
  toast: (text: string, kind?: Toast['kind']) => void; dismissToast: (id: number) => void;
  setAiActivity: (s: string | null) => void;
  showEvidence: (ids: string[] | null) => void;
  reset: () => void;
}
export const useUi = create<UiState>((set) => ({
  recall: null, recallBusy: false, composerInsert: null, toasts: [], aiActivity: null, evidenceEventIds: null,
  setRecall: (r) => set({ recall: r }), setRecallBusy: (b) => set({ recallBusy: b }),
  insertIntoComposer: (text) => set({ composerInsert: { text, nonce: Date.now() } }),
  toast: (text, kind = 'info') => { const id = Date.now() + Math.random(); set((s) => ({ toasts: [...s.toasts, { id, text, kind }] })); setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000); },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setAiActivity: (s) => set({ aiActivity: s }),
  showEvidence: (ids) => set({ evidenceEventIds: ids }),
  reset: () => set({ recall: null, recallBusy: false, composerInsert: null, aiActivity: null, evidenceEventIds: null }),
}));
