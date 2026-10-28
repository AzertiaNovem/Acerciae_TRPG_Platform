import { create } from 'zustand';
import { api } from '../api/client';
import type { Server, Channel, ChatWindow, Character, Scene, ServerSettings, SpectatableChannel } from '../types';
import { chatSocket, contextSocket } from '../api/ws';
import { sessionEpoch, bumpEpoch, isStale } from './session';
import { resetChannelStores } from './reset';

interface NavState {
  servers: Server[]; channels: Channel[]; windows: ChatWindow[]; characters: Character[]; scenes: Scene[];
  serverId: string | null; channelId: string | null; windowId: string | null; channel: Channel | null;
  gmWorkspaceOpen: boolean; studioOpen: boolean; characterSpaceId: string | null; error: string | null;
  serverSettings: ServerSettings | null;
  // Channels of this server the user may read (Main Chat only) without being a member, and the one being read.
  spectatable: SpectatableChannel[]; spectateChannelId: string | null;
  loadSpectatable: () => Promise<void>;
  openSpectate: (id: string | null) => void;
  loadServers: () => Promise<void>;
  selectServer: (id: string) => Promise<void>;
  selectChannel: (id: string) => Promise<void>;
  selectWindow: (id: string) => void;
  refreshWindows: () => Promise<void>;
  refreshScenes: () => Promise<void>;
  refreshCharacters: () => Promise<void>;
  setGmWorkspaceOpen: (o: boolean) => void;
  setStudioOpen: (o: boolean) => void;
  openCharacter: (id: string | null) => void;
  applyWindowChange: (w: ChatWindow) => void;
  applySceneChange: (s: Scene) => void;
  reset: () => void;
  loadServerSettings: () => Promise<void>;
  applyServerSettings: (s: Partial<ServerSettings> & { server_id: string }) => void;
  refreshChannel: () => Promise<void>;
}
const initial = (): Pick<NavState, 'servers' | 'channels' | 'windows' | 'characters' | 'scenes' | 'serverId' | 'channelId' | 'windowId' | 'channel' | 'gmWorkspaceOpen' | 'studioOpen' | 'characterSpaceId' | 'error' | 'serverSettings' | 'spectatable' | 'spectateChannelId'> => ({ servers: [], channels: [], windows: [], characters: [], scenes: [], serverId: null, channelId: null, windowId: null, channel: null, gmWorkspaceOpen: false, studioOpen: false, characterSpaceId: null, error: null, serverSettings: null, spectatable: [], spectateChannelId: null });
export const useNav = create<NavState>((set, get) => ({
  ...initial(),
  reset: () => { const prev = get().channelId; if (prev) { chatSocket.unsubscribe(prev); contextSocket.unsubscribe(prev); } const sp = get().spectateChannelId; if (sp) chatSocket.stopSpectating(sp); set(initial()); },
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
    const sp = get().spectateChannelId; if (sp) chatSocket.stopSpectating(sp);
    set({ serverId: id, channels, channelId: null, windowId: null, channel: null, windows: [], scenes: [], serverSettings: null, spectatable: [], spectateChannelId: null });

    const remembered = localStorage.getItem('acerciae.channel');
    const pick = channels.find((c) => c.id === remembered) ?? channels[0];
    if (pick) await get().selectChannel(pick.id);
    get().loadServerSettings().catch(() => undefined);
    get().loadSpectatable().catch(() => undefined);
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
    get().openSpectate(null);
    set({ channelId: id, channel, windows, characters, scenes, windowId: win?.id ?? null, gmWorkspaceOpen: false, studioOpen: false, characterSpaceId: null });
  },
  selectWindow: (id) => { const ch = get().channelId; if (ch) localStorage.setItem(`acerciae.window.${ch}`, id); get().openSpectate(null); set({ windowId: id, gmWorkspaceOpen: false, studioOpen: false, characterSpaceId: null }); },
  loadSpectatable: async () => { const id = get().serverId; if (!id) return; const e = sessionEpoch(); const list = await api.spectatableChannels(id); if (!isStale(e) && get().serverId === id) set({ spectatable: list }); },
  openSpectate: (id) => { const prev = get().spectateChannelId; if (prev === id) return; if (prev) chatSocket.stopSpectating(prev); if (id) chatSocket.spectate(id); set({ spectateChannelId: id }); },
  refreshWindows: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const windows = await api.windows(ch); if (isStale(e) || get().channelId !== ch) return; set(s=>({ windows, windowId:windows.some(w=>w.id===s.windowId)?s.windowId:windows[0]?.id??null })); },
  refreshScenes: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const [scenes, channel] = await Promise.all([api.scenes(ch), api.channel(ch)]); if (isStale(e) || get().channelId !== ch) return; set({ scenes, channel }); },
  refreshCharacters: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const characters = await api.characters(ch); if (isStale(e) || get().channelId !== ch) return; set({ characters }); },
  setGmWorkspaceOpen: (o) => set({ gmWorkspaceOpen: o, studioOpen: o ? false : get().studioOpen, characterSpaceId: o ? null : get().characterSpaceId }),
  setStudioOpen: (o) => set({ studioOpen: o, gmWorkspaceOpen: o ? false : get().gmWorkspaceOpen, characterSpaceId: o ? null : get().characterSpaceId }),
  openCharacter: (id) => set({ characterSpaceId: id, gmWorkspaceOpen: id ? false : get().gmWorkspaceOpen, studioOpen: id ? false : get().studioOpen }),
  applyWindowChange: (w) => set((s) => ({ windows: s.windows.some((x) => x.id === w.id) ? s.windows.map((x) => (x.id === w.id ? { ...x, ...w } : x)) : s.windows })),
  loadServerSettings: async () => { const id = get().serverId; if (!id) return; const e = sessionEpoch(); const st = await api.serverSettings(id); if (!isStale(e) && get().serverId === id) set({ serverSettings: st }); },
  // Pushed settings carry only the public view; keep the maintainer-only parts already loaded.
  applyServerSettings: (st) => set((s) => (s.serverId === st.server_id ? { serverSettings: { ...(s.serverSettings ?? {}), ...st } as ServerSettings, servers: st.name ? s.servers.map((x) => (x.id === st.server_id ? { ...x, name: st.name! } : x)) : s.servers } : s)),
  refreshChannel: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const channel = await api.channel(ch); if (!isStale(e) && get().channelId === ch) set({ channel }); },
  applySceneChange: (sc) => set((s) => ({ scenes: s.scenes.some((x) => x.id === sc.id) ? s.scenes.map((x) => (x.id === sc.id ? { ...x, ...sc } : x)) : [...s.scenes, sc] })),
}));
