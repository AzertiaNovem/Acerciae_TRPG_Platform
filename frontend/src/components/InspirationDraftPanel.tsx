import { t as tr } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import type { InspirationOption } from '../types';

// Three ways the character might play the moment, in their own voice: pick one, edit it, insert it. Never sent
// automatically. "Another take" asks for three different ones.
export default function InspirationDraftPanel() {
  const { inspiration, setInspiration, insertIntoComposer, setInspirationBusy, inspirationBusy, toast } = useUi();
  const { channelId, windowId } = useNav();
  const options: InspirationOption[] = inspiration ? (inspiration.options?.length ? inspiration.options : [{ text: inspiration.draft, kind: 'ic', roll: '', angle: '' }]) : [];
  const [picked, setPicked] = useState(0);
  const [text, setText] = useState(options[0]?.text ?? '');
  const [shown, setShown] = useState<string[]>([]);   // every option shown so far, so another take brings new ones
  useEffect(() => { setPicked(0); setText(options[0]?.text ?? ''); setShown((s) => [...s, ...options.map((o) => o.text)].slice(-12)); }, [inspiration?.id]);
  if (!inspiration) return null;
  const again = async () => {
    if (!channelId || !windowId) return;
    setInspirationBusy(true);
    try { setInspiration(await api.inspiration(channelId, { chat_window_id: windowId, character_id: inspiration.character_id || undefined, avoid: shown, variant: shown.length })); }
    catch (e: any) { toast(e.message, 'error'); } finally { setInspirationBusy(false); }
  };
  const roll = options[picked]?.roll;
  return (
    <div className="panel-float inspiration" data-testid="inspiration-panel">
      <div className="row"><b>{tr("✦ Inspiration")}</b><span className="pill ai">{tr("Editable · not sent")}</span>{inspiration.llm_mode === 'mock' && <span className="pill">{tr("mock LLM")}</span>}<span className="grow" /><button className="ghost small" onClick={() => setInspiration(null)} aria-label={tr("Discard")}>✕</button></div>
      <div className="tiny muted" style={{ marginTop: 4 }}>{tr("Three ways to play the moment, in your character's voice. Pick one, edit it if you like, then insert it; nothing is sent for you.")}</div>
      <div className="inspiration-options">
        {options.map((o, i) => (
          <button key={i} type="button" className={`option ${i === picked ? 'on' : ''}`} onClick={() => { setPicked(i); setText(o.text); }}>
            <span className="row tiny"><b>{o.angle || tr('Option {n}', { n: i + 1 })}</b>{o.kind === 'ooc' && <span className="pill">OOC</span>}{o.roll && <span className="pill">{o.roll}</span>}</span>
            <span className="small">{o.text}</span>
          </button>
        ))}
      </div>
      <textarea style={{ width: '100%', minHeight: 70, marginTop: 8 }} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="tiny muted" style={{ marginTop: 4 }}>
        {inspiration.notes ?? tr("Uses only what your character knows; it proposes, it does not decide outcomes.")}
        {inspiration.used_fact_ids.length > 0 && ` · ${tr('grounded in {n} known facts', { n: inspiration.used_fact_ids.length })}`}
      </div>
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <button className="primary" onClick={() => { insertIntoComposer(text); setInspiration(null); }}>{tr("Insert into input")}</button>
        {roll && <button onClick={() => { insertIntoComposer(roll); setInspiration(null); }} title={tr("Send the line first, then the roll.")}>{tr("Insert the roll")} {roll}</button>}
        <button onClick={again} disabled={inspirationBusy}>{inspirationBusy ? tr("Drafting…") : tr("Another take")}</button>
        <button className="ghost" onClick={() => setInspiration(null)}>{tr("Discard")}</button>
      </div>
    </div>
  );
}
