import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';

// Editable draft. Never sent automatically: insert, regenerate or discard.
export default function InspirationDraftPanel() {
  const { inspiration, setInspiration, insertIntoComposer, setInspirationBusy, inspirationBusy, toast } = useUi();
  const { channelId, windowId } = useNav();
  const [text, setText] = useState(inspiration?.draft ?? '');
  const [variant, setVariant] = useState(1);
  useEffect(() => { setText(inspiration?.draft ?? ''); }, [inspiration?.id]);
  if (!inspiration) return null;
  const regen = async () => {
    if (!channelId || !windowId) return;
    setInspirationBusy(true);
    try { setInspiration(await api.inspiration(channelId, { chat_window_id: windowId, character_id: (inspiration as any).character_id || undefined, variant })); setVariant(variant + 1); }
    catch (e: any) { toast(e.message, 'error'); } finally { setInspirationBusy(false); }
  };
  return (
    <div className="panel-float">
      <div className="row"><b>✦ Inspiration draft</b><span className="pill ai">editable · not sent</span>{inspiration.llm_mode === 'mock' && <span className="pill">mock LLM</span>}<span className="grow" /><button className="ghost small" onClick={() => setInspiration(null)}>✕</button></div>
      <textarea style={{ width: '100%', minHeight: 90, marginTop: 8 }} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="tiny muted" style={{ marginTop: 4 }}>{inspiration.notes ?? 'Uses only what your character knows; it proposes, it does not decide outcomes.'} {inspiration.used_fact_ids.length > 0 && `· grounded in ${inspiration.used_fact_ids.length} known record(s)`}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={() => { insertIntoComposer(text); setInspiration(null); }}>Insert into input</button>
        <button onClick={regen} disabled={inspirationBusy}>{inspirationBusy ? 'Drafting…' : 'Regenerate'}</button>
        <button className="ghost" onClick={() => setInspiration(null)}>Discard</button>
      </div>
    </div>
  );
}
