import { useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import type { Scene } from '../types';

export default function SceneManager() {
  const { channelId, scenes, windows, refreshScenes, refreshWindows } = useNav();
  const toast = useUi((s) => s.toast);
  const [form, setForm] = useState<Partial<Scene>>({ title: '', location: '', narrative_time: '' });
  const [edit, setEdit] = useState<Scene | null>(null);
  const create = async () => { if (!channelId || !form.title) return; try { await api.createScene(channelId, form as any); setForm({ title: '', location: '', narrative_time: '' }); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } };
  const save = async () => { if (!channelId || !edit) return; try { await api.updateScene(channelId, edit.id, edit); setEdit(null); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } };
  const assign = async (windowId: string, sceneId: string) => { if (!channelId || !sceneId) return; await api.enterScene(channelId, windowId, sceneId); toast('Window moved into scene'); refreshWindows(); refreshScenes(); };
  return (
    <div>
      <div className="card">
        <h3>New scene</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input placeholder="Title" value={form.title ?? ''} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input placeholder="Location" value={form.location ?? ''} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <input placeholder="Narrative time" value={form.narrative_time ?? ''} onChange={(e) => setForm({ ...form, narrative_time: e.target.value })} />
          <button className="primary" onClick={create} disabled={!form.title}>Create</button>
        </div>
      </div>
      <div className="card">
        <h3>Scenes</h3>
        <table className="simple"><thead><tr><th>#</th><th>title</th><th>location</th><th>time</th><th>status</th><th>windows</th><th /></tr></thead><tbody>
          {scenes.map((s) => (
            <tr key={s.id}>
              <td>{s.sequence}</td>
              <td>{edit?.id === s.id ? <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /> : s.title}</td>
              <td>{edit?.id === s.id ? <input value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} /> : s.location}</td>
              <td>{edit?.id === s.id ? <input value={edit.narrative_time} onChange={(e) => setEdit({ ...edit, narrative_time: e.target.value })} /> : s.narrative_time}</td>
              <td><span className={`pill ${s.status === 'active' ? 'ok' : ''}`}>{s.status}</span>{s.off_module && <span className="pill danger" style={{ marginLeft: 4 }}>off module</span>}</td>
              <td className="tiny muted">{(s.windows ?? []).map((w) => w.name).join(', ')}</td>
              <td className="row">{edit?.id === s.id ? <><button className="primary small" onClick={save}>Save</button><button className="ghost small" onClick={() => setEdit(null)}>Cancel</button></> : <><button className="ghost small" onClick={() => setEdit(s)}>edit</button>{s.status === 'active' && <button className="ghost small" onClick={() => channelId && api.closeScene(channelId, s.id).then(refreshScenes)}>close</button>}</>}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="card">
        <h3>Move chat windows between scenes</h3>
        <div className="tiny muted">A window may span many scenes and a scene may host many windows. Moving a window records a scene.entered event witnessed by its participants.</div>
        <table className="simple" style={{ marginTop: 6 }}><tbody>
          {windows.map((w) => (
            <tr key={w.id}><td>{w.name}</td><td className="tiny muted">{(w.members ?? []).map((m) => m.character_name ?? m.display_name).join(', ')}</td>
              <td><select value={w.active_scene_id ?? ''} onChange={(e) => assign(w.id, e.target.value)}><option value="">— no scene —</option>{scenes.filter((s) => s.status === 'active').map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></td></tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
