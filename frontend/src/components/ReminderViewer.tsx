import { t as tr, currentLocale } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useChat } from '../store/chat';
import { useNav } from '../store/nav';
import { useReminders } from '../store/reminders';
import { sessionEpoch, isStale } from '../store/session';
import { useUi } from '../store/ui';
import type { Reminder, ReminderContextEvent } from '../types';

// The quoted passages inside a line, marked yellow-green. The text itself is never altered.
function Quoted({ text, quotes }: { text: string; quotes?: string[] }) {
  const qs = (quotes ?? []).filter(Boolean);
  if (!qs.length) return <>{text}</>;
  const re = new RegExp(`(${qs.map((q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return <>{text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i} className="hl-reminder">{part}</mark> : <span key={i}>{part}</span>))}</>;
}

// The chat log around a reminder's quoted lines. Access is re-checked by the server on every open.
export default function ReminderViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const { channelId, selectWindow } = useNav();
  const { toast } = useUi();
  const dismiss = useReminders((s) => s.dismiss);
  const [reminder, setReminder] = useState<Reminder | null>(null);
  const [events, setEvents] = useState<ReminderContextEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!channelId) return; const epoch = sessionEpoch(); setEvents([]); setError(null);
    api.reminderContext(channelId, id, 30).then((r) => { if (isStale(epoch)) return; setReminder(r.reminder); setEvents(r.events); }).catch((e) => { if (!isStale(epoch)) setError(e.message); });
  }, [channelId, id]);
  useEffect(() => { const el = document.querySelector('.reminder-viewer .cited'); el?.scrollIntoView({ block: 'center' }); }, [events.length]);
  const openMessage = async (e: ReminderContextEvent, quote = false) => {
    if (!e.message_id || !e.chat_window_id || !channelId) return;
    const epoch = sessionEpoch();
    try { const m = await api.message(channelId, e.message_id); if (isStale(epoch)) return; if (quote) useChat.getState().addReference(m); else { useChat.getState().push(m); selectWindow(e.chat_window_id); useChat.getState().requestJump(m.id); onClose(); } }
    catch { toast(tr('Reference unavailable for your current view.'), 'error'); }
  };
  const kindLabel = (k: Reminder['kind']) => k === 'needed' ? tr('still open') : k === 'plan' ? tr('plan') : k === 'note' ? tr('note') : tr('you may have forgotten');
  return (
    <div className="doc-viewer reminder-viewer">
      <header>
        <span className={`pill ${reminder?.kind === 'needed' ? 'ai' : ''}`}>{reminder ? kindLabel(reminder.kind) : '…'}</span>
        <h3>{reminder?.title ?? '…'}</h3>
        <button className="ghost small" onClick={() => channelId && reminder && dismiss(channelId, reminder.id).then(onClose)}>{tr('Dismiss')}</button>
        <button className="ghost small" onClick={onClose}>✕</button>
      </header>
      <div className="body">
        {reminder?.why && <div className="small muted" style={{ marginBottom: 8 }}>{reminder.why}{reminder.llm_mode === 'mock' ? ` (${tr('mock LLM')})` : ''}</div>}
        {(reminder?.script_refs ?? []).length > 0 && (
          <div className="script-refs">
            <span className="tiny muted">{tr('From the script')}</span>
            {reminder!.script_refs!.map((sr) => <div key={sr.knowledge_id} className="small"><span className="pill gm">{tr(sr.kind)}</span> <b>{sr.title}</b>{sr.page ? <span className="tiny muted"> · {tr('p.')}{sr.page}</span> : null}{sr.excerpt && <div className="cit">“{sr.excerpt.slice(0, 200)}”</div>}</div>)}
          </div>
        )}
        {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
        {!error && events.length === 0 && <div className="muted small">{tr('Loading…')}</div>}
        {events.map((e) => (
          <div key={e.event_id} className={`log-line ${e.cited ? 'cited' : ''}`}>
            <div className="row tiny muted" style={{ flexWrap: 'wrap' }}><b>{e.character_name ?? e.author_name ?? (e.actor_role === 'gm' ? tr('Keeper') : '')}</b><span>{new Date(e.created_at).toLocaleString(currentLocale())}</span>{e.window_name && <span>· {e.window_name}</span>}<span className="grow" />
              {e.message_id && <button className="ghost small" onClick={() => openMessage(e)}>{tr('jump to message ↗')}</button>}
              {e.message_id && <button className="ghost small" onClick={() => openMessage(e, true)}>{tr('Quote as reference')}</button>}</div>
            <div className="small" style={{ whiteSpace: 'pre-wrap' }}><Quoted text={e.content} quotes={e.quotes} /></div>
          </div>
        ))}
        <div className="tiny muted" style={{ marginTop: 8 }}>{tr('The highlighted passages are quoted verbatim from the chat; the note above is the AI reminder about them.')}</div>
      </div>
    </div>
  );
}
