import PageCitations from './PageCitations';
import { t as tr } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { contextSocket } from '../api/ws';
import { sessionEpoch } from '../store/session';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import type { ModuleInfo, ModuleNode } from '../types';

const TYPES = ['stage', 'scene', 'location', 'npc', 'clue', 'item', 'secret', 'condition', 'twist', 'ending'];

export default function ModuleImportPanel() {
  const channelId = useNav((s) => s.channelId);
  const toast = useUi((s) => s.toast);
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [current, setCurrent] = useState<ModuleInfo | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<ModuleNode | null>(null);
  const [page, setPage] = useState<{ page_number: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const submitting = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const selected = useRef<string | null>(null);
  const channelRef = useRef(channelId); channelRef.current = channelId;
  const sequence = useRef(0);
  const needsPoll = useRef(true);
  const previous = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    if (!channelId) return;
    const seq = ++sequence.current, epoch = sessionEpoch();
    const valid = () => seq === sequence.current && channelRef.current === channelId && epoch === sessionEpoch();
    try {
      const ms = await api.modules(channelId);
      if (!valid()) return;
      const id = ms.find(m => m.id === selected.current)?.id || ms[0]?.id;
      const detail = id ? await api.module(channelId, id) : null;
      if (!valid()) return;
      for (const m of ms) {
        const before = previous.current.get(m.id);
        if (m.id === id && before && before !== m.status && m.status === 'ready')
          setNotice(tr(m.import_warning ? 'Module imported with a warning' : 'Module import complete'));
        if (m.id === id && before && before !== m.status && m.status === 'failed') setNotice(tr('Module import failed; retry the saved task'));
      }
      previous.current = new Map(ms.map(m => [m.id, m.status]));
      selected.current = id || null;
      setModules(ms); setCurrent(detail); setLoadError('');
      needsPoll.current = ms.some(m => !['ready','failed'].includes(m.status));
    } catch (e: any) { if (valid()) { needsPoll.current = true; setLoadError(e.message); } }
  }, [channelId, toast]);
  useEffect(() => {
    needsPoll.current = true; selected.current = null; previous.current.clear(); setModules([]); setCurrent(null);
    setNotice(''); setLoadError(''); setPage(null); setEditing(null);
    void load();
    const timer = setInterval(() => { if (needsPoll.current) void load(); }, 2000);
    const off = contextSocket.on(m => { if (m.type === '_open' || (m.channel_id === channelId && m.type === 'module.updated')) void load(); });
    return () => { ++sequence.current; clearInterval(timer); off(); };
  }, [channelId, load]);
  const upload = async () => {
    if (!channelId || submitting.current || (!file && !text.trim())) return;
    submitting.current = true; setBusy(true); setNotice(tr('Sending module; please do not submit again…'));
    const epoch = sessionEpoch();
    try {
      const result = file ? await api.uploadModule(channelId, file, title || file.name)
        : await api.importModuleText(channelId, title || 'Pasted module', text);
      if (epoch !== sessionEpoch() || channelRef.current !== channelId) return;
      selected.current = result.id; setCurrent(result);
      previous.current.set(result.id, result.status);
      const message = result.deduplicated ? 'This content was already received. Showing the existing import.'
        : result.status === 'ready' ? (result.import_warning ? 'Module imported with a warning' : 'Module import complete')
        : result.status === 'failed' ? 'Module import failed; retry the saved task'
        : 'Module received. Processing continues in the background; no need to import again.';
      setNotice(tr(message)); toast(message, result.status === 'failed' ? 'error' : 'info');
      setFile(null); if (fileInput.current) fileInput.current.value = ''; setText(''); setTitle(''); await load();
    } catch (e: any) {
      if (epoch !== sessionEpoch() || channelRef.current !== channelId) return;
      setNotice(tr('Could not confirm receipt. Check the import list before retrying; identical content is deduplicated.'));
      toast(e.message, 'error'); await load();
    } finally { submitting.current = false; setBusy(false); }
  };
  const retry = async () => {
    if (!channelId || !current || submitting.current) return;
    submitting.current = true; setBusy(true);
    try { await api.retryModule(channelId, current.id); await load(); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const stage = current?.import_stage || current?.status;
  const stageLabel = stage === 'queued' ? tr('Queued for import') : stage === 'extracting' ? tr('Extracting PDF text…')
    : stage === 'structuring' ? tr('Structuring: {done}/{total} sections', {done: current?.completed_chunks || 0, total: current?.total_chunks || 0})
    : stage === 'knowledge' ? tr('Preparing Keeper knowledge…') : stage === 'ready' ? tr('Module import complete') : tr('Failed');
  const active = !!current && !['ready', 'failed'].includes(current.status);
  const saveNode = async () => { if (!channelId || !editing) return; try { await api.updateNode(channelId, editing.id, { name: editing.name, description: editing.description, node_type: editing.node_type, progress: editing.progress }); setEditing(null); await load(); } catch (e: any) { toast(e.message, 'error'); } };
  const nodes = (current?.nodes ?? []).filter((n) => !filter || n.node_type === filter);
  const outEdges = (id: string) => (current?.edges ?? []).filter((e) => e.from_node_id === id);
  return (
    <div>
      <div className="card" aria-busy={busy}>
        <h3>{tr("Import module")}</h3>
        <div className="tiny muted">{tr("Upload a PDF (text is extracted per page, then structured into a conditional knowledge graph with page citations) or paste text. Module content stays in its own GM-only layer, separate from what actually happens in play.")}</div>
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <input disabled={busy} placeholder={tr("Title")} value={title} onChange={(e) => setTitle(e.target.value)} />
          <input ref={fileInput} disabled={busy} type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="primary" onClick={upload} disabled={busy || (!file && !text.trim())}>{busy ? tr("Uploading…") : tr("Import")}</button>
        </div>
        <textarea disabled={busy} placeholder={tr("…or paste module text here (blank line between sections)")} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', minHeight: 70, marginTop: 8 }} />
      </div>
      {notice && <p role="status">{notice}</p>}
      {loadError && <p role="alert">{tr('Progress temporarily unavailable; importing may still be running.')} {loadError}</p>}
      {modules.length > 0 && (
        <div className="card">
          <div className="row"><h3 style={{ margin: 0 }}>{tr("Modules")}</h3><span className="grow" />{modules.map((m) => <button key={m.id} className={`small ${current?.id === m.id ? 'primary' : ''}`} onClick={() => { selected.current = m.id; setEditing(null); setPage(null); void load(); }}>{m.title} · {m.status === 'ready' ? tr('Completed') : m.status === 'failed' ? tr('Failed') : tr('Importing…')}</button>)}</div>
          {current && (
            <div style={{ marginTop: 8 }}>
              <div role="status" aria-live="polite">
                <p>{stageLabel}</p>
                {active && <><progress aria-label={stageLabel}
                  value={stage === 'structuring' && current.total_chunks ? current.completed_chunks || 0 : undefined}
                  max={current.total_chunks || 1} style={{ width: '100%' }} />
                  <p className="tiny muted">{tr('Processing on the server. You can leave this panel and return later; do not reimport.')}</p></>}
                {current.status === 'failed' && <button disabled={busy} onClick={retry}>{tr('Retry saved import')}</button>}
                {current.import_warning && <p role="alert">{tr('Module imported with a warning')} · {tr('Keeper knowledge could not be completed. Rebuild it in Script Knowledge.')} {current.import_warning}</p>}
              </div>
              <div className="row small"><span className={`pill ${current.status === 'ready' ? 'ok' : current.status === 'failed' ? 'danger' : ''}`}>{current.status}</span><span className="muted">{current.page_count}{tr(" pages · ")}{current.nodes?.length ?? 0}{tr(" nodes · ")}{current.edges?.length ?? 0}{tr(" edges · ")}{current.llm_mode}{tr(" LLM")}</span>{current.error && <span style={{ color: 'var(--danger)' }}>{current.error}</span>}</div>
              <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}><button className={`small ${!filter ? 'primary' : ''}`} onClick={() => setFilter('')}>{tr("all")}</button>{TYPES.map((t) => <button key={t} className={`small ${filter === t ? 'primary' : ''}`} onClick={() => setFilter(t)}>{t} ({(current.nodes ?? []).filter((n) => n.node_type === t).length})</button>)}</div>
              <div className="grid-2" style={{ marginTop: 8 }}>
                <div>
                  {nodes.map((n) => (
                    <div key={n.id} className="node">
                      <div className="row"><span className="pill">{n.node_type}</span><b className="small">{n.name}</b><span className={`pill ${n.progress === 'untouched' ? '' : n.progress === 'completed' ? 'ok' : 'ai'}`}>{n.progress}</span>{n.gm_edited && <span className="pill gm">{tr("edited")}</span>}<span className="grow" /><button className="ghost small" onClick={() => setEditing({ ...n })}>{tr("edit")}</button></div>
                      <div className="small muted">{n.description.slice(0, 220)}</div>
                      <PageCitations citations={n.citations} maxExcerpt={120} onPage={async (page) => { if (channelId) setPage(await api.modulePage(channelId, current.id, page)); }} />
                      {outEdges(n.id).length > 0 && <div className="tiny muted">→ {outEdges(n.id).map((e) => `${e.relation} ${e.to_name}`).join(' · ')}</div>}
                    </div>
                  ))}
                </div>
                <div>
                  {editing && (
                    <div className="card col">
                      <h3>{tr("Edit node")}</h3>
                      <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                      <select value={editing.node_type} onChange={(e) => setEditing({ ...editing, node_type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
                      <select value={editing.progress} onChange={(e) => setEditing({ ...editing, progress: e.target.value })}>{['untouched', 'active', 'revealed', 'completed', 'skipped'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
                      <textarea value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} style={{ minHeight: 100 }} />
                      <div className="row"><button className="primary small" onClick={saveNode}>{tr("Save")}</button><button className="ghost small" onClick={() => setEditing(null)}>{tr("Cancel")}</button></div>
                    </div>
                  )}
                  {page && <div className="card"><div className="row"><h3 style={{ margin: 0 }}>{tr("Page ")}{page.page_number}</h3><span className="grow" /><button className="ghost small" onClick={() => setPage(null)}>✕</button></div><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'var(--font)' }}>{page.text}</pre></div>}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
