import { t as tr } from '../i18n';
import { useState } from 'react';
import { api } from '../api/client';
import { useNav } from '../store/nav';
import { useUi } from '../store/ui';
import type { Scene } from '../types';

// Scenarios are the stages of the story and a campaign-wide state: every chat window is in the current one.
// Only the Keeper opens the next scenario; the previous one closes at that moment, is summarized, and can then
// only be consulted. The AI watches the narration and suggests a new scenario in the Keeper's dock; it never
// opens one itself. Summaries the Keeper edits are never overwritten.
export default function SceneManager() {
  const { channelId, channel, scenes, refreshScenes, refreshWindows } = useNav();
  const toast = useUi((s) => s.toast);
  const [form, setForm] = useState<Partial<Scene>>({ title: '', location: '', narrative_time: '' });
  const [edit, setEdit] = useState<Scene | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => { refreshScenes(); refreshWindows(); };
  const advance = async () => { if (!channelId) return; setBusy('advance'); try { await api.advanceScenario(channelId, form as any); setForm({ title: '', location: '', narrative_time: '' }); toast(tr('Next scenario opened; the previous one is being summarized.')); refresh(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); } };
  const prepare = async () => { if (!channelId || !form.title) return; try { await api.createScene(channelId, form as any); setForm({ title: '', location: '', narrative_time: '' }); toast(tr('Scenario prepared. Enter it when the story gets there.')); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } };
  const enter = async (s: Scene) => { if (!channelId) return; setBusy(s.id); try { await api.enterScenario(channelId, s.id); toast(tr('The campaign entered the scenario; the previous one is being summarized.')); refresh(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); } };
  const save = async () => { if (!channelId || !edit) return; try { await api.updateScene(channelId, edit.id, edit); setEdit(null); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } };
  const summarize = async (s: Scene) => { if (!channelId) return; setBusy(s.id); try { await api.summarizeScene(channelId, s.id); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); } };
  const toggleAuto = async (on: boolean) => { if (!channelId) return; try { await api.setAutoScenarios(channelId, on); refreshScenes(); } catch (e: any) { toast(e.message, 'error'); } };
  const currentId = channel?.current_scene_id ?? null;
  const current = scenes.find((s) => s.id === currentId);
  return (
    <div>
      <div className="card">
        <div className="row"><h3 style={{ margin: 0 }}>{tr("Scenarios")}</h3><span className="pill ok">{tr("now: ")}{current ? current.title : tr("none yet")}</span><span className="grow" /><label className="tiny"><input type="checkbox" checked={channel?.auto_scenarios !== false} onChange={(e) => toggleAuto(e.target.checked)} /> {tr("Suggest new scenarios from the narration")}</label></div>
        <div className="tiny muted" style={{ marginTop: 4 }}>{tr("The whole campaign is in one scenario at a time. When you open the next one, every chat window moves there, the previous scenario closes and is summarized, and it can only be consulted from then on. The AI suggests a new scenario in your dock when the narration shifts time or place; it never opens one itself.")}</div>
      </div>
      <div className="card">
        <h3>{tr("Next scenario")}</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input placeholder={tr("Title")} value={form.title ?? ''} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input placeholder={tr("Location")} value={form.location ?? ''} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <input placeholder={tr("Narrative time")} value={form.narrative_time ?? ''} onChange={(e) => setForm({ ...form, narrative_time: e.target.value })} />
          <button className="primary" onClick={advance} disabled={busy === 'advance'}>{tr("Open now")}</button>
          <button onClick={prepare} disabled={!form.title}>{tr("Prepare for later")}</button>
        </div>
        <div className="tiny muted" style={{ marginTop: 4 }}>{tr("Open now closes the current scenario at once. A prepared scenario waits in the list until you enter it.")}</div>
      </div>
      <div className="card">
        <h3>{tr("Scenario list")}</h3>
        <table className="simple"><thead><tr><th>#</th><th>{tr("title")}</th><th>{tr("where / when")}</th><th>{tr("status")}</th><th>{tr("summary")}</th><th /></tr></thead><tbody>
          {scenes.map((s) => (
            <tr key={s.id}>
              <td>{s.sequence}</td>
              <td>{edit?.id === s.id ? <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /> : s.title}</td>
              <td>{edit?.id === s.id ? <div className="col"><input value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} /><input value={edit.narrative_time} onChange={(e) => setEdit({ ...edit, narrative_time: e.target.value })} /></div> : <>{s.location}<div className="tiny muted">{s.narrative_time}</div></>}</td>
              <td>{s.id === currentId ? <span className="pill ok">{tr("current")}</span> : s.status === 'closed' ? <span className="pill">{tr("closed")}</span> : <span className="pill ai">{tr("prepared")}</span>}{s.off_module && <span className="pill danger" style={{ marginLeft: 4 }}>{tr("off module")}</span>}</td>
              <td style={{ maxWidth: 420 }}>
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
              <td className="row" style={{ flexWrap: 'wrap' }}>{edit?.id === s.id ? <><button className="primary small" onClick={save}>{tr("Save")}</button><button className="ghost small" onClick={() => setEdit(null)}>{tr("Cancel")}</button></> : <><button className="ghost small" onClick={() => setEdit(s)}>{tr("edit")}</button>{s.status === 'closed' && <button className="ghost small" onClick={() => summarize(s)} disabled={busy === s.id}>{tr("Summarize")}</button>}{s.status === 'active' && s.id !== currentId && <button className="small" onClick={() => enter(s)} disabled={busy === s.id}>{tr("Enter")}</button>}</>}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
