import { t as tr, currentLocale } from '../../i18n';
import { useEffect, useMemo, useState } from 'react';
import { useUi } from '../../store/ui';
import { appendLogs, importFile, mergeLogs, type LogFile } from '../import';
import type { CharacterSheet, Project } from '../types';
import { openProject, updateProject, useProjects, viewProject } from '../projects';
import CharactersPanel from './CharactersPanel';
import ExportPanel from './ExportPanel';
import VnPanel from './VnPanel';

type Tab = 'overview' | 'characters' | 'log' | 'export' | 'vn';

// One project: its background and sources, the cast, the log, and what can be made from it. Every change is saved
// to this computer shortly after it is made.
export default function ProjectView({ id }: { id: string }) {
  const toast = useUi((s) => s.toast);
  const p = useProjects((s) => s.projects[id] ?? null);
  const [tab, setTab] = useState<Tab>('overview');
  // The project stays open while it is shown (and while AI tasks work on it, after the view is gone).
  useEffect(() => {
    const release = viewProject(id);
    openProject(id).catch((e) => toast(String(e?.message ?? e), 'error'));
    return release;
  }, [id]);
  // Changes go through the project store: shown at once, saved half a second after the last one.
  const update = (fn: (draft: Project) => void) => { updateProject(id, fn); };
  if (!p) return <div className="muted">{tr('Loading…')}</div>;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="open-studio-title" value={p.title} onChange={(e) => update((d) => { d.title = e.target.value; d.background.title = e.target.value; })} />
        <span className="tiny muted">{tr('{n} lines', { n: p.events.length })} · {tr('{n} characters', { n: p.characters.length })}</span>
      </div>
      <nav className="row open-studio-tabs" role="tablist">
        {([['overview', tr('Overview')], ['characters', tr('Characters')], ['log', tr('Log')], ['export', tr('HTML & PDF')], ['vn', tr('Visual novel')]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary small' : 'ghost small'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>
      {tab === 'overview' && <Overview p={p} update={update} />}
      {tab === 'characters' && <CharactersPanel p={p} update={update} />}
      {tab === 'log' && <LogList p={p} />}
      {tab === 'export' && <ExportPanel p={p} update={update} />}
      {tab === 'vn' && <VnPanel p={p} update={update} />}
    </div>
  );
}

function Overview({ p, update }: { p: Project; update: (fn: (d: Project) => void) => void }) {
  const toast = useUi((s) => s.toast);
  // More logs of the same campaign. Without a visual novel they are joined into the project in time order. With one,
  // they are a supplement: added after the last line, so the lines keep their numbers and the visual novel can be
  // continued from where it ended (Visual novel → Continue the story).
  const addLogs = async (list: FileList | null) => {
    if (!list?.length) return;
    try {
      const files: LogFile[] = [];
      for (const f of Array.from(list)) files.push({ file: f.name, log: importFile(f.name, new Uint8Array(await f.arrayBuffer())) });
      if (p.vn) {
        // The updater runs when React gets to it; the report comes from the same append on a copy.
        const report = appendLogs(structuredClone(p), files);
        update((d) => { appendLogs(d, files); });
        toast(tr('Supplement added: {added} new lines ({dup} already in the project). Continue the story in Visual novel.', { added: report.added, dup: report.duplicates }));
        if (report.earlier) toast(tr('{n} of the new lines are dated before the project\'s last line; they were added at the end.', { n: report.earlier }));
        return;
      }
      update((d) => {
        // The project's lines go in grouped by the file they came from, so they keep their source names.
        const byFile = new Map<string, Project['events']>();
        for (const e of d.events) { const k = e.source.file; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k)!.push(e); }
        const existing: LogFile[] = [...byFile].map(([file, events]) => ({ file, log: { adapter: 'native_json', format_version: '', events, speakers: d.speakers.filter((s) => events.some((e) => e.speaker_key === s.key)), issues: [] } }));
        const merged = mergeLogs([...existing, ...files]);
        d.events = merged.events; d.speakers = merged.speakers; d.issues = [...d.issues, ...merged.issues];
        for (const f of files) d.sources.push({ file: f.file, adapter: f.log.adapter, events: f.log.events.length, imported_at: new Date().toISOString() });
        const covered = new Set(d.characters.flatMap((c) => c.speakers));
        for (const s of d.speakers) if (!covered.has(s.key) && (s.role === 'pc' || s.role === 'npc' || s.role === 'gm'))
          d.characters.push({ name: s.name, speakers: [s.key], kind: s.role as CharacterSheet['kind'], player: '', appearance: '', role_card: null, avatar: null, portrait: null, poses: {}, voice: '' });
      });
      toast(tr('{n} log files added', { n: files.length }));
    } catch (e: any) { toast(String(e?.message ?? e), 'error'); }
  };
  return (
    <div className="col" style={{ gap: 12, maxWidth: 860 }}>
      <div className="card col" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>{tr('Background')}</h3>
        <label className="col tiny" style={{ gap: 4 }}>{tr('Era')}<input value={p.background.era} onChange={(e) => update((d) => { d.background.era = e.target.value; })} /></label>
        <label className="col tiny" style={{ gap: 4 }}>{tr('Special settings')}<textarea rows={3} value={p.background.setting} onChange={(e) => update((d) => { d.background.setting = e.target.value; })} /></label>
        <label className="col tiny" style={{ gap: 4 }}>{tr('Summary')}<textarea rows={4} value={p.background.summary} onChange={(e) => update((d) => { d.background.summary = e.target.value; })} /></label>
      </div>
      <div className="card col" style={{ gap: 6 }}>
        <h3 style={{ margin: 0 }}>{tr('Sources')}</h3>
        {p.sources.map((s, i) => <div key={i} className="tiny">{s.file} · {s.adapter} · {tr('{n} lines', { n: s.events })} · {new Date(s.imported_at).toLocaleDateString(currentLocale())}</div>)}
        {p.issues.length > 0 && <details className="tiny"><summary>{tr('{n} notes from the import', { n: p.issues.length })}</summary>{p.issues.slice(0, 200).map((i, k) => <div key={k} className="muted">{i.file}:{i.line} — {i.reason}</div>)}</details>}
        {p.vn && <p className="tiny muted" style={{ margin: 0 }}>{tr('This project has a visual novel: logs you add now are a supplement, placed after its last line so the story can be continued.')}</p>}
        <label className="button small" style={{ alignSelf: 'flex-start' }}>{p.vn ? tr('Add a supplement log…') : tr('Add more logs…')}<input type="file" multiple accept=".txt,.log,.json,text/plain,application/json" style={{ display: 'none' }} onChange={(e) => { addLogs(e.target.files); e.target.value = ''; }} /></label>
      </div>
    </div>
  );
}

function LogList({ p }: { p: Project }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(300);
  const nameOf = useMemo(() => { const m = new Map<string, string>(); for (const c of p.characters) for (const k of c.speakers) m.set(k, c.name); return m; }, [p.characters]);
  const shown = useMemo(() => { const n = q.trim().toLowerCase(); return n ? p.events.filter((e) => e.content.toLowerCase().includes(n) || e.speaker_name.toLowerCase().includes(n)) : p.events; }, [p.events, q]);
  return (
    <div className="col" style={{ gap: 8 }}>
      <input placeholder={tr('Search the log')} value={q} onChange={(e) => { setQ(e.target.value); setLimit(300); }} style={{ maxWidth: 360 }} />
      <div className="open-studio-log">
        {shown.slice(0, limit).map((e) => (
          <div key={e.seq} className={`open-studio-line kind-${e.type}`}>
            <span className="tiny muted">{e.time ? new Date(e.time * 1000).toISOString().slice(0, 19).replace('T', ' ') : e.time_text}</span>
            <b>{nameOf.get(e.speaker_key) ?? e.speaker_name}</b>
            <span className="pill" style={{ fontSize: 10 }}>{tr(e.type)}</span>
            <div className="content">{e.content}</div>
          </div>
        ))}
      </div>
      {shown.length > limit && <button className="small" onClick={() => setLimit(limit + 500)}>{tr('Show more ({n} left)', { n: shown.length - limit })}</button>}
    </div>
  );
}
