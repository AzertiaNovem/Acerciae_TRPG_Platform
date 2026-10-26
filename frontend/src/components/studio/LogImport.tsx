import { t as tr, currentLocale } from '../../i18n';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useNav } from '../../store/nav';
import { useStudio } from '../../store/studio';
import { useUi } from '../../store/ui';
import type { LogImport as LogImportT, SpeakerMapEntry } from '../../types';

// Import pipeline UI: format detection → encoding → parse preview → speaker/character mapping → commit.
export default function LogImport() {
  const { channelId, characters } = useNav();
  const { project, reloadEvents, loadProjects } = useStudio();
  const toast = useUi((s) => s.toast);
  const [adapters, setAdapters] = useState<{ name: string; supported: string }[]>([]);
  const [adapter, setAdapter] = useState('auto');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<LogImportT | null>(null);
  const [map, setMap] = useState<Record<string, SpeakerMapEntry>>({});
  const [history, setHistory] = useState<LogImportT[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (channelId) api.studioAdapters(channelId).then(setAdapters).catch(() => undefined); }, [channelId]);
  useEffect(() => { if (channelId && project) api.studioImports(channelId, project.id).then(setHistory).catch(() => undefined); }, [channelId, project?.id, preview]);
  if (!project) return <div className="card muted">{tr("Select or create a log project in the Library first.")}</div>;
  const run = async () => {
    if (!channelId) return; setBusy(true);
    try {
      const p = file ? await api.studioPreviewImportFile(channelId, project.id, file, adapter) : await api.studioPreviewImportText(channelId, project.id, text, adapter);
      setPreview(p); setMap(p.speakers ?? {});
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const commit = async () => {
    if (!channelId || !preview) return; setBusy(true);
    try { const r = await api.studioCommitImport(channelId, project.id, preview.id, map); toast(`Imported ${r.committed_events} events into "${project.title}"`); setPreview(null); setText(''); setFile(null); await reloadEvents(channelId); await loadProjects(channelId); }
    catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const setEntry = (k: string, patch: Partial<SpeakerMapEntry>) => setMap({ ...map, [k]: { ...map[k], ...patch } });
  return (
    <div>
      <div className="card">
        <h3>{tr("Import an external log into “")}{project.title}”</h3>
        <div className="tiny muted">{tr("Supported: ")}{adapters.map((a) => a.name).join(', ')}{tr(". Unrecognised lines are never dropped: they are kept as raw text and listed in the report. Original text is stored verbatim.")}</div>
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <select value={adapter} onChange={(e) => setAdapter(e.target.value)}><option value="auto">{tr("Auto-detect format")}</option>{adapters.map((a) => <option key={a.name} value={a.name} title={a.supported}>{a.name}</option>)}</select>
          <input type="file" accept=".txt,.json,.log,text/plain,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="primary" onClick={run} disabled={busy || (!file && !text.trim())}>{busy ? tr("Parsing…") : tr("Parse & preview")}</button>
        </div>
        <textarea placeholder={tr("…or paste log text here (SealDice text/JSON, QQ export, story-painter rendered, Acerciae JSON)")} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', minHeight: 110, marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12 }} />
        {adapters.length > 0 && <details className="tiny muted" style={{ marginTop: 6 }}><summary>{tr("Format compatibility notes")}</summary><ul>{adapters.map((a) => <li key={a.name}><b>{a.name}</b>: {a.supported}</li>)}</ul></details>}
      </div>
      {preview && (
        <>
          <div className="grid-2">
            <div className="card">
              <h3>{tr("Parse report")}</h3>
              <div className="small">{tr("Adapter ")}<span className="pill">{preview.adapter}</span>{tr(" · encoding ")}<span className="pill">{preview.encoding}</span> · {preview.stats?.events}{tr(" events · ")}{preview.stats?.speakers}{tr(" speakers · ")}{preview.stats?.unrecognised ?? 0}{tr(" unrecognised")}</div>
              <div className="tiny muted" style={{ marginTop: 4 }}>{Object.entries(preview.stats?.by_type ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>
              {(preview.issues ?? []).length > 0 && <div style={{ marginTop: 8 }}><b className="small">{tr("Issues")}</b>{(preview.issues ?? []).slice(0, 30).map((is, i) => <div key={i} className="tiny" style={{ color: is.severity === 'error' ? 'var(--danger)' : 'var(--warn)' }}>{tr("line ")}{is.line_no}: {is.reason}{is.raw ? ` — “${is.raw.slice(0, 80)}”` : ''}</div>)}</div>}
            </div>
            <div className="card">
              <h3>{tr("Character mapping")}</h3>
              <div className="tiny muted">{tr("The same investigator may appear under different nicknames; map each speaker to a character (or drop it, e.g. bot chatter).")}</div>
              <table className="simple" style={{ marginTop: 6 }}><thead><tr><th>{tr("speaker")}</th><th>{tr("lines")}</th><th>{tr("role")}</th><th>{tr("character")}</th><th>{tr("drop")}</th></tr></thead><tbody>
                {Object.entries(map).map(([k, m]) => (
                  <tr key={k}>
                    <td><input value={m.display_name} onChange={(e) => setEntry(k, { display_name: e.target.value })} style={{ width: 130 }} /><div className="tiny muted">{m.im_user_id}</div></td>
                    <td>{m.message_count}</td>
                    <td><select value={tr(m.role)} onChange={(e) => setEntry(k, { role: e.target.value })}>{['pc', 'gm', 'npc', 'dice', 'system', 'hidden'].map((r) => <option key={r} value={r}>{r}</option>)}</select></td>
                    <td><select value={m.character_id ?? ''} onChange={(e) => setEntry(k, { character_id: e.target.value || null })}><option value="">{tr("— none —")}</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}{c.kind === 'npc' ? tr(" (NPC)") : ''}</option>)}</select>{m.suggested && <span className="pill ai" style={{ marginLeft: 4 }}>{tr("suggested")}</span>}</td>
                    <td><input type="checkbox" checked={!!m.drop} onChange={(e) => setEntry(k, { drop: e.target.checked })} /></td>
                  </tr>
                ))}
              </tbody></table>
              <div className="row" style={{ marginTop: 8 }}><button className="primary" onClick={commit} disabled={busy}>{tr("Confirm & save")}</button><button className="ghost" onClick={() => setPreview(null)}>{tr("Discard")}</button></div>
            </div>
          </div>
          <div className="card">
            <h3>{tr("Preview (first ")}{preview.preview?.length ?? 0}{tr(" events)")}</h3>
            <table className="simple"><thead><tr><th>#</th><th>{tr("type")}</th><th>{tr("speaker")}</th><th>{tr("content")}</th><th>{tr("time")}</th></tr></thead><tbody>
              {(preview.preview ?? []).map((e) => <tr key={e.sequence_number}><td>{e.sequence_number}</td><td><span className="pill">{tr(e.event_type)}</span>{e.unrecognised && <span className="pill danger">{tr("raw")}</span>}</td><td>{map[e.speaker_key]?.display_name ?? e.speaker_display_name}</td><td className="small" style={{ whiteSpace: 'pre-wrap' }}>{e.content}{e.dice?.total != null && <span className="pill" style={{ marginLeft: 4 }}>{e.dice.expression}={e.dice.total} {e.dice.outcome}</span>}</td><td className="tiny muted">{e.timestamp ? new Date(e.timestamp * 1000).toLocaleString(currentLocale()) : e.time_text}</td></tr>)}
            </tbody></table>
          </div>
        </>
      )}
      {history.length > 0 && (
        <div className="card"><h3>{tr("Import history")}</h3><table className="simple"><tbody>{history.map((h) => <tr key={h.id}><td>{h.file_name}</td><td><span className="pill">{h.adapter}</span></td><td><span className={`pill ${h.status === 'committed' ? 'ok' : ''}`}>{tr(h.status)}</span></td><td className="tiny muted">{h.stats?.events}{tr(" events · ")}{h.issue_count}{tr(" issues · ")}{new Date(h.created_at).toLocaleString(currentLocale())}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}
