import { t as tr, currentLocale } from '../i18n';
import { useState } from 'react';
import { api } from '../api/client';
import { useChat } from '../store/chat';
import { useDocuments } from '../store/documents';
import { useNav } from '../store/nav';
import { sessionEpoch, isStale } from '../store/session';
import { useUi } from '../store/ui';
import type { RecallMessage, RecallRecord } from '../types';

// Highlights the search terms inside a verbatim quote. The text itself is never altered.
function Marked({ text, terms }: { text: string; terms: string[] }) {
  const safe = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!safe.length) return <>{text}</>;
  const re = new RegExp(`(${safe.join('|')})`, 'gi');
  return <>{text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}</>;
}

// What the chat log and the journal already say. The AI only chose which existing lines and records to show;
// every quote is fetched again from the server before it is used, so stale access never grants anything.
export default function RecallPanel() {
  const { recall: r, setRecall, recallBusy, setRecallBusy, toast, showEvidence } = useUi();
  const { channelId, windowId } = useNav();
  const expand = useDocuments((s) => s.expand);
  const focusEntry = useDocuments((s) => s.focusEntry);
  const [question, setQuestion] = useState('');
  if (!r) return null;
  const ask = async () => {
    if (!channelId || !windowId) return;
    setRecallBusy(true); const epoch = sessionEpoch();
    try { const next = await api.recall(channelId, { chat_window_id: windowId, character_id: r.character_id || undefined, mode: 'hint', query: question.trim() || undefined }); if (isStale(epoch)) return; setRecall(next); }
    catch (e: any) { toast(e.message, 'error'); } finally { setRecallBusy(false); }
  };
  const fetchMessage = async (id: string) => { try { return await api.message(channelId!, id); } catch { toast(tr('This message is no longer readable from your current view.'), 'error'); return null; } };
  const quote = async (m: RecallMessage) => { const full = await fetchMessage(m.id); if (!full) return; useChat.getState().addReference(full); toast(tr('Added as a chat reference to your next message.')); };
  const jump = async (m: RecallMessage) => { const full = await fetchMessage(m.id); if (!full) return; useChat.getState().push(full); useNav.getState().selectWindow(full.chat_window_id); useChat.getState().requestJump(full.id); };
  const open = (rec: RecallRecord) => { if (rec.document_id) { expand(rec.document_id); focusEntry(rec.entry_id); } };
  const total = r.topics.reduce((n, t) => n + t.items.length, 0);
  const sourceLabel = r.query_source === 'draft' ? tr('about your draft') : r.query_source === 'recent_chat' ? tr('about what this window is discussing') : tr('about your question');
  return (
    <div className="panel-float recall">
      <div className="row"><b>{tr('✦ Already said')}</b><span className="pill ai">{sourceLabel}</span>{r.llm_mode === 'mock' && <span className="pill">{tr('mock LLM')}</span>}<span className="grow" /><button className="ghost small" onClick={() => setRecall(null)}>✕</button></div>
      {r.query_source !== 'recent_chat' && <div className="tiny muted" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>“{r.query.length > 200 ? r.query.slice(0, 200) + '…' : r.query}”</div>}
      {total === 0 && <p className="small" style={{ margin: '8px 0' }}>{tr('Nothing in the chat log or the journal mentions this yet.')}</p>}
      {r.topics.map((topic, ti) => (
        <div key={ti} className="recall-topic">
          <div className="small recall-label">{topic.label ? <Marked text={topic.label} terms={r.terms} /> : tr('Related')}</div>
          {topic.items.map((it) => it.type === 'message' ? (
            <div key={it.id} className="recall-item quote">
              <div className="row tiny muted" style={{ flexWrap: 'wrap' }}>
                <span>{it.character_name ?? it.author_name}</span><span>·</span><span>{it.window_name}</span><span>·</span><span>{new Date(it.created_at).toLocaleString(currentLocale())}</span>{it.kind === 'ooc' && <span className="pill">OOC</span>}
                <span className="grow" />
                <button className="ghost small" onClick={() => jump(it)}>{tr('Go to original message')}</button>
                <button className="ghost small" onClick={() => quote(it)}>{tr('Quote in reply')}</button>
              </div>
              <blockquote><Marked text={it.content} terms={r.terms} /></blockquote>
              {it.dice?.text && <div className="tiny">{it.dice.text}</div>}
            </div>
          ) : (
            <div key={it.fact_id} className="recall-item record" onClick={() => open(it)} title={it.entry_id ? tr('Open the journal entry') : undefined}>
              <div className="row tiny"><span className="pill">{it.document_type?.replace('_', ' ') ?? it.kind}</span><span className={`status-${it.status}`}>{it.status}</span>{it.scene_title && <span className="muted">· {it.scene_title}</span>}<span className="grow" />{it.source_event_ids?.length > 0 && <button className="ghost small" onClick={(ev) => { ev.stopPropagation(); showEvidence(it.source_event_ids); }}>{tr('original events')}</button>}</div>
              <div className="small"><Marked text={it.summary} terms={r.terms} /></div>
            </div>
          ))}
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={tr('Ask about a name, a place or a thing…')} onKeyDown={(e) => { if (e.key === 'Enter') ask(); }} style={{ flex: 1 }} />
        <button className="small" onClick={ask} disabled={recallBusy}>{recallBusy ? tr('Recalling…') : tr('Recall')}</button>
      </div>
      <div className="tiny muted" style={{ marginTop: 6 }}>{r.notes.join(' ')} {r.mode === 'draft' && tr('Your draft was not changed and can still be sent as-is.')}</div>
    </div>
  );
}
