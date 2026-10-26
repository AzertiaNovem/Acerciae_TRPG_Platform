import { t as tr } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import { useChat } from '../store/chat';
import type { EventRow } from '../types';

// Shows the original events behind a document entry / evidence item, with a jump to the chat message
// when the viewer is a participant of that window.
export default function EvidenceModal() {
  const { evidenceEventIds, showEvidence } = useUi();
  const { channelId, windows, selectWindow } = useNav();
  const [events, setEvents] = useState<EventRow[]>([]);
  useEffect(() => {
    if (!evidenceEventIds || !channelId) { setEvents([]); return; }
    api.events(channelId, evidenceEventIds).then(setEvents).catch(() => setEvents([]));
  }, [evidenceEventIds, channelId]);
  if (!evidenceEventIds) return null;
  const jump = (e: EventRow) => {
    if (!e.message_id || !e.chat_window_id) return;
    if (!windows.some((w) => w.id === e.chat_window_id)) return;
    selectWindow(e.chat_window_id);
    setTimeout(() => useChat.getState().requestJump(e.message_id!), 300);
    showEvidence(null);
  };
  return (
    <div className="modal-backdrop" onClick={() => showEvidence(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{tr("Original events")}</h3>
        {events.length === 0 && <div className="muted small">{tr("No events visible to you for this entry.")}</div>}
        {events.map((e) => (
          <div key={e.id} className="evidence-item" onClick={() => jump(e)}>
            <div className="row"><span className="pill">{e.kind}</span>{e.character_name && <b className="small">{e.character_name}</b>}{e.scene_title && <span className="tiny muted">· {e.scene_title}</span>}<span className="grow" /><span className="tiny muted">#{e.seq}</span></div>
            <div className="small">{(e.payload?.content as string) ?? ''}</div>
            {e.message_id && windows.some((w) => w.id === e.chat_window_id) && <div className="tiny" style={{ color: 'var(--accent)' }}>{tr("jump to message ↗")}</div>}
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}><span className="grow" /><button onClick={() => showEvidence(null)}>{tr("Close")}</button></div>
      </div>
    </div>
  );
}
