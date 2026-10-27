import { t as tr, currentLocale } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import { useKp } from '../store/kp';
import type { ScriptChange, ScriptKind, ScriptKnowledge, ScriptStatus } from '../types';

const KINDS: ScriptKind[] = ['flow', 'relationship', 'clue', 'foreshadowing', 'background'];
const STATUSES: ScriptStatus[] = ['pending', 'active', 'done', 'skipped'];

// The Keeper's script knowledge: what the module says, organised as the flow of the script, relationships, clues,
// foreshadowing and background. Automatic changes come from play and pass a reviewer; the Keeper's edits are final.
export default function ScriptKnowledgePanel() {
  const channelId = useNav((s) => s.channelId);
  const toast = useUi((s) => s.toast);
  const showEvidence = useUi((s) => s.showEvidence);
  const loadBoard = useKp((s) => s.load);
  const [entries, setEntries] = useState<ScriptKnowledge[]>([]);
  const [changes, setChanges] = useState<ScriptChange[]>([]);
  const [kind, setKind] = useState<ScriptKind>('flow');
  const [editing, setEditing] = useState<ScriptKnowledge | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { if (!channelId) return; const [e, c] = await Promise.all([api.scriptKnowledge(channelId), api.scriptChanges(channelId, 40)]); setEntries(e); setChanges(c); };
  useEffect(() => { load().catch(() => undefined); }, [channelId]);
  const rebuild = async () => { if (!channelId) return; setBusy(true); try { const r = await api.rebuildScriptKnowledge(channelId); toast(`Script knowledge rebuilt: ${r.entries} entries`); await load(); await loadBoard(channelId); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); } };
  const save = async () => { if (!channelId || !editing) return; try { await api.updateScriptKnowledge(channelId, editing.id, { title: editing.title, body: editing.body, status: editing.status }); setEditing(null); await load(); await loadBoard(channelId); } catch (e: any) { toast(e.message, 'error'); } };
  const setStatus = async (e: ScriptKnowledge, status: ScriptStatus) => { if (!channelId) return; try { await api.updateScriptKnowledge(channelId, e.id, { status }); await load(); await loadBoard(channelId); } catch (err: any) { toast(err.message, 'error'); } };
  const shown = entries.filter((e) => e.kind === kind);
  const counts = (k: ScriptKind) => entries.filter((e) => e.kind === k).length;
  const describe = (e: ScriptKnowledge) => {
    const d = e.data ?? {};
    if (e.kind === 'relationship') return `${d.from ?? ''} — ${String(d.relation ?? '').replace(/_/g, ' ')} — ${d.to ?? ''}`;
    if (e.kind === 'flow') return [d.location ? `${tr('at')} ${d.location}` : '', (d.prerequisites ?? []).length ? `${tr('needs')}: ${(d.prerequisites as string[]).join('; ')}` : '', (d.leads_to ?? []).length ? `→ ${(d.leads_to as string[]).join(', ')}` : ''].filter(Boolean).join(' · ');
    if (e.kind === 'clue') return [(d.found_at ?? []).length ? `${tr('found at')}: ${(d.found_at as string[]).join(', ')}` : '', (d.held_by ?? []).length ? `${tr('held by')}: ${(d.held_by as string[]).join(', ')}` : ''].filter(Boolean).join(' · ');
    if (e.kind === 'foreshadowing') return [(d.payoff_in ?? []).length ? `${tr('pays off in')}: ${(d.payoff_in as string[]).join(', ')}` : '', (d.unlocks ?? []).length ? `${tr('unlocks')}: ${(d.unlocks as string[]).join(', ')}` : ''].filter(Boolean).join(' · ');
    return '';
  };
  return (
    <div className="script-panel">
      <div className="card">
        <div className="row"><h3 style={{ margin: 0 }}>{tr('Script knowledge')}</h3><span className="pill gm">{tr('Keeper only')}</span><span className="grow" /><button className="small" onClick={rebuild} disabled={busy}>{busy ? tr('Rebuilding…') : tr('Rebuild from module')}</button></div>
        <div className="tiny muted" style={{ marginTop: 4 }}>{tr('Built from the imported module: the flow of the script, who relates to whom, the clues, what is foreshadowed and the background. The model reads this first whenever it works for you. During play it proposes changes (a stage reached, a clue revealed); a second model reviews every proposal before it is applied. Your edits are final and are never overwritten.')}</div>
        {entries.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>{tr('No script knowledge yet. Import a module in the Module tab; it is built automatically once the module is structured.')}</div>}
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>{KINDS.map((k) => <button key={k} className={`small ${kind === k ? 'primary' : ''}`} onClick={() => setKind(k)}>{tr(k)} ({counts(k)})</button>)}</div>
      </div>
      <div className="grid-2">
        <div className="card">
          {shown.map((e) => (
            <div key={e.id} className={`entry ${e.status}`}>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {e.kind === 'flow' && <span className="pill">{e.position + 1}</span>}
                <b className="small">{e.title}</b>
                <span className={`pill ${e.status === 'active' ? 'ai' : e.status === 'done' ? 'ok' : ''}`}>{tr(e.status)}</span>
                {e.gm_edited && <span className="pill gm">{tr('edited')}</span>}
                {e.origin === 'play' && <span className="pill">{tr('from play')}</span>}
                <span className="grow" />
                {e.kind === 'flow' && e.status === 'pending' && <button className="ghost small" onClick={() => setStatus(e, 'active')}>{tr('mark active')}</button>}
                {(e.status === 'pending' || e.status === 'active') && <button className="ghost small" onClick={() => setStatus(e, 'done')}>{e.kind === 'clue' ? tr('mark revealed') : tr('mark done')}</button>}
                <button className="ghost small" onClick={() => setEditing({ ...e })}>{tr('edit')}</button>
              </div>
              {describe(e) && <div className="tiny muted">{describe(e)}</div>}
              <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{e.body.slice(0, 400)}{e.body.length > 400 ? '…' : ''}</div>
              {e.citations.slice(0, 2).map((c, i) => <div key={i} className="cit">{tr('p.')}{c.page}: “{c.excerpt.slice(0, 140)}”</div>)}
              {e.status_event_ids.length > 0 && <button className="ghost small" onClick={() => showEvidence(e.status_event_ids)}>{tr('chat lines that moved it')}</button>}
            </div>
          ))}
          {shown.length === 0 && entries.length > 0 && <div className="muted small">{tr('Nothing of this kind in the script.')}</div>}
        </div>
        <div>
          {editing && (
            <div className="card col">
              <h3>{tr('Edit entry')}</h3>
              <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
              <select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as ScriptStatus })}>{STATUSES.map((s) => <option key={s} value={s}>{tr(s)}</option>)}</select>
              <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} style={{ minHeight: 120 }} />
              <div className="tiny muted">{tr('Edited entries are marked and never changed automatically again.')}</div>
              <div className="row"><button className="primary small" onClick={save}>{tr('Save')}</button><button className="ghost small" onClick={() => setEditing(null)}>{tr('Cancel')}</button></div>
            </div>
          )}
          <div className="card">
            <h3>{tr('Reviewed changes')} <span className="pill">{changes.length}</span></h3>
            <div className="tiny muted">{tr('What the first model proposed from play and what the reviewer decided. Only approved changes were applied.')}</div>
            {changes.length === 0 && <div className="muted small" style={{ marginTop: 6 }}>{tr('No automatic changes yet.')}</div>}
            {changes.map((c) => (
              <div key={c.id} className="node">
                <div className="row" style={{ flexWrap: 'wrap' }}><span className={`pill ${c.verdict === 'approved' ? 'ok' : 'danger'}`}>{tr(c.verdict)}</span><span className="small"><b>{c.op}</b>{c.title ? `: ${c.title}` : c.proposal?.title ? `: ${c.proposal.title}` : ''}{c.proposal?.status ? ` → ${c.proposal.status}` : ''}</span><span className="grow" /><span className="tiny muted">{new Date(c.created_at).toLocaleString(currentLocale())}</span></div>
                <div className="tiny muted">{c.reviewer_reason}</div>
                {c.evidence.slice(0, 2).map((ev, i) => <div key={i} className="cit">“{ev.text}”</div>)}
                {c.source_event_ids.length > 0 && <button className="ghost small" onClick={() => showEvidence(c.source_event_ids)}>{tr('events')}</button>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
