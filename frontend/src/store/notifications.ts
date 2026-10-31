import { create } from 'zustand';
import { readStorage, writeStorage } from '../lib/storage';
import type { Message } from '../types';

// In-channel message banners (top-right, macOS style). Each one is a message posted in another window of the channel
// being viewed; they leave on their own after a few seconds, on a click, or when the channel changes.
export interface MessageNotice { id: string; message: Message; windowName: string; avatar: string; at: number }
interface NotificationState {
  enabled: boolean;
  notices: MessageNotice[];
  setEnabled: (on: boolean) => void;
  push: (n: MessageNotice) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}
const KEY = 'acerciae.notifications';
export const MAX_NOTICES = 4;
export const useNotifications = create<NotificationState>((set) => ({
  enabled: readStorage(KEY) !== 'off',
  notices: [],
  setEnabled: (on) => { writeStorage(KEY, on ? null : 'off'); set(on ? { enabled: true } : { enabled: false, notices: [] }); },
  push: (n) => set((s) => (s.notices.some((x) => x.id === n.id) ? s : { notices: [n, ...s.notices].slice(0, MAX_NOTICES) })),
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((x) => x.id !== id) })),
  clear: () => set({ notices: [] }),
}));
