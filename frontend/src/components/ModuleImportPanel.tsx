import { t as tr } from '../i18n';
import { useEffect, useState } from 'react';
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
  const load = async () => { if (!channelId) return; const ms = await api.modules(channelId); setModules(ms); if (ms[0]) setCurrent(await api.module(channelId, (current ?? ms[0]).id)); };
  useEffect(() => { load().catch(() => undefined); }, [channelId]);
  useEffect(() => { if (current && (current.status === 'extracting' || current.status === 'structuring' || current.status === 'uploaded')) { const t = setTimeout(() => load(), 2000); return () => clearTimeout(t); } }, [current]);
  const upload = async () => {
    if (!channelId) return;
    try {
      if (file) { await api.uploadModule(channelId, file, title || file.name); toast('PDF uploaded; extracting…'); }
      else if (text.trim()) { await api.importModuleText(channelId, title || 'Pasted module', text); toast('Module structured'); }
      else return;
      setFile(null); setText(''); setTitle(''); await load();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const saveNode = async () => { if (!channelId || !editing) return; try { await api.updateNode(channelId, editing.id, { name: editing.name, description: editing.description, node_type: editing.node_type, progress: editing.progress }); setEditing(null); await load(); } catch (e: any) { toast(e.message, 'error'); } };
  const nodes = (current?.nodes ?? []).filter((n) => !filter || n.node_type === filter);
  const outEdges = (id: string) => (current?.edges ?? []).filter((e) => e.from_node_id === id);
  return (
    <div>
      <div className="card">
        <h3>{tr("Import module")}</h3>
        <div className="tiny muted">{tr("Upload a PDF (text is extracted per page, then structured into a conditional knowledge graph with page citations) or paste text. Module content stays in its own GM-only layer, separate from what actually happens in play.")}</div>
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <input placeholder={tr("Title")} value={title} onChange={(e) => setTitle(e.target.value)} />
          <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="primary" onClick={upload} disabled={!file && !text.trim()}>{tr("Import")}</button>
        </div>
        <textarea placeholder={tr("…or paste module text here (blank line between sections)")} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', minHeight: 70, marginTop: 8 }} />
      </div>
      {modules.length > 0 && (
        <div className="card">
          <div className="row"><h3 style={{ margin: 0 }}>{tr("Modules")}</h3><span className="grow" />{modules.map((m) => <button key={m.id} className={`small ${current?.id === m.id ? 'primary' : ''}`} onClick={async () => channelId && setCurrent(await api.module(channelId, m.id))}>{m.title}</button>)}</div>
          {current && (
            <div style={{ marginTop: 8 }}>
              <div className="row small"><span className={`pill ${current.status === 'ready' ? 'ok' : current.status === 'failed' ? 'danger' : ''}`}>{current.status}</span><span className="muted">{current.page_count}{tr(" pages · ")}{current.nodes?.length ?? 0}{tr(" nodes · ")}{current.edges?.length ?? 0}{tr(" edges · ")}{current.llm_mode}{tr(" LLM")}</span>{current.error && <span style={{ color: 'var(--danger)' }}>{current.error}</span>}</div>
              <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}><button className={`small ${!filter ? 'primary' : ''}`} onClick={() => setFilter('')}>{tr("all")}</button>{TYPES.map((t) => <button key={t} className={`small ${filter === t ? 'primary' : ''}`} onClick={() => setFilter(t)}>{t} ({(current.nodes ?? []).filter((n) => n.node_type === t).length})</button>)}</div>
              <div className="grid-2" style={{ marginTop: 8 }}>
                <div>
                  {nodes.map((n) => (
                    <div key={n.id} className="node">
                      <div className="row"><span className="pill">{n.node_type}</span><b className="small">{n.name}</b><span className={`pill ${n.progress === 'untouched' ? '' : n.progress === 'completed' ? 'ok' : 'ai'}`}>{n.progress}</span>{n.gm_edited && <span className="pill gm">{tr("edited")}</span>}<span className="grow" /><button className="ghost small" onClick={() => setEditing({ ...n })}>{tr("edit")}</button></div>
                      <div className="small muted">{n.description.slice(0, 220)}</div>
                      {n.citations.slice(0, 2).map((c, i) => <div key={i} className="cit" style={{ cursor: 'pointer' }} onClick={async () => channelId && setPage(await api.modulePage(channelId, current.id, c.page))}>{tr("p.")}{c.page}: “{c.excerpt.slice(0, 120)}”</div>)}
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
