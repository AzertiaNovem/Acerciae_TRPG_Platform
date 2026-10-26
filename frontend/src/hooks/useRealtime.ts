import { useEffect } from 'react';
import { chatSocket, contextSocket } from '../api/ws';
import { useChat } from '../store/chat';
import { useDocuments } from '../store/documents';
import { useHighlights } from '../store/highlights';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';

// Wires WebSocket events to the stores. Chat and context streams are handled independently.
export function useRealtime() {
  const channelId = useNav((s) => s.channelId);
  const windowId = useNav((s) => s.windowId);
  const windows = useNav((s) => s.windows);
  useEffect(() => {
    const offChat = chatSocket.on((m) => {
      const ch = useNav.getState().channelId;
      if (m.channel_id && m.channel_id !== ch) return;
      if (m.type === 'message.posted') useChat.getState().push(m.message);
      else if (m.type === 'window.changed') { useNav.getState().applyWindowChange(m.window); useNav.getState().refreshWindows(); }
      else if (m.type === 'scene.changed') { useNav.getState().applySceneChange(m.scene); useNav.getState().refreshScenes(); }
    });
    const offCtx = contextSocket.on((m) => {
      const ch = useNav.getState().channelId;
      if (!ch || (m.channel_id && m.channel_id !== ch)) return;
      const activeWindow = useNav.getState().windows.find((w) => w.id === useNav.getState().windowId);
      const sceneId = activeWindow?.active_scene_id ?? undefined;
      if (m.type === 'document.updated') { useDocuments.getState().onUpdated(m, ch, sceneId); useUi.getState().setAiActivity(`${m.doc_type.replace('_', ' ')} updated (v${m.version})`); setTimeout(() => useUi.getState().setAiActivity(null), 4000); }
      else if (m.type === 'highlight.created') useHighlights.getState().add(m.highlight);
      else if (m.type === 'highlight.expired') useHighlights.getState().remove(m.highlight_ids);
      else if (m.type === 'proposal.pending') useUi.getState().toast('The AI filed a change that needs GM review.', 'ai');
      else if (m.type === 'module.updated') useUi.getState().toast('Module workspace updated.', 'ai');
      else if (m.type === 'ai.job' && m.job?.status === 'failed') useUi.getState().toast(`AI observer error: ${m.job.error}`, 'error');
    });
    const prune = setInterval(() => useHighlights.getState().prune(), 15000);
    return () => { offChat(); offCtx(); clearInterval(prune); };
  }, []);
  useEffect(() => {
    if (!channelId) return;
    useDocuments.getState().loadList(channelId);
    useHighlights.getState().load(channelId);
  }, [channelId]);
  useEffect(() => {
    if (!channelId || !windowId) return;
    useChat.getState().load(channelId, windowId);
  }, [channelId, windowId]);
  useEffect(() => { void windows; }, [windows]);
}
