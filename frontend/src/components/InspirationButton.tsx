import { t as tr } from '../i18n';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';

export default function InspirationButton({ characterId }: { characterId: string }) {
  const { channelId, windowId } = useNav();
  const { inspirationBusy, setInspirationBusy, setInspiration, setConsistency, toast } = useUi();
  const run = async () => {
    if (!channelId || !windowId) return;
    setInspirationBusy(true); setConsistency(null);
    try { setInspiration(await api.inspiration(channelId, { chat_window_id: windowId, character_id: characterId || undefined, variant: Math.floor(Math.random() * 5) })); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setInspirationBusy(false); }
  };
  return <button className="ai-btn" onClick={run} disabled={inspirationBusy} title={tr("Draft a possible response from what your character knows")}>{inspirationBusy ? tr("Drafting…") : tr("✦ Inspiration")}</button>;
}
