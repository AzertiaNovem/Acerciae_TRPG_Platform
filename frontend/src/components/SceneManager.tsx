import { t as tr } from '../i18n';
import { useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import type { Scene } from '../types';

// Scenarios are the stages of the story. The Keeper's observer opens the next one when the narration moves the
// story to a new place or time and summarizes the one that closed; the GM can do both by hand and edit any summary.
export default function SceneManager() {
  const { channelId, channel, scenes, windows, refreshScenes, refreshWindows } = useNav();
  const toast = useUi((s) => s.toast);
  const [form, setForm] = useState<Partial<Scene>>({ title: '', location: '', narrative_time: '' });
  const [edit, setEdit] = useState<Scene | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const create = async () => { if (!channelId || !form.title) return; try { await api.createScene(channelId, form as any); setForm({ title: '', location: '', narrative_time: '' }); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } };
  const save = async () => { if (!channelId || !edit) return; try { await api.updateScene(channelId, edit.id, edit); setEdit(null); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } };
  const assign = async (windowId: string, sceneId: string) => { if (!channelId || !sceneId) return; await api.enterScene(channelId, windowId, sceneId); toast(tr('Window moved into scenario')); refreshWindows(); refreshScenes(); };
  const advance = async (windowId: string) => { if (!channelId) return; setBusy(windowId); try { await api.advanceScenario(channelId, { chat_window_id: windowId }); toast(tr('Next scenario opened; the previous one is being summarized.')); refreshWindows(); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); } };
  const summarize = async (s: Scene) => { if (!channelId) return; setBusy(s.id); try { await api.summarizeScene(channelId, s.id); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); } };
  const toggleAuto = async (on: boolean) => { if (!channelId) return; try { await api.setAutoScenarios(channelId, on); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <div>
      <div className="card">
        <div className="row"><h3 style={{ margin: 0 }}>{tr("Scenarios")}</h3><span className="grow" /><label className="tiny"><input type="checkbox" checked={channel?.auto_scenarios !== false} onChange={(e) => toggleAuto(e.target.checked)} /> {tr("Detect new stages automatically")}</label></div>
        <div className="tiny muted" style={{ marginTop: 4 }}>{tr("The AI watches each chat window. When the Keeper's narration moves the story to a new place or time, it opens the next scenario from that line and summarizes the one that closed. Summaries you edit are never overwritten.")}</div>
      </div>
      <div className="card">
        <h3>{tr("New scenario")}</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input placeholder={tr("Title")} value={form.title ?? ''} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input placeholder={tr("Location")} value={form.location ?? ''} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <input placeholder={tr("Narrative time")} value={form.narrative_time ?? ''} onChange={(e) => setForm({ ...form, narrative_time: e.target.value })} />
          <button className="primary" onClick={create} disabled={!form.title}>{tr("Create")}</button>
        </div>
      </div>
      <div className="card">
        <h3>{tr("Scenario list")}</h3>
        <table className="simple"><thead><tr><th>#</th><th>{tr("title")}</th><th>{tr("where / when")}</th><th>{tr("status")}</th><th>{tr("summary")}</th><th>{tr("windows")}</th><th /></tr></thead><tbody>
          {scenes.map((s) => (
            <tr key={s.id}>
              <td>{s.sequence}</td>
              <td>{edit?.id === s.id ? <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /> : <>{s.title}{s.auto_detected && <span className="pill ai" style={{ marginLeft: 4 }} title={s.stage_reason}>AI</span>}</>}</td>
              <td>{edit?.id === s.id ? <div className="col"><input value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} /><input value={edit.narrative_time} onChange={(e) => setEdit({ ...edit, narrative_time: e.target.value })} /></div> : <>{s.location}<div className="tiny muted">{s.narrative_time}</div></>}</td>
              <td><span className={`pill ${s.status === 'active' ? 'ok' : ''}`}>{tr(s.status)}</span>{s.off_module && <span className="pill danger" style={{ marginLeft: 4 }}>{tr("off module")}</span>}</td>
              <td style={{ maxWidth: 380 }}>
                {edit?.id === s.id ? <textarea value={edit.summary} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} style={{ width: '100%', minHeight: 70 }} /> : (
                  <>
                    <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{s.summary || <span className="muted">—</span>}</div>
                    {(s.key_points ?? []).length > 0 && <ul className="tiny muted" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{s.key_points!.map((k, i) => <li key={i}>{k}</li>)}</ul>}
                    <div className="row tiny" style={{ marginTop: 2 }}>
                      {s.summary_status === 'ready' && <span className="pill">{tr("AI summary")}{s.summary_llm_mode === 'mock' ? ' · mock' : ''}</span>}
                      {s.summary_status === 'gm_edited' && <span className="pill gm">{tr("GM")}</span>}
                      {s.summary_status === 'pending' && <span className="pill">{tr("summarizing…")}</span>}
                    </div>
                  </>
                )}
              </td>
              <td className="tiny muted">{(s.windows ?? []).map((w) => w.name).join(', ')}</td>
              <td className="row" style={{ flexWrap: 'wrap' }}>{edit?.id === s.id ? <><button className="primary small" onClick={save}>{tr("Save")}</button><button className="ghost small" onClick={() => setEdit(null)}>{tr("Cancel")}</button></> : <><button className="ghost small" onClick={() => setEdit(s)}>{tr("edit")}</button><button className="ghost small" onClick={() => summarize(s)} disabled={busy === s.id}>{tr("Summarize")}</button>{s.status === 'active' && <button className="ghost small" onClick={() => channelId && api.closeScene(channelId, s.id).then(refreshScenes)}>{tr("close")}</button>}</>}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="card">
        <h3>{tr("Chat windows and scenarios")}</h3>
        <div className="tiny muted">{tr("A window may span many scenarios and a scenario may host many windows. Moving a window records a scene.entered event witnessed by its participants.")}</div>
        <table className="simple" style={{ marginTop: 6 }}><tbody>
          {windows.map((w) => (
            <tr key={w.id}><td>{w.name}</td><td className="tiny muted">{(w.members ?? []).map((m) => m.character_name ?? m.display_name).join(', ')}</td>
              <td><select value={w.active_scene_id ?? ''} onChange={(e) => assign(w.id, e.target.value)}><option value="">{tr("— no scenario —")}</option>{scenes.filter((s) => s.status === 'active').map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></td>
              <td><button className="small" onClick={() => advance(w.id)} disabled={busy === w.id}>{tr("Next scenario")}</button></td></tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
