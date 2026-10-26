import StudioPolicyPanel from './StudioPolicyPanel';
import { useState } from 'react';
import { api } from '../../api/client';
import { useNav } from '../../store/nav';
import { useStudio } from '../../store/studio';
import { useUi } from '../../store/ui';

export default function LogLibrary() {
  const { channelId, channel, scenes: channelScenes, windows } = useNav();
  const { projects, project, snapshots, loadProjects, openProject, openSnapshot, snapshot, setView, reloadEvents } = useStudio();
  const toast = useUi((s) => s.toast);
  const isGm = channel?.my_role === 'gm';
  const [title, setTitle] = useState('');
  const [syncMode, setSyncMode] = useState<'campaign' | 'scenes' | 'range' | 'session'>('campaign');
  const [sceneIds, setSceneIds] = useState<string[]>([]);
  const [range, setRange] = useState({ from_seq: 0, to_seq: 100000 });
  const [session, setSession] = useState({ from: '', to: '' });
  const [winIds, setWinIds] = useState<string[]>([]);
  const [snapForm, setSnapForm] = useState<{ title: string; scope: string; mode: string; scene_keys: string[] }>({ title: '', scope: isGm ? 'gm_full' : 'pl_public', mode: 'campaign', scene_keys: [] });
  const myChar = channel?.my_character_ids?.[0];

  const create = async () => { if (!channelId || !title.trim()) return; try { const p = await api.studioCreateProject(channelId, { title: title.trim() }); setTitle(''); await loadProjects(channelId); await openProject(channelId, p.id); } catch (e: any) { toast(e.message, 'error'); } };
  const sync = async () => {
    if (!channelId || !project) return;
    const selection: Record<string, unknown> = { mode: syncMode, chat_window_ids: winIds };
    if (syncMode === 'scenes') selection.scene_ids = sceneIds; if (syncMode === 'range') Object.assign(selection, range); if (syncMode === 'session') Object.assign(selection, session);
    try { const r = await api.studioSync(channelId, project.id, selection); toast(`Pulled ${r.added} event(s) from the campaign record`); await reloadEvents(channelId); await loadProjects(channelId); } catch (e: any) { toast(e.message, 'error'); }
  };
  const createSnapshot = async () => {
    if (!channelId || !project) return;
    try {
      const body: any = { title: snapForm.title || undefined, scope: snapForm.scope, selection: { mode: snapForm.mode, scene_keys: snapForm.scene_keys } };
      if (snapForm.scope === 'character') body.scope_character_id = myChar;
      const s = await api.studioCreateSnapshot(channelId, project.id, body); toast(`Snapshot v${s.version} created (${s.event_count} events)`); await reloadEvents(channelId); await openSnapshot(channelId, s.id);
    } catch (e: any) { toast(e.message, 'error'); }
  };
  return (
    <div>
      <StudioPolicyPanel />
      <div className="grid-2">
        <div className="card">
          <h3>Log projects</h3>
          <div className="tiny muted">A project holds one canonical log (from the campaign record, imports or both). Snapshots freeze a selection; presentations and PDFs are built from snapshots.</div>
          <div className="row" style={{ marginTop: 8 }}><input placeholder="New project title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} /><button className="primary" onClick={create} disabled={!title.trim()}>Create</button></div>
          <table className="simple" style={{ marginTop: 8 }}><tbody>
            {projects.map((p) => (
              <tr key={p.id} style={{ cursor: 'pointer', background: project?.id === p.id ? 'var(--bg-3)' : undefined }} onClick={() => channelId && openProject(channelId, p.id)}>
                <td><b>{p.title}</b><div className="tiny muted">{p.source_kind} · v{p.version}</div></td>
                <td className="tiny muted">{p.event_count} events<br />{p.snapshot_count} snapshots · {p.presentation_count} presentations · {p.published_count} published</td>
                {isGm && <td><button className="ghost small" onClick={async (e) => { e.stopPropagation(); if (!channelId || !confirm(`Delete project "${p.title}" and everything built from it?`)) return; await api.studioDeleteProject(channelId, p.id); await openProject(channelId, null); await loadProjects(channelId); }}>delete</button></td>}
              </tr>
            ))}
            {projects.length === 0 && <tr><td className="muted small">No projects yet.</td></tr>}
          </tbody></table>
        </div>
        <div className="card">
          <h3>Pull from the campaign record</h3>
          {!project && <div className="muted small">Select a project first.</div>}
          {project && (
            <div className="col">
              <div className="tiny muted">Only events you are allowed to read are pulled (GM: everything, with each event's own visibility kept so later snapshots can be filtered per audience).</div>
              <select value={syncMode} onChange={(e) => setSyncMode(e.target.value as any)}><option value="campaign">Entire campaign</option><option value="scenes">Specific scenes</option><option value="session">Session (time window)</option><option value="range">Custom event range (seq)</option></select>
              {syncMode === 'scenes' && <select multiple value={sceneIds} onChange={(e) => setSceneIds([...e.target.selectedOptions].map((o) => o.value))} style={{ minHeight: 90 }}>{channelScenes.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>}
              {syncMode === 'range' && <div className="row"><input type="number" value={range.from_seq} onChange={(e) => setRange({ ...range, from_seq: +e.target.value })} /><input type="number" value={range.to_seq} onChange={(e) => setRange({ ...range, to_seq: +e.target.value })} /></div>}
              {syncMode === 'session' && <div className="row"><input type="datetime-local" value={session.from} onChange={(e) => setSession({ ...session, from: e.target.value })} /><input type="datetime-local" value={session.to} onChange={(e) => setSession({ ...session, to: e.target.value })} /></div>}
              <select multiple value={winIds} onChange={(e) => setWinIds([...e.target.selectedOptions].map((o) => o.value))} title="restrict to chat windows (optional)" style={{ minHeight: 60 }}>{windows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
              <div className="row"><button className="primary" onClick={sync}>Pull events</button>{isGm && <button onClick={() => setView('import')}>Import external log…</button>}</div>
            </div>
          )}
        </div>
      </div>
      {project && (
        <div className="grid-2">
          <div className="card">
            <h3>Snapshots <span className="pill">{snapshots.length}</span></h3>
            <div className="tiny muted">Immutable, versioned selections. Later chat changes never alter a snapshot; pull again and create a new version instead.</div>
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <input placeholder="Snapshot title" value={snapForm.title} onChange={(e) => setSnapForm({ ...snapForm, title: e.target.value })} />
              <select value={snapForm.scope} onChange={(e) => setSnapForm({ ...snapForm, scope: e.target.value })}>{isGm && <option value="gm_full">GM complete version</option>}<option value="pl_public">PL public version</option>{myChar && <option value="character">My character's perspective</option>}</select>
              <select value={snapForm.mode} onChange={(e) => setSnapForm({ ...snapForm, mode: e.target.value })}><option value="campaign">All events</option><option value="scenes">Selected scenes</option></select>
              {snapForm.mode === 'scenes' && <select multiple value={snapForm.scene_keys} onChange={(e) => setSnapForm({ ...snapForm, scene_keys: [...e.target.selectedOptions].map((o) => o.value) })} style={{ minHeight: 70 }}>{(project.scenes ?? []).map((s) => <option key={s.scene_key} value={s.scene_key}>{s.scene_title || s.scene_key} ({s.n})</option>)}</select>}
              <button className="primary" onClick={createSnapshot}>Create snapshot</button>
            </div>
            <table className="simple" style={{ marginTop: 8 }}><tbody>
              {snapshots.map((s) => (
                <tr key={s.id} style={{ background: snapshot?.id === s.id ? 'var(--bg-3)' : undefined }}>
                  <td><b>v{s.version}</b> {s.title}<div className="tiny muted">{s.scope} · {s.event_count} events · {new Date(s.created_at).toLocaleString()}</div></td>
                  <td className="row" style={{ flexWrap: 'wrap' }}>
                    <button className="small" onClick={() => channelId && openSnapshot(channelId, s.id)}>view</button>
                    <a className="small" href={api.studioExportUrl(channelId!, s.id, 'html')}>HTML</a>
                    <a className="small" href={api.studioExportUrl(channelId!, s.id, 'json')}>JSON</a>
                    <a className="small" href={api.studioExportUrl(channelId!, s.id, 'txt')}>TXT</a>
                    <a className="small" href={api.studioExportUrl(channelId!, s.id, 'sealdice_txt')}>SealDice TXT</a>
                    <button className="ghost small" onClick={() => { channelId && openSnapshot(channelId, s.id); setView('vn'); }}>visual novel →</button>
                    <button className="ghost small" onClick={() => { channelId && openSnapshot(channelId, s.id); setView('pdf'); }}>PDF →</button>
                  </td>
                </tr>
              ))}
            </tbody></table>
          </div>
          <div className="card">
            <h3>Project summary</h3>
            <div className="small">{project.event_count} canonical events · {(project.scenes ?? []).length} scenes · {(project.speakers ?? []).length} speakers</div>
            <table className="simple" style={{ marginTop: 6 }}><thead><tr><th>speaker</th><th>role</th><th>character</th><th>lines</th></tr></thead><tbody>
              {(project.speakers ?? []).map((sp) => <tr key={sp.speaker_key}><td>{sp.display_name}</td><td>{sp.role}</td><td className="tiny muted">{sp.character_id ? 'mapped' : '—'}</td><td>{sp.n}</td></tr>)}
            </tbody></table>
            {isGm && <button className="small" style={{ marginTop: 8 }} onClick={() => setView('editor')}>Open log editor →</button>}
          </div>
        </div>
      )}
    </div>
  );
}
