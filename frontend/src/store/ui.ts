import { create } from 'zustand';
import type { ConsistencyResult, InspirationResult, InterfaceTheme } from '../types';

interface Toast { id: number; text: string; kind?: 'info' | 'error' | 'ai' }
interface UiState {
  themePreview: InterfaceTheme | null;
  consistency: ConsistencyResult | null; consistencyBusy: boolean;
  inspiration: InspirationResult | null; inspirationBusy: boolean;
  composerInsert: { text: string; nonce: number } | null;
  // The composer's "Speak as" choice per chat window ('' or missing: the default character). Interactive messages post
  // a viewer's line as the same character.
  speakAs: Record<string, string>;
  toasts: Toast[];
  aiActivity: string | null;
  evidenceEventIds: string[] | null;
  setConsistency: (r: ConsistencyResult | null) => void; setConsistencyBusy: (b: boolean) => void;
  setInspiration: (r: InspirationResult | null) => void; setInspirationBusy: (b: boolean) => void;
  insertIntoComposer: (text: string) => void;
  setSpeakAs: (windowId: string, characterId: string) => void;
  toast: (text: string, kind?: Toast['kind']) => void; dismissToast: (id: number) => void;
  setAiActivity: (s: string | null) => void;
  showEvidence: (ids: string[] | null) => void;
  reset: () => void;
}
export const useUi = create<UiState>((set) => ({
  themePreview: null, consistency: null, consistencyBusy: false, inspiration: null, inspirationBusy: false, composerInsert: null, speakAs: {}, toasts: [], aiActivity: null, evidenceEventIds: null,
  setConsistency: (r) => set({ consistency: r }), setConsistencyBusy: (b) => set({ consistencyBusy: b }),
  setInspiration: (r) => set({ inspiration: r }), setInspirationBusy: (b) => set({ inspirationBusy: b }),
  insertIntoComposer: (text) => set({ composerInsert: { text, nonce: Date.now() } }),
  setSpeakAs: (windowId, characterId) => set((s) => ({ speakAs: { ...s.speakAs, [windowId]: characterId } })),
  toast: (text, kind = 'info') => { const id = Date.now() + Math.random(); set((s) => ({ toasts: [...s.toasts, { id, text, kind }] })); setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000); },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setAiActivity: (s) => set({ aiActivity: s }),
  showEvidence: (ids) => set({ evidenceEventIds: ids }),
  reset: () => set({ themePreview: null, consistency: null, consistencyBusy: false, inspiration: null, inspirationBusy: false, composerInsert: null, speakAs: {}, aiActivity: null, evidenceEventIds: null }),
}));
