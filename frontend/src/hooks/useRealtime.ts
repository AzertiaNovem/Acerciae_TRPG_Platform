import { api } from '../api/client';
import { bumpEpoch } from '../store/session';
import { useEffect } from 'react';
import { chatSocket, contextSocket } from '../api/ws';
import { useChat, accessKey } from '../store/chat';
import { useDocuments } from '../store/documents';
import { useHighlights } from '../store/highlights';
import { useReminders } from '../store/reminders';
import { useKp } from '../store/kp';
import { useNav } from '../store/nav';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import { onIncomingMessage } from './useUnread';
import { speakMessage, forgetSpokenMessage } from '../lib/speech';
import { useNotifications } from '../store/notifications';

// Wires WebSocket events to the stores. Chat and context streams are handled independently.
export function useRealtime() {
  const channelId = useNav((s) => s.channelId);
  const windowId = useNav((s) => s.windowId);
  const windows = useNav((s) => s.windows);
  useEffect(() => {
    // Pushed lines show as they come (store/chat); the open window is still checked against the server now and then,
    // less often while the stream is subscribed. Once the channel is subscribed again the open window is checked at
    // once (the others when they are opened), after a reconnect together with the window list and the channel.
    let dropped = false;
    const offChat = chatSocket.on((m) => {
      if (m.type === '_close') { dropped = true; useChat.getState().streamDown(); return; }
      if (m.type === '_open') return;
      if (m.type === 'subscribed' && !m.spectate) {
        const nav = useNav.getState();
        if (!nav.channelId || m.channel_id !== nav.channelId) return;
        useChat.getState().streamUp(m.channel_id);
        if (dropped) { dropped = false; nav.refreshWindows().catch(() => undefined); nav.refreshChannel().catch(() => undefined); }
        if (nav.windowId) {
          const chat = useChat.getState(), access = accessKey(nav.channel);
          (chat.spans[nav.windowId] ? chat.catchUp(nav.channelId, nav.windowId, access) : chat.open(nav.channelId, nav.windowId, access)).catch(() => undefined);
        }
        return;
      }
      const ch = useNav.getState().channelId;
      if (m.channel_id && m.channel_id !== ch) return;
      if (m.type === 'message.posted') { useChat.getState().push(m.message); onIncomingMessage(m.message); const nav = useNav.getState(); speakMessage(m.message, useAuth.getState().user?.id, nav.channelId, nav.windowId); }
      // Its author took a line back: the tombstone replaces it, its banner and queued reading go, unread is recounted.
      else if (m.type === 'message.recalled') { useChat.getState().applyRecall(m.message); useNotifications.getState().dismiss(m.message.id); forgetSpokenMessage(m.message.id); useNav.getState().refreshWindows().catch(() => undefined); }
      else if (m.type === 'initiative.changed') window.dispatchEvent(new CustomEvent('acerciae:initiative', { detail: m.chat_window_id }));
      else if (m.type === 'window.changed') { useNav.getState().applyWindowChange(m.window); useNav.getState().refreshWindows(); }
      else if (m.type === 'scene.changed') { useNav.getState().applySceneChange(m.scene); useNav.getState().refreshScenes(); }
      else if (m.type === 'character.updated') useNav.getState().refreshCharacters();
      else if (m.type === 'channel.updated') useNav.getState().refreshChannel();
      else if (m.type === 'channel.deleted') { const nav = useNav.getState(); if (nav.channelId === m.channel_id) useUi.getState().toast('The channel you were in was deleted.'); nav.forgetChannel(m.channel_id).catch(() => undefined); }
      else if (m.type === 'server.deleted') { const nav = useNav.getState(); if (nav.serverId === m.server_id) useUi.getState().toast('The server you were on was deleted.'); nav.forgetServer(m.server_id).catch(() => undefined); }
      else if (m.type === 'server.settings') { useNav.getState().applyServerSettings(m.settings); useNav.getState().loadSpectatable().catch(() => undefined); }
    });
    const offCtx = contextSocket.on((m) => {
      const ch = useNav.getState().channelId;
      if (!ch || (m.channel_id && m.channel_id !== ch)) return;
      const activeWindow = useNav.getState().windows.find((w) => w.id === useNav.getState().windowId);
      const sceneId = activeWindow?.active_scene_id ?? undefined;
      if (m.type === 'document.updated') { useDocuments.getState().onUpdated(m, ch, sceneId); useUi.getState().setAiActivity(`${m.doc_type.replace('_', ' ')} updated (v${m.version})`); setTimeout(() => useUi.getState().setAiActivity(null), 4000); }
      else if (m.type === 'knowledge.reset') {
        bumpEpoch(); useDocuments.getState().reset(); useHighlights.getState().reset(); useChat.getState().reset(); useChat.getState().forgetChannel(ch); useUi.getState().reset(); useReminders.getState().reset(); useReminders.getState().load(ch).catch(() => undefined);
        useDocuments.getState().loadList(ch).catch(()=>undefined); useHighlights.getState().load(ch).catch(()=>undefined); useNav.getState().refreshWindows(); useNav.getState().refreshScenes();
        const win=useNav.getState().windowId; if(win) useChat.getState().open(ch,win,accessKey(useNav.getState().channel)).catch(()=>undefined);
      }
      else if (m.type === 'reminder.created' || m.type === 'reminders.changed' || m.type === '_open') useReminders.getState().load(ch).catch(() => undefined);
      else if (m.type === 'kp.board') useKp.getState().set(m.board);
      else if (m.type === 'script.changed') { if (m.payload?.rebuilt) useUi.getState().toast('Script knowledge rebuilt from the module.', 'ai'); else if (m.payload?.applied) useUi.getState().toast(`Script knowledge: ${m.payload.applied} reviewed change(s) applied.`, 'ai'); }
      else if (m.type === 'highlight.created') useHighlights.getState().add(m.highlight);
      else if (m.type === 'highlight.expired') useHighlights.getState().remove(m.highlight_ids);
      else if (m.type === 'proposal.pending') useUi.getState().toast('The AI filed a change that needs GM review.', 'ai');
      else if (m.type === 'module.updated') {
        if (m.import_stage) {
          if (m.status === 'ready') useUi.getState().toast(m.import_warning ? 'Module imported with a warning' : 'Module import complete', 'ai');
          else if (m.status === 'failed') useUi.getState().toast('Module import failed; retry the saved task', 'error');
        } else useUi.getState().toast('Module workspace updated.', 'ai');
      }
      else if (m.type === 'ai.job' && m.job?.status === 'failed') useUi.getState().toast(`AI observer error: ${m.job.error}`, 'error');
    });
    const prune = setInterval(() => { useHighlights.getState().prune(); useReminders.getState().prune(); }, 15000);
    return () => { offChat(); offCtx(); clearInterval(prune); };
  }, []);
  useEffect(() => {
    if (!channelId) return;
    useDocuments.getState().loadList(channelId);
    useHighlights.getState().load(channelId);
    useReminders.getState().load(channelId).catch(() => undefined);
    if (useNav.getState().channel?.my_role === 'gm') useKp.getState().load(channelId);
    // Reconcile revocations even after a missed/disconnected socket notification.
    let active=true; let groupVersion='';
    const poll=async()=>{
      try {
        if(useNav.getState().channel?.my_role==='gm') return;
        const groups=await api.playerGroups(channelId);
        if(!active) return;
        const next=groups.map(g=>`${g.id}:${g.version}`).join(',');
        if(groupVersion && groupVersion!==next) {
          bumpEpoch(); useReminders.getState().reset(); useReminders.getState().load(channelId).catch(() => undefined); useDocuments.getState().reset(); useHighlights.getState().reset(); useChat.getState().reset(); useChat.getState().forgetChannel(channelId); useUi.getState().reset();
          useNav.getState().refreshWindows(); useNav.getState().refreshScenes(); await useNav.getState().refreshChannel();
          const win=useNav.getState().windowId; if(win) useChat.getState().open(channelId,win,accessKey(useNav.getState().channel)).catch(()=>undefined);
        }
        groupVersion=next; await useDocuments.getState().loadList(channelId);
      } catch { /* socket reconnect or next poll will retry */ }
    };
    const remindersTimer = setInterval(() => useReminders.getState().load(channelId).catch(() => undefined), 30000);
    poll(); const timer=setInterval(poll,10000);
    return ()=>{active=false;clearInterval(timer);clearInterval(remindersTimer);};
  }, [channelId]);
  // Opening a window shows what is kept at once, and checks it against the server when that is due.
  const access = useNav((s) => accessKey(s.channel));
  useEffect(() => {
    if (!channelId || !windowId || !access) return;
    useChat.getState().open(channelId, windowId, access).catch(() => undefined);
  }, [channelId, windowId, access]);
  // The open window is checked against the server when that is due: every 30 s while the chat stream is subscribed
  // (a push can still be lost), every 5 s while it is not. Not while the page is hidden.
  useEffect(() => {
    if (!channelId || !windowId || !access) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      useChat.getState().refresh(channelId, windowId, access).catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [channelId, windowId, access]);
  // A window that is no longer listed (deleted, or no longer the viewer's) keeps nothing here.
  useEffect(() => {
    if (!channelId || !windows.length || windows.some((w) => w.channel_id !== channelId)) return;
    const listed = new Set(windows.map((w) => w.id));
    for (const [w, span] of Object.entries(useChat.getState().spans)) if (span.channelId === channelId && !listed.has(w)) useChat.getState().forgetWindow(w);
  }, [channelId, windows]);
}
