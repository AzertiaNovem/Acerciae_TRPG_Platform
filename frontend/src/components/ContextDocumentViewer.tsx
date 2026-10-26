import { t as tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useDocuments } from '../store/documents';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import { useHighlights } from '../store/highlights';
import HighlightedText from './HighlightedText';
import DocumentRevisionViewer from './DocumentRevisionViewer';
import type { DocEntry } from '../types';

export function EntryCard({ e, focused, isGm, onChanged }: { e: DocEntry; focused: boolean; isGm: boolean; onChanged: () => void }) {
  const { channelId } = useNav();
  const { showEvidence, toast } = useUi();
  const [related, setRelated] = useState<DocEntry[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(e.summary);
  const [status, setStatus] = useState(e.status);
  const [reason, setReason] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [focused]);
  const loadRelated = async () => { if (!channelId) return; setRelated(related ? null : await api.related(channelId, e.id)); };
  const save = async () => {
    if (!channelId) return;
    try { await api.correctEntry(channelId, e.document_id, e.id, { summary, status, reason: reason || 'GM correction' }); setEditing(false); onChanged(); toast('Entry corrected; revision recorded.'); }
    catch (err: any) { toast(err.message, 'error'); }
  };
  return (
    <div ref={ref} className={`entry ${e.changed_since ? 'changed' : ''} ${focused ? 'focused' : ''}`}>
      {!editing ? <HighlightedText entryId={e.id} content={e.content_md} /> : (
        <div className="col">
          <textarea value={summary} onChange={(ev) => setSummary(ev.target.value)} />
          <select value={status} onChange={(ev) => setStatus(ev.target.value)}>{['attempted', 'confirmed', 'npc_claim', 'hypothesis', 'ai_inferred', 'gm_secret', 'resolved', 'retracted'].map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <input placeholder={tr("Reason for correction (recorded in history)")} value={reason} onChange={(ev) => setReason(ev.target.value)} />
          <div className="row"><button className="primary small" onClick={save}>{tr("Save correction")}</button><button className="ghost small" onClick={() => setEditing(false)}>{tr("Cancel")}</button></div>
        </div>
      )}
      <div className="entry-meta">
        <span className={`tiny status-${e.status}`}>{tr(e.status)}</span>
        {e.scene_title && <span className="tiny muted">· {e.scene_title}</span>}
        <span className="tiny muted">{tr("· v")}{e.updated_version}</span>
        {e.created_by === 'gm' && <span className="pill gm">{tr("GM")}</span>}
        {(e.entities ?? []).slice(0, 4).map((en) => <span key={en.id + en.role} className="pill" title={en.kind}>{en.name}</span>)}
      </div>
      <div className="actions">
        {e.source_event_ids?.length > 0 && <button className="ghost small" onClick={() => showEvidence(e.source_event_ids)}>{tr("↗ source")}</button>}
        <button className="ghost small" onClick={loadRelated}>{related ? tr("hide related") : tr("related")}</button>
        {isGm && !editing && <button className="ghost small" onClick={() => setEditing(true)}>{tr("✎ correct")}</button>}
      </div>
      {related && (
        <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--bg-4)' }}>
          {related.length === 0 && <div className="tiny muted">{tr("No related entries visible to you.")}</div>}
          {related.map((r) => <div key={r.id} className="tiny" style={{ marginBottom: 3 }}><span className="pill">{r.kind}</span> {r.summary}</div>)}
        </div>
      )}
    </div>
  );
}

export default function ContextDocumentViewer({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { channelId, channel, windows, windowId } = useNav();
  const { full, loadDocument, focusEntryId, focusEntry, markSeen } = useDocuments();
  const hlCount = useHighlights((s) => Object.values(s.byId).filter((h) => h.document_id === documentId).length);
  const [showRevisions, setShowRevisions] = useState(false);
  const doc = full[documentId];
  const sceneId = windows.find((w) => w.id === windowId)?.active_scene_id ?? undefined;
  useEffect(() => { if (channelId) loadDocument(channelId, documentId, sceneId); }, [channelId, documentId, sceneId, loadDocument]);
  useEffect(() => () => { markSeen(documentId); focusEntry(null); }, [documentId, markSeen, focusEntry]);
  const isGm = channel?.my_role === 'gm';
  return (
    <div className="doc-viewer">
      <header>
        <h3>{doc ? tr(doc.title) : '…'} <span className="tiny muted">{tr("v")}{doc?.version ?? ''}</span>{hlCount > 0 && <span className="badge hl" style={{ marginLeft: 6 }}>✦{hlCount}</span>}</h3>
        {doc?.scene && <span className="scene-chip">{doc.scene.title}</span>}
        <button className="ghost small" onClick={() => setShowRevisions(!showRevisions)} title={tr("Revision history")}>{showRevisions ? tr("entries") : tr("history")}</button>
        <button className="ghost small" onClick={onClose}>✕</button>
      </header>
      <div className="body">
        {!doc && <div className="muted small">{tr("Loading…")}</div>}
        {doc && showRevisions && <DocumentRevisionViewer documentId={documentId} isGm={!!isGm} onRolledBack={() => channelId && loadDocument(channelId, documentId, sceneId)} />}
        {doc && !showRevisions && doc.entries.length === 0 && <div className="muted small">{tr("Nothing recorded yet")}{doc.doc_type === 'current_scene' ? tr(" for this scene") : ''}.</div>}
        {doc && !showRevisions && doc.entries.map((e) => <EntryCard key={e.id} e={e} focused={focusEntryId === e.id} isGm={!!isGm} onChanged={() => channelId && loadDocument(channelId, documentId, sceneId)} />)}
      </div>
    </div>
  );
}
