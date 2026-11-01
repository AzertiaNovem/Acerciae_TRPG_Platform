import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { useNav } from '../store/nav';
import { useNotifications } from '../store/notifications';
import type { Message } from '../types';
import { isDesktop } from '../lib/platform';

// Whether the user is looking at this window right now: its chat is on screen and the page is visible.
export function isViewing(windowId: string): boolean {
  const nav = useNav.getState();
  return nav.windowId === windowId && !nav.gmWorkspaceOpen && !nav.studioOpen && !nav.characterSpaceId && !nav.spectateChannelId && attending();
}
// The page is in front of the user: visible, and in the desktop app also the focused window (an app in the
// background notifies instead).
function attending(): boolean {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false;
  return !isDesktop || document.hasFocus();
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
  if (!notes.enabled || !joined) return;
  const sender = m.kind === 'system' ? 'System' : m.character_name ?? m.author_name;
  // In the background, the desktop app notifies through the system instead of the in-app banner.
  if (isDesktop && !attending()) { import('../lib/desktop').then((d) => d.notifySystem(win.name, `${sender}: ${m.dice?.text ? `${m.content} ${m.dice.text}` : m.content}`)).catch(() => undefined); return; }
  if (document.visibilityState !== 'visible') return;
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
  // A window list fetched before the read was recorded may bring the count back: the window on screen clears it again.
  const shownUnread = useNav((s) => s.windows.find((w) => w.id === s.windowId)?.unread ?? 0);
  const lastSeq = useChat((s) => { const list = windowId ? s.byWindow[windowId] : undefined; return list?.length ? list[list.length - 1].seq : 0; });
  const [visible, setVisible] = useState(() => attending());
  useEffect(() => {
    const on = () => setVisible(attending());
    document.addEventListener('visibilitychange', on);
    window.addEventListener('focus', on); window.addEventListener('blur', on);
    return () => { document.removeEventListener('visibilitychange', on); window.removeEventListener('focus', on); window.removeEventListener('blur', on); };
  }, []);
  useEffect(() => {
    if (!channelId || !windowId || overlay || !visible) return;
    const win = useNav.getState().windows.find((w) => w.id === windowId);
    if (!win) return;
    if ((win.unread ?? 0) > 0) useNav.getState().setUnread(windowId, 0);
    const seq = Math.max(lastSeq, win.last_seq ?? 0);
    if (!seq || (marked.get(windowId) ?? 0) >= seq) return;
    marked.set(windowId, seq);
    api.markRead(channelId, windowId, seq).catch(() => marked.delete(windowId));
  }, [channelId, windowId, overlay, visible, lastSeq, shownUnread]);
}
