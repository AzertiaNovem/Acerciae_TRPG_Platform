import { t as tr } from '../i18n';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import { useHighlights } from '../store/highlights';

// User-triggered only: never runs as part of background analysis.
export default function ConsistencyButton({ draft, characterId }: { draft: string; characterId: string }) {
  const { channelId, windowId } = useNav();
  const { consistencyBusy, setConsistencyBusy, setConsistency, setInspiration, toast } = useUi();
  const run = async () => {
    if (!channelId || !windowId || !draft.trim()) return;
    setConsistencyBusy(true); setInspiration(null);
    try {
      const r = await api.consistency(channelId, { chat_window_id: windowId, character_id: characterId || undefined, draft });
      setConsistency(r);
      for (const h of r.highlights ?? []) useHighlights.getState().add(h);
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setConsistencyBusy(false); }
  };
  return <button className="ai-btn" onClick={run} disabled={!draft.trim() || consistencyBusy} title={tr("Check the draft against what your character knows")}>{consistencyBusy ? tr("Checking…") : tr("⚖ Consistency check")}</button>;
}
