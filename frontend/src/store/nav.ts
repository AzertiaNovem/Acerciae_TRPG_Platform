import { create } from 'zustand';
import { api } from '../api/client';
import type { Server, Channel, ChatWindow, Character, Scene } from '../types';
import { chatSocket, contextSocket } from '../api/ws';
import { sessionEpoch, bumpEpoch, isStale } from './session';
import { resetChannelStores } from './reset';

interface NavState {
  servers: Server[]; channels: Channel[]; windows: ChatWindow[]; characters: Character[]; scenes: Scene[];
  serverId: string | null; channelId: string | null; windowId: string | null; channel: Channel | null;
  gmWorkspaceOpen: boolean; studioOpen: boolean; error: string | null;
  loadServers: () => Promise<void>;
  selectServer: (id: string) => Promise<void>;
  selectChannel: (id: string) => Promise<void>;
  selectWindow: (id: string) => void;
  refreshWindows: () => Promise<void>;
  refreshScenes: () => Promise<void>;
  refreshCharacters: () => Promise<void>;
  setGmWorkspaceOpen: (o: boolean) => void;
  setStudioOpen: (o: boolean) => void;
  applyWindowChange: (w: ChatWindow) => void;
  applySceneChange: (s: Scene) => void;
  reset: () => void;
}
const initial = (): Pick<NavState, 'servers' | 'channels' | 'windows' | 'characters' | 'scenes' | 'serverId' | 'channelId' | 'windowId' | 'channel' | 'gmWorkspaceOpen' | 'studioOpen' | 'error'> => ({ servers: [], channels: [], windows: [], characters: [], scenes: [], serverId: null, channelId: null, windowId: null, channel: null, gmWorkspaceOpen: false, studioOpen: false, error: null });
export const useNav = create<NavState>((set, get) => ({
  ...initial(),
  reset: () => { const prev = get().channelId; if (prev) { chatSocket.unsubscribe(prev); contextSocket.unsubscribe(prev); } set(initial()); },
  loadServers: async () => {
    const e = sessionEpoch();
    const servers = await api.servers();
    if (isStale(e)) return;
    set({ servers });
    const remembered = localStorage.getItem('acerciae.server');
    const pick = servers.find((s) => s.id === remembered) ?? servers[0];
    if (pick && !get().serverId) await get().selectServer(pick.id);
  },
  selectServer: async (id) => {
    localStorage.setItem('acerciae.server', id);
    const e = sessionEpoch();
    const channels = await api.channels(id);
    if (isStale(e)) return;
    set({ serverId: id, channels, channelId: null, windowId: null, channel: null, windows: [], scenes: [] });
    const remembered = localStorage.getItem('acerciae.channel');
    const pick = channels.find((c) => c.id === remembered) ?? channels[0];
    if (pick) await get().selectChannel(pick.id);
  },
  selectChannel: async (id) => {
    const prev = get().channelId;
    if (prev && prev !== id) { chatSocket.unsubscribe(prev); contextSocket.unsubscribe(prev); }
    // A channel switch starts a new context epoch: documents, highlights, panels and jump targets of the
    // previous channel are dropped and any of its still-running requests are ignored on arrival.
    if (prev !== id) { bumpEpoch(); resetChannelStores(); }
    const e = sessionEpoch();
    localStorage.setItem('acerciae.channel', id);
    const [channel, windows, characters, scenes] = await Promise.all([api.channel(id), api.windows(id), api.characters(id), api.scenes(id)]);
    if (isStale(e)) return;
    chatSocket.subscribe(id); contextSocket.subscribe(id);
    const remembered = localStorage.getItem(`acerciae.window.${id}`);
    const win = windows.find((w) => w.id === remembered) ?? windows[0];
    set({ channelId: id, channel, windows, characters, scenes, windowId: win?.id ?? null, gmWorkspaceOpen: false, studioOpen: false });
  },
  selectWindow: (id) => { const ch = get().channelId; if (ch) localStorage.setItem(`acerciae.window.${ch}`, id); set({ windowId: id, gmWorkspaceOpen: false, studioOpen: false }); },
  refreshWindows: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const windows = await api.windows(ch); if (isStale(e) || get().channelId !== ch) return; set({ windows }); },
  refreshScenes: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const [scenes, channel] = await Promise.all([api.scenes(ch), api.channel(ch)]); if (isStale(e) || get().channelId !== ch) return; set({ scenes, channel }); },
  refreshCharacters: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const characters = await api.characters(ch); if (isStale(e) || get().channelId !== ch) return; set({ characters }); },
  setGmWorkspaceOpen: (o) => set({ gmWorkspaceOpen: o, studioOpen: o ? false : get().studioOpen }),
  setStudioOpen: (o) => set({ studioOpen: o, gmWorkspaceOpen: o ? false : get().gmWorkspaceOpen }),
  applyWindowChange: (w) => set((s) => ({ windows: s.windows.some((x) => x.id === w.id) ? s.windows.map((x) => (x.id === w.id ? { ...x, ...w } : x)) : s.windows })),
  applySceneChange: (sc) => set((s) => ({ scenes: s.scenes.some((x) => x.id === sc.id) ? s.scenes.map((x) => (x.id === sc.id ? { ...x, ...sc } : x)) : [...s.scenes, sc] })),
}));
