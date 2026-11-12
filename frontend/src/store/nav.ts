import { create } from 'zustand';
import { readStorage, writeStorage } from '../lib/storage';
import { api, desktopAccounts } from '../api/client';
import type { Server, Channel, ChatWindow, Character, Scene, ServerSettings, SpectatableChannel } from '../types';
import { chatSocket, contextSocket } from '../api/ws';
import { sessionEpoch, bumpEpoch, isStale } from './session';
import { resetChannelStores } from './reset';
import { replaceNextRoute, type CharacterTab, type GmTab } from '../lib/route';

// Each desktop login returns to its own server, channel and chat window.
function selectionKey(key: string) {
  const slot = desktopAccounts?.selected()?.slot;
  return slot ? `${key}.account.${slot}` : key;
}

interface NavState {
  servers: Server[]; channels: Channel[]; windows: ChatWindow[]; characters: Character[]; scenes: Scene[];
  serverId: string | null; channelId: string | null; windowId: string | null; channel: Channel | null;
  gmWorkspaceOpen: boolean; studioOpen: boolean; characterSpaceId: string | null; error: string | null;
  gmTab: GmTab; characterTab: CharacterTab;   // the open tab of the GM workspace and of the character space (both in the URL)
  // Server or channel switches under way. The URL is written once one is done, so the steps in between (the old
  // channel's views being reset, a server whose channel is still loading) never become entries of their own.
  pending: number;
  adminOpen: boolean;   // the platform admin panel (administrators only)
  serverSettings: ServerSettings | null;
  // Channels of this server the user may read (Main Chat only) without being a member, and the one being read.
  spectatable: SpectatableChannel[]; spectateChannelId: string | null;
  loadSpectatable: () => Promise<void>;
  openSpectate: (id: string | null) => void;
  // `target` (from the URL) names the server, channel and window to open first; otherwise the remembered ones.
  loadServers: (target?: { server?: string; channel?: string; window?: string }) => Promise<void>;
  selectServer: (id: string, prefer?: { channel?: string; window?: string }) => Promise<void>;
  selectChannel: (id: string, preferWindow?: string) => Promise<void>;
  selectWindow: (id: string) => void;
  refreshWindows: () => Promise<void>;
  refreshScenes: () => Promise<void>;
  refreshCharacters: () => Promise<void>;
  setGmWorkspaceOpen: (o: boolean, tab?: GmTab) => void;
  setGmTab: (t: GmTab) => void;
  setStudioOpen: (o: boolean) => void;
  setAdminOpen: (o: boolean) => void;
  openCharacter: (id: string | null, tab?: CharacterTab) => void;
  setCharacterTab: (t: CharacterTab) => void;
  // Back to the chat: closes the workspaces, the character space and the spectated channel.
  showChat: () => void;
  applyWindowChange: (w: ChatWindow) => void;
  setUnread: (windowId: string, unread: number | ((n: number) => number)) => void;
  applySceneChange: (s: Scene) => void;
  reset: () => void;
  loadServerSettings: () => Promise<void>;
  applyServerSettings: (s: Partial<ServerSettings> & { server_id: string }) => void;
  refreshChannel: () => Promise<void>;
  // A server or channel was deleted: drop it, and move on if it was the one open.
  forgetServer: (id: string) => Promise<void>;
  forgetChannel: (id: string) => Promise<void>;
}
const initial = (): Pick<NavState, 'servers' | 'channels' | 'windows' | 'characters' | 'scenes' | 'serverId' | 'channelId' | 'windowId' | 'channel' | 'gmWorkspaceOpen' | 'studioOpen' | 'characterSpaceId' | 'error' | 'serverSettings' | 'spectatable' | 'spectateChannelId' | 'adminOpen' | 'gmTab' | 'characterTab' | 'pending'> => ({ servers: [], channels: [], windows: [], characters: [], scenes: [], serverId: null, channelId: null, windowId: null, channel: null, gmWorkspaceOpen: false, studioOpen: false, characterSpaceId: null, error: null, serverSettings: null, spectatable: [], spectateChannelId: null, adminOpen: false, gmTab: 'overview', characterTab: 'card', pending: 0 });
export const useNav = create<NavState>((set, get) => {
  // Runs a switch with `pending` raised (see NavState.pending).
  const switching = async (work: () => Promise<void>) => {
    set({ pending: get().pending + 1 });
    try { await work(); } finally { set({ pending: Math.max(0, get().pending - 1) }); }
  };
  return {
  ...initial(),
  reset: () => { const prev = get().channelId; if (prev) { chatSocket.unsubscribe(prev); contextSocket.unsubscribe(prev); } const sp = get().spectateChannelId; if (sp) chatSocket.stopSpectating(sp); set({ ...initial(), pending: get().pending }); },
  forgetServer: async (id) => {
    const servers = get().servers.filter((s) => s.id !== id);
    if (get().serverId !== id) { set({ servers }); return; }
    replaceNextRoute(); get().reset(); await get().loadServers();
  },
  forgetChannel: (id) => switching(async () => {
    const s = get();
    const channels = s.channels.filter((c) => c.id !== id);
    set({ channels, spectatable: s.spectatable.filter((c) => c.id !== id) });
    if (s.spectateChannelId === id) get().openSpectate(null);
    if (s.channelId !== id) return;
    replaceNextRoute();
    chatSocket.unsubscribe(id); contextSocket.unsubscribe(id); bumpEpoch(); resetChannelStores();
    set({ channelId: null, channel: null, windows: [], characters: [], scenes: [], windowId: null, gmWorkspaceOpen: false, studioOpen: false, characterSpaceId: null });
    if (channels[0]) await get().selectChannel(channels[0].id);
  }),
  loadServers: async (target) => {
    const e = sessionEpoch();
    const servers = await api.servers();
    if (isStale(e)) return;
    set({ servers });
    const remembered = readStorage(selectionKey('acerciae.server'));
    const asked = servers.find((s) => s.id === target?.server);
    const pick = asked ?? servers.find((s) => s.id === remembered) ?? servers[0];
    if (pick && !get().serverId) await get().selectServer(pick.id, asked ? target : undefined);
  },
  selectServer: (id, prefer) => switching(async () => {
    writeStorage(selectionKey('acerciae.server'), id);
    const e = sessionEpoch();
    // A suspended server answers nothing; its members see the notice instead of its channels.
    if (get().servers.find((s) => s.id === id)?.suspended) {
      const prev = get().channelId; if (prev) { chatSocket.unsubscribe(prev); contextSocket.unsubscribe(prev); }
      set({ serverId: id, channels: [], channelId: null, windowId: null, channel: null, windows: [], scenes: [], serverSettings: null, spectatable: [], spectateChannelId: null, adminOpen: false });
      return;
    }
    const channels = await api.channels(id);
    if (isStale(e)) return;
    const sp = get().spectateChannelId; if (sp) chatSocket.stopSpectating(sp);
    // The previous server's channel stops streaming to this client.
    const prevChannel = get().channelId; if (prevChannel) { chatSocket.unsubscribe(prevChannel); contextSocket.unsubscribe(prevChannel); }
    set({ serverId: id, channels, channelId: null, windowId: null, channel: null, windows: [], scenes: [], serverSettings: null, spectatable: [], spectateChannelId: null, adminOpen: false });

    const remembered = readStorage(selectionKey('acerciae.channel'));
    const asked = channels.find((c) => c.id === prefer?.channel);
    const pick = asked ?? channels.find((c) => c.id === remembered) ?? channels[0];
    if (pick) await get().selectChannel(pick.id, asked ? prefer?.window : undefined);
    get().loadServerSettings().catch(() => undefined);
    get().loadSpectatable().catch(() => undefined);
  }),
  selectChannel: (id, preferWindow) => switching(async () => {
    const prev = get().channelId;
    if (prev && prev !== id) { chatSocket.unsubscribe(prev); contextSocket.unsubscribe(prev); }
    // A channel switch starts a new context epoch: documents, highlights, panels and jump targets of the
    // previous channel are dropped and any of its still-running requests are ignored on arrival.
    if (prev !== id) { bumpEpoch(); resetChannelStores(); }
    const e = sessionEpoch();
    writeStorage(selectionKey('acerciae.channel'), id);
    const [channel, windows, characters, scenes] = await Promise.all([api.channel(id), api.windows(id), api.characters(id), api.scenes(id)]);
    if (isStale(e)) return;
    chatSocket.subscribe(id); contextSocket.subscribe(id);
    const remembered = readStorage(selectionKey(`acerciae.window.${id}`));
    const win = windows.find((w) => w.id === preferWindow) ?? windows.find((w) => w.id === remembered) ?? windows[0];
    if (win && win.id === preferWindow) writeStorage(selectionKey(`acerciae.window.${id}`), win.id);
    get().openSpectate(null);
    set({ channelId: id, channel, windows, characters, scenes, windowId: win?.id ?? null, gmWorkspaceOpen: false, studioOpen: false, characterSpaceId: null, gmTab: 'overview', characterTab: 'card' });
  }),
  selectWindow: (id) => { const ch = get().channelId; if (ch) writeStorage(selectionKey(`acerciae.window.${ch}`), id); get().openSpectate(null); set({ windowId: id, gmWorkspaceOpen: false, studioOpen: false, characterSpaceId: null }); },
  loadSpectatable: async () => { const id = get().serverId; if (!id) return; const e = sessionEpoch(); const list = await api.spectatableChannels(id); if (!isStale(e) && get().serverId === id) set({ spectatable: list }); },
  openSpectate: (id) => { const prev = get().spectateChannelId; if (prev === id) return; if (prev) chatSocket.stopSpectating(prev); if (id) chatSocket.spectate(id); set({ spectateChannelId: id }); },
  refreshWindows: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const windows = await api.windows(ch); if (isStale(e) || get().channelId !== ch) return; if (!windows.some((w) => w.id === get().windowId)) replaceNextRoute(); set(s=>({ windows, windowId:windows.some(w=>w.id===s.windowId)?s.windowId:windows[0]?.id??null })); },
  refreshScenes: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const [scenes, channel] = await Promise.all([api.scenes(ch), api.channel(ch)]); if (isStale(e) || get().channelId !== ch) return; set({ scenes, channel }); },
  refreshCharacters: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const characters = await api.characters(ch); if (isStale(e) || get().channelId !== ch) return; set({ characters }); },
  setGmWorkspaceOpen: (o, tab = 'overview') => set({ gmWorkspaceOpen: o, gmTab: o ? tab : get().gmTab, studioOpen: o ? false : get().studioOpen, characterSpaceId: o ? null : get().characterSpaceId }),
  setGmTab: (t) => set({ gmTab: t }),
  setStudioOpen: (o) => set({ studioOpen: o, gmWorkspaceOpen: o ? false : get().gmWorkspaceOpen, characterSpaceId: o ? null : get().characterSpaceId }),
  setAdminOpen: (o) => set({ adminOpen: o }),
  openCharacter: (id, tab = 'card') => set({ characterSpaceId: id, characterTab: tab, gmWorkspaceOpen: id ? false : get().gmWorkspaceOpen, studioOpen: id ? false : get().studioOpen }),
  setCharacterTab: (t) => set({ characterTab: t }),
  showChat: () => { get().openSpectate(null); set({ gmWorkspaceOpen: false, studioOpen: false, characterSpaceId: null, adminOpen: false }); },
  applyWindowChange: (w) => set((s) => ({ windows: s.windows.some((x) => x.id === w.id) ? s.windows.map((x) => (x.id === w.id ? { ...x, ...w } : x)) : s.windows })),
  setUnread: (id, unread) => set((s) => ({ windows: s.windows.map((x) => (x.id === id ? { ...x, unread: Math.max(0, typeof unread === 'function' ? unread(x.unread ?? 0) : unread) } : x)) })),
  loadServerSettings: async () => { const id = get().serverId; if (!id) return; const e = sessionEpoch(); const st = await api.serverSettings(id); if (!isStale(e) && get().serverId === id) set({ serverSettings: st }); },
  // Pushed settings carry only the public view; keep the maintainer-only parts already loaded.
  applyServerSettings: (st) => set((s) => (s.serverId === st.server_id ? { serverSettings: { ...(s.serverSettings ?? {}), ...st } as ServerSettings, servers: st.name ? s.servers.map((x) => (x.id === st.server_id ? { ...x, name: st.name! } : x)) : s.servers } : s)),
  refreshChannel: async () => { const ch = get().channelId; if (!ch) return; const e = sessionEpoch(); const channel = await api.channel(ch); if (!isStale(e) && get().channelId === ch) set({ channel }); },
  applySceneChange: (sc) => set((s) => ({ scenes: s.scenes.some((x) => x.id === sc.id) ? s.scenes.map((x) => (x.id === sc.id ? { ...x, ...sc } : x)) : [...s.scenes, sc] })),
  };
});
