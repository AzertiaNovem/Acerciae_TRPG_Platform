import { create } from 'zustand';
import { api } from '../api/client';
import type { KpBoard } from '../types';
import { sessionEpoch, isStale } from './session';

// The Keeper's pinned board: what the script plans next, and the Keeper's notes. Keeper only.
interface KpState {
  board: KpBoard | null;
  openSlot: 'next' | 'notes' | null;
  pulse: number;
  load: (ch: string) => Promise<void>;
  set: (b: KpBoard) => void;
  open: (slot: 'next' | 'notes' | null) => void;
  reset: () => void;
}
export const useKp = create<KpState>((set) => ({
  board: null, openSlot: null, pulse: 0,
  load: async (ch) => { const e = sessionEpoch(); try { const board = await api.kpBoard(ch); if (isStale(e)) return; set({ board }); } catch { /* players have no board */ } },
  set: (board) => set({ board, pulse: Date.now() }),
  open: (slot) => set({ openSlot: slot }),
  reset: () => set({ board: null, openSlot: null, pulse: 0 }),
}));
