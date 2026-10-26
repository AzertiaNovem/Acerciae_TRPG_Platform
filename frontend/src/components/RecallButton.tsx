import { t as tr } from '../i18n';
import { api } from '../api/client';
import { useHighlights } from '../store/highlights';
import { useNav } from '../store/nav';
import { sessionEpoch, isStale } from '../store/session';
import { useUi } from '../store/ui';

// User-triggered only. "draft" looks up the things named in the message being written; "hint" looks up the
// current topic (and the panel then takes a question). Neither writes, judges or sends anything.
export default function RecallButton({ mode, draft = '', characterId }: { mode: 'hint' | 'draft'; draft?: string; characterId: string }) {
  const { channelId, windowId } = useNav();
  const { recallBusy, setRecallBusy, setRecall, toast } = useUi();
  const run = async () => {
    if (!channelId || !windowId || (mode === 'draft' && !draft.trim())) return;
    setRecallBusy(true); const epoch = sessionEpoch();
    try {
      const r = await api.recall(channelId, { chat_window_id: windowId, character_id: characterId || undefined, mode, query: mode === 'draft' ? draft : undefined });
      if (isStale(epoch)) return;
      setRecall(r);
      for (const h of r.highlights ?? []) useHighlights.getState().add(h);
    } catch (e: any) { toast(e.message, 'error'); } finally { setRecallBusy(false); }
  };
  const disabled = recallBusy || (mode === 'draft' && !draft.trim());
  if (mode === 'draft') return <button className="ai-btn" onClick={run} disabled={disabled} title={tr('Find what the chat log and the journal already say about the things in your draft')}>{recallBusy ? tr('Recalling…') : tr('⚖ Already said about this')}</button>;
  return <button className="ai-btn" onClick={run} disabled={disabled} title={tr('Find what the chat log and the journal already say about the current topic')}>{recallBusy ? tr('Recalling…') : tr('✦ Recall')}</button>;
}
