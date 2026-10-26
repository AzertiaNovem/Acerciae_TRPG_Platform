import { t as tr } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import { useChat } from '../store/chat';
import { sessionEpoch, isStale } from '../store/session';
import type { EventRow } from '../types';

// Shows the original events behind a document entry / evidence item, with a jump to the chat message
// when the viewer is a participant of that window.
export default function EvidenceModal() {
  const { evidenceEventIds, showEvidence } = useUi();
  const { channelId, windows, selectWindow } = useNav();
  const [events, setEvents] = useState<EventRow[]>([]);
  useEffect(() => {
    if (!evidenceEventIds || !channelId) { setEvents([]); return; }
    let live=true; setEvents([]);
    api.events(channelId, evidenceEventIds).then(rows=>{if(live)setEvents(rows);}).catch(() => {if(live)setEvents([]);});
    return ()=>{live=false;};
  }, [evidenceEventIds, channelId]);
  if (!evidenceEventIds) return null;
  const openMessage = async (e: EventRow, quote=false) => {
    if (!e.message_id || !e.chat_window_id || !channelId) return;
    const epoch=sessionEpoch();
    try {
      const message=await api.message(channelId,e.message_id);
      if(isStale(epoch))return;
      if(quote) useChat.getState().addReference(message);
      else {useChat.getState().push(message);selectWindow(e.chat_window_id);useChat.getState().requestJump(message.id);}
      showEvidence(null);
    } catch {useUi.getState().toast(tr('Reference unavailable for your current view.'),'error');}
  };
  return (
    <div className="modal-backdrop" onClick={() => showEvidence(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{tr("Original events")}</h3>
        {events.length === 0 && <div className="muted small">{tr("No events visible to you for this entry.")}</div>}
        {events.map((e) => (
          <div key={e.id} className="evidence-item" onClick={() => openMessage(e)}>
            <div className="row"><span className="pill">{e.kind}</span>{e.character_name && <b className="small">{e.character_name}</b>}{e.scene_title && <span className="tiny muted">· {e.scene_title}</span>}<span className="grow" /><span className="tiny muted">#{e.seq}</span></div>
            <div className="small">{(e.payload?.content as string) ?? ''}</div>
            {e.message_id && <button className="ghost small" onClick={ev=>{ev.stopPropagation();openMessage(e,true);}}>{tr('Quote as reference')}</button>}
            {e.message_id && windows.some((w) => w.id === e.chat_window_id) && <div className="tiny" style={{ color: 'var(--accent)' }}>{tr("jump to message ↗")}</div>}
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}><span className="grow" /><button onClick={() => showEvidence(null)}>{tr("Close")}</button></div>
      </div>
    </div>
  );
}
