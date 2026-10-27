import { create } from 'zustand';
import { api } from '../api/client';
import type { Reminder } from '../types';
import { sessionEpoch, isStale } from './session';

// Reminder bubbles for the current channel. Players see their group's, the Keeper their own.
interface ReminderState {
  list: Reminder[];
  openId: string | null;
  pulse: Record<string, number>;
  load: (ch: string) => Promise<void>;
  add: (r: Reminder) => void;
  open: (id: string | null) => void;
  dismiss: (ch: string, id: string) => Promise<void>;
  reset: () => void;
}
export const useReminders = create<ReminderState>((set) => ({
  list: [], openId: null, pulse: {},
  load: async (ch) => { const e = sessionEpoch(); const list = await api.reminders(ch); if (isStale(e)) return; set((s) => ({ list, openId: list.some((r) => r.id === s.openId) ? s.openId : null })); },
  add: (r) => set((s) => ({ list: s.list.some((x) => x.id === r.id) ? s.list : [r, ...s.list].slice(0, 12), pulse: { ...s.pulse, [r.id]: Date.now() } })),
  open: (id) => set({ openId: id }),
  dismiss: async (ch, id) => { set((s) => ({ list: s.list.filter((r) => r.id !== id), openId: s.openId === id ? null : s.openId })); try { await api.dismissReminder(ch, id); } catch { /* already gone */ } },
  reset: () => set({ list: [], openId: null, pulse: {} }),
}));
