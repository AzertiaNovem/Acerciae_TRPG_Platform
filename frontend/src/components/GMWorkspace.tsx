import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import ModuleImportPanel from './ModuleImportPanel';
import SceneManager from './SceneManager';
import type { Proposal, ModuleHint, AiJob } from '../types';

type Tab = 'overview' | 'module' | 'scenes' | 'knowledge';

function Overview() {
  const { channelId } = useNav();
  const { toast, showEvidence } = useUi();
  const [ws, setWs] = useState<any | null>(null);
  const [status, setStatus] = useState<any | null>(null);
  const load = async () => { if (!channelId) return; const [w, s] = await Promise.all([api.gmWorkspace(channelId), api.aiStatus(channelId)]); setWs(w); setStatus(s); };
  useEffect(() => { load().catch(() => undefined); const t = setInterval(() => load().catch(() => undefined), 10000); return () => clearInterval(t); }, [channelId]);
  if (!ws) return <div className="muted">Loading…</div>;
  const decideProposal = async (p: Proposal, accept: boolean) => { if (!channelId) return; try { await api.decideProposal(channelId, p.id, accept); toast(accept ? 'Proposal accepted' : 'Proposal rejected'); load(); } catch (e: any) { toast(e.message, 'error'); } };
  const decideHint = async (h: ModuleHint, d: 'accepted' | 'dismissed') => { if (!channelId) return; await api.decideHint(channelId, h.id, d); load(); };
  const describeOp = (op: any) => op.op === 'share_knowledge' ? `Share knowledge of a fact with ${(op.character_ids ?? []).length} character(s): ${op.reason ?? ''}` : `${op.op}${op.status ? ` → ${op.status}` : ''}${op.summary ? `: ${op.summary}` : ''}${op.previous ? ` (was: “${op.previous}” [${op.previous_status ?? ''}])` : ''}`;
  return (
    <div>
      <div className="grid-2">
        <div className="card">
          <h3>AI observer</h3>
          <div className="small">Mode: <span className={`pill ${status?.llm?.mode === 'mock' ? '' : 'ok'}`}>{status?.llm?.mode} · {status?.llm?.model}</span></div>
          <div className="small muted" style={{ marginTop: 4 }}>Scans every {status?.interval_ms / 1000}s; consolidates every {status?.consolidate_interval_ms / 1000}s. Ticks: {status?.ticks}, groups processed: {status?.groups_processed}, LLM calls: {status?.llm_calls}.</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="small" onClick={() => channelId && api.observeNow(channelId).then((r) => { toast(`Observer ran: ${r.jobs.length} group(s)`); load(); })}>Run observer now</button>
            <button className="small" onClick={() => channelId && api.consolidateNow(channelId).then(() => { toast('Consolidation ran'); load(); })}>Consolidate now</button>
          </div>
          <table className="simple" style={{ marginTop: 8 }}><thead><tr><th>job</th><th>status</th><th>events</th><th>LLM</th><th>when</th></tr></thead><tbody>
            {(ws.recent_jobs as AiJob[]).slice(0, 8).map((j) => <tr key={j.id}><td>{j.kind} <span className="tiny muted">{j.group_key.slice(0, 8)}</span></td><td><span className={`pill ${j.status === 'failed' ? 'danger' : j.status === 'succeeded' ? 'ok' : ''}`}>{j.status}</span>{j.error && <div className="tiny" style={{ color: 'var(--danger)' }}>{j.error}</div>}</td><td>{j.event_count}</td><td>{j.llm_calls}</td><td className="tiny muted">{new Date(j.started_at).toLocaleTimeString()}</td></tr>)}
          </tbody></table>
        </div>
        <div className="card">
          <h3>Pending AI proposals <span className="pill">{ws.pending_proposals.length}</span></h3>
          <div className="tiny muted">Contradictions with confirmed records, edits to GM-authored entries and knowledge-sharing suggestions wait here instead of being applied silently.</div>
          {ws.pending_proposals.length === 0 && <div className="muted small" style={{ marginTop: 6 }}>Nothing pending.</div>}
          {(ws.pending_proposals as Proposal[]).map((p) => (
            <div key={p.id} className="node">
              <div className="row"><span className="pill">{p.doc_type ?? 'knowledge'}</span><span className="tiny muted">{p.rejection_reason}</span><span className="grow" />{p.source_event_ids?.length > 0 && <button className="ghost small" onClick={() => showEvidence(p.source_event_ids)}>events</button>}</div>
              {p.ops.map((op, i) => <div key={i} className="small" style={{ marginTop: 4 }}>{describeOp(op)}</div>)}
              <div className="row" style={{ marginTop: 6 }}><button className="primary small" onClick={() => decideProposal(p, true)}>Accept</button><button className="small" onClick={() => decideProposal(p, false)}>Reject</button></div>
            </div>
          ))}
        </div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>Potential associations <span className="pill">{ws.pending_hints.length}</span></h3>
          <div className="tiny muted">Raised when play touches or leaves module content. These are prompts, never facts.</div>
          {(ws.pending_hints as ModuleHint[]).map((h) => (
            <div key={h.id} className="node">
              <div className="small">{h.reason}</div>
              <div className="row" style={{ marginTop: 4 }}><span className="tiny muted">{h.node_type} · {h.node_name}</span><span className="grow" />{h.source_event_ids?.length > 0 && <button className="ghost small" onClick={() => showEvidence(h.source_event_ids)}>events</button>}<button className="ghost small" onClick={() => decideHint(h, 'accepted')}>mark revealed</button><button className="ghost small" onClick={() => decideHint(h, 'dismissed')}>dismiss</button></div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Module progress</h3>
          {ws.node_progress.length === 0 && <div className="muted small">No module imported yet.</div>}
          <table className="simple"><tbody>{ws.node_progress.map((r: any, i: number) => <tr key={i}><td>{r.node_type}</td><td><span className="pill">{r.progress}</span></td><td>{r.n}</td></tr>)}</tbody></table>
          <h3 style={{ marginTop: 12 }}>Scenes vs module</h3>
          <table className="simple"><tbody>{ws.scenes.map((s: any) => <tr key={s.id}><td>{s.title}<div className="tiny muted">{s.location}</div></td><td>{s.off_module ? <span className="pill danger">off module</span> : <span className="pill ok">{s.module_node_name ?? 'on module'}</span>}</td><td className="tiny muted">{s.event_count} events</td></tr>)}</tbody></table>
        </div>
      </div>
      <div className="card">
        <h3>GM-only knowledge <span className="pill gm">{ws.gm_secrets.length}</span></h3>
        <div className="tiny muted">Facts no player character knows. Share them from the Knowledge tab when the fiction reveals them.</div>
        {ws.gm_secrets.slice(0, 20).map((f: any) => <div key={f.id} className="small" style={{ marginTop: 4 }}><span className="pill">{f.kind}</span> <span className={`status-${f.status}`}>{f.status}</span> · {f.summary}</div>)}
      </div>
    </div>
  );
}

function Knowledge() {
  const { channelId, characters } = useNav();
  const toast = useUi((s) => s.toast);
  const [facts, setFacts] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [scope, setScope] = useState<{ scope: string; character_ids: string[] }>({ scope: 'gm', character_ids: [] });
  const load = () => { if (channelId) api.facts(channelId, undefined, query || undefined).then(setFacts); };
  useEffect(load, [channelId]);
  const pcs = characters.filter((c) => c.kind === 'pc');
  const startEdit = async (f: any) => { if (!channelId) return; setEditing(f.id); setScope(await api.factVisibility(channelId, f.id)); };
  const save = async () => { if (!channelId || !editing) return; try { await api.setFactVisibility(channelId, editing, scope); toast('Knowledge scope updated'); setEditing(null); load(); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <div className="card">
      <h3>Fact–knower mapping</h3>
      <div className="row"><input placeholder="search facts" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} /><button className="small" onClick={load}>Search</button></div>
      <table className="simple" style={{ marginTop: 8 }}><thead><tr><th>kind</th><th>fact</th><th>status</th><th>who knows</th><th /></tr></thead><tbody>
        {facts.map((f) => {
          const vis = (f.visibility ?? []) as { scope: string; character_id: string | null }[];
          const label = vis.some((v) => v.scope === 'public') ? 'everyone' : vis.filter((v) => v.scope === 'character').map((v) => characters.find((c) => c.id === v.character_id)?.name ?? '?').join(', ') || 'GM only';
          return (
            <tr key={f.id}><td>{f.kind}</td><td className="small">{f.summary}</td><td><span className={`status-${f.status}`}>{f.status}</span></td>
              <td className="small">{editing === f.id ? (
                <div className="col">
                  <select value={scope.scope} onChange={(e) => setScope({ ...scope, scope: e.target.value })}><option value="gm">GM only</option><option value="public">Everyone</option><option value="character">Specific characters</option></select>
                  {scope.scope === 'character' && pcs.map((c) => <label key={c.id} className="row tiny"><input type="checkbox" checked={scope.character_ids.includes(c.id)} onChange={(e) => setScope({ ...scope, character_ids: e.target.checked ? [...scope.character_ids, c.id] : scope.character_ids.filter((x) => x !== c.id) })} />{c.name}</label>)}
                  <div className="row"><button className="primary small" onClick={save}>Save</button><button className="ghost small" onClick={() => setEditing(null)}>Cancel</button></div>
                </div>) : label}</td>
              <td>{editing !== f.id && <button className="ghost small" onClick={() => startEdit(f)}>edit</button>}</td></tr>
          );
        })}
      </tbody></table>
    </div>
  );
}

export default function GMWorkspace() {
  const [tab, setTab] = useState<Tab>('overview');
  const setOpen = useNav((s) => s.setGmWorkspaceOpen);
  return (
    <div className="workspace">
      <div className="tabs">
        {(['overview', 'module', 'scenes', 'knowledge'] as Tab[]).map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        <span className="grow" /><button className="ghost" onClick={() => setOpen(false)}>← back to chat</button>
      </div>
      <div className="content">
        {tab === 'overview' && <Overview />}
        {tab === 'module' && <ModuleImportPanel />}
        {tab === 'scenes' && <SceneManager />}
        {tab === 'knowledge' && <Knowledge />}
      </div>
    </div>
  );
}
