import { api } from '../api/client';
import { bumpEpoch } from '../store/session';
import { useEffect } from 'react';
import { chatSocket, contextSocket } from '../api/ws';
import { useChat } from '../store/chat';
import { useDocuments } from '../store/documents';
import { useHighlights } from '../store/highlights';
import { useReminders } from '../store/reminders';
import { useKp } from '../store/kp';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';

// Wires WebSocket events to the stores. Chat and context streams are handled independently.
export function useRealtime() {
  const channelId = useNav((s) => s.channelId);
  const windowId = useNav((s) => s.windowId);
  const windows = useNav((s) => s.windows);
  useEffect(() => {
    // After a reconnect, reload what may have been posted while the socket was down.
    let dropped = false;
    const offChat = chatSocket.on((m) => {
      if (m.type === '_close') { dropped = true; return; }
      if (m.type === '_open') {
        if (!dropped) return;
        dropped = false;
        const { channelId: cur, windowId: win } = useNav.getState();
        if (cur) { useNav.getState().refreshWindows(); useNav.getState().refreshChannel(); if (win) useChat.getState().load(cur, win).catch(() => undefined); }
        return;
      }
      const ch = useNav.getState().channelId;
      if (m.channel_id && m.channel_id !== ch) return;
      if (m.type === 'message.posted') useChat.getState().push(m.message);
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
        bumpEpoch(); useDocuments.getState().reset(); useHighlights.getState().reset(); useChat.getState().reset(); useUi.getState().reset(); useReminders.getState().reset(); useReminders.getState().load(ch).catch(() => undefined);
        useDocuments.getState().loadList(ch).catch(()=>undefined); useHighlights.getState().load(ch).catch(()=>undefined); useNav.getState().refreshWindows(); useNav.getState().refreshScenes();
        const win=useNav.getState().windowId; if(win) useChat.getState().load(ch,win).catch(()=>undefined);
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
          bumpEpoch(); useReminders.getState().reset(); useReminders.getState().load(channelId).catch(() => undefined); useDocuments.getState().reset(); useHighlights.getState().reset(); useChat.getState().reset(); useUi.getState().reset();
          useNav.getState().refreshWindows(); useNav.getState().refreshScenes();
          const win=useNav.getState().windowId; if(win) useChat.getState().load(channelId,win).catch(()=>undefined);
        }
        groupVersion=next; await useDocuments.getState().loadList(channelId);
      } catch { /* socket reconnect or next poll will retry */ }
    };
    const remindersTimer = setInterval(() => useReminders.getState().load(channelId).catch(() => undefined), 30000);
    poll(); const timer=setInterval(poll,10000);
    return ()=>{active=false;clearInterval(timer);clearInterval(remindersTimer);};
  }, [channelId]);
  useEffect(() => {
    if (!channelId || !windowId) return;
    useChat.getState().load(channelId, windowId);
  }, [channelId, windowId]);
  useEffect(() => { void windows; }, [windows]);
}
