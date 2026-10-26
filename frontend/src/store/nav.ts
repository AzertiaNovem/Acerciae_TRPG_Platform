import { create } from 'zustand';
import { api } from '../api/client';
import type { Server, Channel, ChatWindow, Character, Scene, ServerSettings } from '../types';
import { chatSocket, contextSocket } from '../api/ws';

interface NavState {
  servers: Server[]; channels: Channel[]; windows: ChatWindow[]; characters: Character[]; scenes: Scene[];
  serverId: string | null; channelId: string | null; windowId: string | null; channel: Channel | null;
  gmWorkspaceOpen: boolean; error: string | null;
  serverSettings: ServerSettings | null;
  loadServers: () => Promise<void>;
  selectServer: (id: string) => Promise<void>;
  selectChannel: (id: string) => Promise<void>;
  selectWindow: (id: string) => void;
  refreshWindows: () => Promise<void>;
  refreshScenes: () => Promise<void>;
  refreshCharacters: () => Promise<void>;
  setGmWorkspaceOpen: (o: boolean) => void;
  applyWindowChange: (w: ChatWindow) => void;
  applySceneChange: (s: Scene) => void;
  loadServerSettings: () => Promise<void>;
  applyServerSettings: (s: Partial<ServerSettings> & { server_id: string }) => void;
  refreshChannel: () => Promise<void>;
}
export const useNav = create<NavState>((set, get) => ({
  servers: [], channels: [], windows: [], characters: [], scenes: [],
  serverId: null, channelId: null, windowId: null, channel: null, gmWorkspaceOpen: false, error: null, serverSettings: null,
  loadServers: async () => {
    const servers = await api.servers();
    set({ servers });
    const remembered = localStorage.getItem('acerciae.server');
    const pick = servers.find((s) => s.id === remembered) ?? servers[0];
    if (pick && !get().serverId) await get().selectServer(pick.id);
  },
  selectServer: async (id) => {
    localStorage.setItem('acerciae.server', id);
    const channels = await api.channels(id);
    set({ serverId: id, channels, channelId: null, windowId: null, channel: null, windows: [], scenes: [], serverSettings: null });
    get().loadServerSettings().catch(() => undefined);
    const remembered = localStorage.getItem('acerciae.channel');
    const pick = channels.find((c) => c.id === remembered) ?? channels[0];
    if (pick) await get().selectChannel(pick.id);
  },
  selectChannel: async (id) => {
    const prev = get().channelId;
    if (prev && prev !== id) { chatSocket.unsubscribe(prev); contextSocket.unsubscribe(prev); }
    localStorage.setItem('acerciae.channel', id);
    const [channel, windows, characters, scenes] = await Promise.all([api.channel(id), api.windows(id), api.characters(id), api.scenes(id)]);
    chatSocket.subscribe(id); contextSocket.subscribe(id);
    const remembered = localStorage.getItem(`acerciae.window.${id}`);
    const win = windows.find((w) => w.id === remembered) ?? windows[0];
    set({ channelId: id, channel, windows, characters, scenes, windowId: win?.id ?? null, gmWorkspaceOpen: false });
  },
  selectWindow: (id) => { const ch = get().channelId; if (ch) localStorage.setItem(`acerciae.window.${ch}`, id); set({ windowId: id, gmWorkspaceOpen: false }); },
  refreshWindows: async () => { const ch = get().channelId; if (!ch) return; set({ windows: await api.windows(ch) }); },
  refreshScenes: async () => { const ch = get().channelId; if (!ch) return; const [scenes, channel] = await Promise.all([api.scenes(ch), api.channel(ch)]); set({ scenes, channel }); },
  refreshCharacters: async () => { const ch = get().channelId; if (!ch) return; set({ characters: await api.characters(ch) }); },
  setGmWorkspaceOpen: (o) => set({ gmWorkspaceOpen: o }),
  applyWindowChange: (w) => set((s) => ({ windows: s.windows.some((x) => x.id === w.id) ? s.windows.map((x) => (x.id === w.id ? { ...x, ...w } : x)) : s.windows })),
  loadServerSettings: async () => { const id = get().serverId; if (!id) return; const st = await api.serverSettings(id); if (get().serverId === id) set({ serverSettings: st }); },
  // Pushed settings carry only the public view; keep the maintainer-only parts already loaded.
  applyServerSettings: (st) => set((s) => (s.serverId === st.server_id ? { serverSettings: { ...(s.serverSettings ?? {}), ...st } as ServerSettings, servers: st.name ? s.servers.map((x) => (x.id === st.server_id ? { ...x, name: st.name! } : x)) : s.servers } : s)),
  refreshChannel: async () => { const ch = get().channelId; if (!ch) return; const channel = await api.channel(ch); set({ channel }); },
  applySceneChange: (sc) => set((s) => ({ scenes: s.scenes.some((x) => x.id === sc.id) ? s.scenes.map((x) => (x.id === sc.id ? { ...x, ...sc } : x)) : [...s.scenes, sc] })),
}));
