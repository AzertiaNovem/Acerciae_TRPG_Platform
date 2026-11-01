import { t as tr } from '../../i18n';
import { useState } from 'react';
import { useUi } from '../../store/ui';
import { buildProject, importFile } from '../import';
import type { Background, ParsedLog } from '../types';
import { saveProject } from '../storage';

const ADAPTER_LABEL: Record<string, string> = { native_json: 'Acerciae', sealdice_json: 'SealDice JSON', sealdice_text: 'SealDice TXT', rendered_log: 'story-painter', qq_export: 'QQ' };

// A new project from one or more log files (joined in time order) and what the logs do not say: the setting.
export default function NewProject({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const toast = useUi((s) => s.toast);
  const [files, setFiles] = useState<{ file: string; log: ParsedLog | null; error?: string }[]>([]);
  const [title, setTitle] = useState('');
  const [bg, setBg] = useState<Background>({ title: '', era: '', setting: '', summary: '' });
  const [busy, setBusy] = useState(false);
  const add = async (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      try { next.push({ file: f.name, log: importFile(f.name, new Uint8Array(await f.arrayBuffer())) }); }
      catch (e: any) { next.push({ file: f.name, log: null, error: String(e?.message ?? e) }); }
    }
    setFiles(next);
    const first = next.find((x) => x.log?.campaign?.name);
    if (!title) setTitle(first?.log?.campaign?.name || next[0]?.file.replace(/\.[^.]+$/, '') || '');
    if (!bg.era && first?.log?.campaign?.era) setBg({ ...bg, era: first.log.campaign.era });
  };
  const ok = files.filter((f) => f.log);
  const create = async () => {
    setBusy(true);
    try {
      const p = buildProject({ title: title.trim() || tr('Untitled'), background: { ...bg, title: title.trim() }, files: ok.map((f) => ({ file: f.file, log: f.log! })) });
      await saveProject(p);
      onCreated(p.id);
    } catch (e: any) { toast(String(e?.message ?? e), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="col" style={{ gap: 12, maxWidth: 820 }}>
      <div className="card col" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>{tr('1. Logs')}</h3>
        <p className="tiny muted" style={{ margin: 0 }}>{tr('SealDice text or JSON, QQ exports, story-painter text, or Acerciae exports. Several files of the same campaign are joined in time order and overlaps are removed. Platform ids (QQ numbers) are dropped.')}</p>
        <label className="button small" style={{ alignSelf: 'flex-start' }}>{tr('Add log files…')}<input type="file" multiple accept=".txt,.log,.json,text/plain,application/json" style={{ display: 'none' }} onChange={(e) => { add(e.target.files); e.target.value = ''; }} /></label>
        {files.map((f, i) => (
          <div key={i} className="row small" style={{ gap: 8 }}>
            <span className="grow">{f.file}</span>
            {f.log ? <span className="tiny muted">{ADAPTER_LABEL[f.log.adapter] ?? f.log.adapter} · {tr('{n} lines', { n: f.log.events.length })} · {tr('{n} speakers', { n: f.log.speakers.length })}{f.log.issues.length ? ` · ${tr('{n} notes', { n: f.log.issues.length })}` : ''}</span>
              : <span className="tiny" style={{ color: 'var(--danger)' }}>{f.error}</span>}
            <button className="ghost small" onClick={() => setFiles(files.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
      </div>
      <div className="card col" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>{tr('2. Background')}</h3>
        <p className="tiny muted" style={{ margin: 0 }}>{tr('What the log does not say. The script writer and the image service use it; the HTML and PDF show it.')}</p>
        <label className="col tiny" style={{ gap: 4 }}>{tr('Title')}<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="col tiny" style={{ gap: 4 }}>{tr('Era')}<input value={bg.era} onChange={(e) => setBg({ ...bg, era: e.target.value })} placeholder={tr('e.g. 1920s New England')} /></label>
        <label className="col tiny" style={{ gap: 4 }}>{tr('Special settings')}<textarea rows={3} value={bg.setting} onChange={(e) => setBg({ ...bg, setting: e.target.value })} placeholder={tr('House rules, tone, places, anything the story assumes')} /></label>
        <label className="col tiny" style={{ gap: 4 }}>{tr('Summary')}<textarea rows={3} value={bg.summary} onChange={(e) => setBg({ ...bg, summary: e.target.value })} /></label>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="ghost" onClick={onCancel}>{tr('Cancel')}</button>
        <button className="primary" disabled={!ok.length || busy} onClick={create}>{tr('Create the project')}</button>
        {!ok.length && <span className="tiny muted">{tr('Add at least one log file.')}</span>}
      </div>
    </div>
  );
}
