import { create } from 'zustand';
import { api } from '../api/client';
import type { BotChat } from '../types';

// The signed-in person's private chats with the bots of the selected server (docs/BOTS.md). They are channels of their
// own that no channel list shows, so the sidebar and the address bar find them here.
interface BotChatsState {
  serverId: string | null; chats: BotChat[];
  load: (serverId: string) => Promise<BotChat[]>;
  open: (serverId: string, botId: string) => Promise<BotChat>;
  remove: (channelId: string) => Promise<void>;
  has: (channelId: string | null | undefined) => boolean;
}
export const useBotChats = create<BotChatsState>((set, get) => ({
  serverId: null, chats: [],
  load: async (serverId) => {
    const chats = await api.botChats(serverId).catch(() => [] as BotChat[]);
    set({ serverId, chats: Array.isArray(chats) ? chats : [] });
    return get().chats;
  },
  open: async (serverId, botId) => {
    const chat = await api.openBotChat(serverId, botId);
    await get().load(serverId);
    return chat;
  },
  remove: async (channelId) => {
    await api.deleteBotChat(channelId);
    set({ chats: get().chats.filter((c) => c.channel_id !== channelId) });
  },
  has: (channelId) => !!channelId && get().chats.some((c) => c.channel_id === channelId),
}));
