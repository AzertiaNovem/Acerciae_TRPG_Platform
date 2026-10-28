import { t as tr, currentLocale } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import type { Revision } from '../types';

export default function DocumentRevisionViewer({ documentId, isGm, onRolledBack }: { documentId: string; isGm: boolean; onRolledBack: () => void }) {
  const channelId = useNav((s) => s.channelId);
  const toast = useUi((s) => s.toast);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<any | null>(null);
  const load = () => { if (channelId) api.revisions(channelId, documentId).then(setRevisions).catch(() => undefined); };
  useEffect(load, [channelId, documentId]);
  const view = async (v: number) => { if (!channelId) return; if (open === v) { setOpen(null); return; } setOpen(v); setSnapshot(await api.revision(channelId, documentId, v)); };
  const rollback = async (v: number) => {
    if (!channelId || !confirm(tr('Roll back to version {v}? A new revision will be recorded; nothing is deleted.', { v }))) return;
    try { await api.rollback(channelId, documentId, v); toast(`Rolled back to v${v}`); load(); onRolledBack(); } catch (e: any) { toast(e.message, 'error'); }
  };
  return (
    <div>
      {revisions.length === 0 && <div className="muted small">{tr("No revisions yet.")}</div>}
      {revisions.map((r) => (
        <div key={r.id} className="entry" style={{ cursor: 'pointer' }} onClick={() => view(r.version)}>
          <div className="row"><b>{tr("v")}{r.version}</b><span className={`pill ${r.actor === 'gm' ? 'gm' : 'ai'}`}>{r.actor}</span><span className="small">{r.summary}</span><span className="grow" /><span className="tiny muted">{new Date(r.created_at).toLocaleString(currentLocale())}</span></div>
          <div className="tiny muted">{r.op_count}{tr(" op(s) · ")}{r.source_event_ids?.length ?? 0}{tr(" source event(s)")}</div>
          {open === r.version && snapshot && (
            <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--bg-4)' }} onClick={(e) => e.stopPropagation()}>
              {(snapshot.snapshot ?? []).filter((s: any) => !s.removed).map((s: any) => <div key={s.entry_id} className="tiny" style={{ marginBottom: 3 }}><span className={`status-${s.status}`}>{s.status}</span> · {s.summary}</div>)}
              {isGm && <button className="small" style={{ marginTop: 6 }} onClick={() => rollback(r.version)}>{tr("Roll back to this version")}</button>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
