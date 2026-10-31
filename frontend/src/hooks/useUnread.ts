import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { useNav } from '../store/nav';
import { useNotifications } from '../store/notifications';
import type { Message } from '../types';

// Whether the user is looking at this window right now: its chat is on screen and the page is visible.
export function isViewing(windowId: string): boolean {
  const nav = useNav.getState();
  return nav.windowId === windowId && !nav.gmWorkspaceOpen && !nav.studioOpen && !nav.characterSpaceId && !nav.spectateChannelId
    && typeof document !== 'undefined' && document.visibilityState === 'visible';
}

// A message arrived over the socket. If it is not on screen it counts as unread and, for a window the user has
// joined, shows a banner (only while the page is visible: the banners are for the channel being looked at).
export function onIncomingMessage(m: Message) {
  const me = useAuth.getState().user?.id;
  const nav = useNav.getState();
  if (m.channel_id !== nav.channelId || m.author_id === me || isViewing(m.chat_window_id)) return;
  const win = nav.windows.find((w) => w.id === m.chat_window_id);
  if (!win) return;
  nav.setUnread(win.id, (n) => n + 1);
  const notes = useNotifications.getState();
  const joined = win.kind === 'main' || (win.members ?? []).some((x) => x.user_id === me);
  if (!notes.enabled || !joined || document.visibilityState !== 'visible') return;
  const avatar = m.character_avatar_asset_id ? api.mediaUrl(m.channel_id, m.character_avatar_asset_id, m.character_avatar_version ?? undefined)
    : m.author_avatar_version ? api.avatarUrl(m.author_id, m.author_avatar_version) : '';
  notes.push({ id: m.id, message: m, windowName: win.name, avatar, at: Date.now() });
}

const marked = new Map<string, number>();   // window → the last seq reported read

// Marks the window on screen read up to its newest message: on opening it, as messages arrive, on returning to the tab.
export function useReadTracking() {
  const channelId = useNav((s) => s.channelId);
  const windowId = useNav((s) => s.windowId);
  const overlay = useNav((s) => !!(s.gmWorkspaceOpen || s.studioOpen || s.characterSpaceId || s.spectateChannelId));
  const lastSeq = useChat((s) => { const list = windowId ? s.byWindow[windowId] : undefined; return list?.length ? list[list.length - 1].seq : 0; });
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  useEffect(() => {
    if (!channelId || !windowId || overlay || !visible) return;
    const win = useNav.getState().windows.find((w) => w.id === windowId);
    if (!win) return;
    if ((win.unread ?? 0) > 0) useNav.getState().setUnread(windowId, 0);
    const seq = Math.max(lastSeq, win.last_seq ?? 0);
    if (!seq || (marked.get(windowId) ?? 0) >= seq) return;
    const timer = setTimeout(() => {
      marked.set(windowId, seq);
      api.markRead(channelId, windowId, seq).catch(() => marked.delete(windowId));
    }, 400);
    return () => clearTimeout(timer);
  }, [channelId, windowId, overlay, visible, lastSeq]);
}
