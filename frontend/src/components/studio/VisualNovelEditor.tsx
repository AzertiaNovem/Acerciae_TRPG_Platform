import { t as tr } from '../../i18n';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import BundleDownload from './BundleDownload';
import { useNav } from '../../store/nav';
import { useStudio } from '../../store/studio';
import { useUi } from '../../store/ui';
import type { MediaAsset, Presentation, PresentationEvent, PresentationScene, CharacterPlacement } from '../../types';
import VNPlayer from './vn/VNPlayer';
import VnTemplatePanel from './VnTemplatePanel';
import VnWizard from './VnWizard';
import './vn/vn.css';

const KINDS = ['dialogue', 'narration', 'action', 'ooc', 'dice', 'scene_change', 'system', 'media'];
const TRANSITIONS = ['none', 'fade', 'crossfade', 'slide'];
const EFFECTS = ['none', 'shake', 'flash', 'zoom'];

// Left: scenes/events · Centre: live preview · Right: inspector · Bottom: timeline + controls.
export default function VisualNovelEditor() {
  const { channelId, channel, characters } = useNav();
  const { project, presentationId, setPresentation } = useStudio();
  const toast = useUi((s) => s.toast);
  const [list, setList] = useState<Presentation[]>([]);
  const [pres, setPres] = useState<Presentation | null>(null);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [playerMode, setPlayerMode] = useState(false);
  const names = useMemo(() => Object.fromEntries(characters.map((c) => [c.id, c.name])), [characters]);
  const visibleEvents = useMemo(() => (pres?.events ?? []).filter((e) => !e.hidden), [pres]);
  const cur = visibleEvents[index];

  const loadList = () => { if (channelId) api.presentations(channelId, project?.id).then(setList).catch(() => undefined); };
  const loadPres = async (id: string) => { if (!channelId) return; const p = await api.presentation(channelId, id); setPres(p); };
  useEffect(loadList, [channelId, project?.id]);
  useEffect(() => { if (channelId) api.mediaList(channelId).then(setAssets).catch(() => undefined); }, [channelId]);
  useEffect(() => { if (presentationId) loadPres(presentationId).catch(() => setPres(null)); else setPres(null); }, [presentationId, channelId]);
  useEffect(() => { if (channelId && presentationId && !playerMode) return; }, [playerMode]);

  const patchEvent = async (e: PresentationEvent, body: Partial<PresentationEvent>) => { if (!channelId || !pres) return; try { await api.updatePEvent(channelId, e.id, body); await loadPres(pres.id); } catch (err: any) { toast(err.message, 'error'); } };
  const patchScene = async (s: PresentationScene, body: Partial<PresentationScene>) => { if (!channelId || !pres) return; try { await api.updatePScene(channelId, s.id, body); await loadPres(pres.id); } catch (err: any) { toast(err.message, 'error'); } };
  const setPlacement = async (e: PresentationEvent, charId: string, patch: Partial<CharacterPlacement> | null) => {
    let list = [...(e.character_asset_ids ?? [])];
    if (patch === null) list = list.filter((p) => p.character_id !== charId);
    else { const i = list.findIndex((p) => p.character_id === charId); if (i >= 0) list[i] = { ...list[i], ...patch }; else list.push({ character_id: charId, position: 'center', ...patch }); }
    await patchEvent(e, { character_asset_ids: list });
  };
  const split = async (e: PresentationEvent) => { const text = e.display_text; const at = prompt(tr('Split after how many characters? (1–{max})', { max: [...text].length - 1 }), String(Math.floor([...text].length / 2))); if (!at) return; const n = +at; const bytes = new TextEncoder().encode([...text].slice(0, n).join('')).length; if (!channelId || !pres) return; try { await api.splitPEvent(channelId, e.id, [bytes]); await loadPres(pres.id); } catch (err: any) { toast(err.message, 'error'); } };
  const merge = async () => { if (!channelId || !pres || selected.length < 2) return; try { await api.mergePEvents(channelId, pres.id, selected); setSelected([]); await loadPres(pres.id); } catch (err: any) { toast(err.message, 'error'); } };
  const scene = cur?.scene_id ? pres?.scenes?.find((s) => s.id === cur.scene_id) : undefined;
  const bgAssets = assets.filter((a) => a.asset_type === 'background' && a.approval_status === 'approved');
  const standees = (cid: string) => assets.filter((a) => a.asset_type === 'standee' && a.character_id === cid && a.approval_status === 'approved');
  const bgmAssets = assets.filter((a) => (a.asset_type === 'bgm' || a.asset_type === 'audio') && a.approval_status === 'approved');

  if (!pres) {
    return (
      <div>
        <VnWizard onOpenEditor={(id) => { setPresentation(id); loadList(); }} />
        {list.length > 0 && (
          <div className="card">
            <h3>{tr("Drafts")}</h3>
            <div className="tiny muted">{tr("Open a draft in the advanced editor to adjust scenes, staging, art and timing line by line. The campaign log itself is never modified from here.")}</div>
            <table className="simple" style={{ marginTop: 8 }}><tbody>{list.map((p) => <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => setPresentation(p.id)}><td><b>{p.title}</b><div className="tiny muted">{p.snapshot_scope} · {p.line_count}{tr(" lines · ")}{p.voiced_count}{tr(" voiced · v")}{p.version}</div></td><td><button className="small">{tr("open")}</button></td></tr>)}</tbody></table>
          </div>
        )}
      </div>
    );
  }
  if (playerMode) return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}><b>{pres.title}</b><span className="grow" /><button className="small" onClick={() => setPlayerMode(false)}>{tr("← back to editor")}</button></div>
      <VNPlayer channelId={channelId!} presentation={pres} index={index} onIndexChange={setIndex} characterNames={names} />
      <div className="tiny muted" style={{ marginTop: 6 }}>{tr("Keys: space/→ next · ← previous · a auto-play · s skip TTS · l replay line · c standees · h hide UI · r raw log · f fullscreen")}</div>
    </div>
  );
  const canEdit = pres.can_edit;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <button className="ghost small" onClick={() => setPresentation(null)}>{tr("← presentations")}</button>
        <input value={pres.title} onChange={(e) => setPres({ ...pres, title: e.target.value })} onBlur={() => channelId && api.updatePresentation(channelId, pres.id, { title: pres.title })} style={{ fontWeight: 600 }} disabled={!canEdit} />
        <label className="tiny"><input type="checkbox" checked={pres.settings?.animations_enabled !== false} onChange={async (e) => { if (!channelId) return; await api.updatePresentation(channelId, pres.id, { settings: { animations_enabled: e.target.checked } }); loadPres(pres.id); }} disabled={!canEdit} />{tr(" animations")}</label>
        <label className="tiny">{tr("typewriter ")}<input type="number" min={5} max={120} value={pres.settings?.typewriter_cps ?? 28} onChange={(e) => setPres({ ...pres, settings: { ...pres.settings, typewriter_cps: +e.target.value } })} onBlur={() => channelId && api.updatePresentation(channelId, pres.id, { settings: { typewriter_cps: pres.settings?.typewriter_cps } })} style={{ width: 60 }} disabled={!canEdit} />{tr(" cps")}</label>
        <span className="grow" />
        <button className="primary small" onClick={() => setPlayerMode(true)}>{tr("▶ Play")}</button>
        <BundleDownload channelId={channelId!} presentationId={pres.id} />
        {canEdit && <button className="ghost small" onClick={async () => { if (!channelId || !confirm(tr('Delete this presentation?'))) return; await api.deletePresentation(channelId, pres.id); setPresentation(null); loadList(); }}>{tr("delete")}</button>}
      </div>
      <div className="vn-editor">
        <div className="card list">
          <h3>{tr("Scenes & lines")}</h3>
          {(pres.scenes ?? []).map((s) => (
            <div key={s.id}>
              <div className="row small" style={{ marginTop: 8, color: 'var(--warn)' }}><b>{s.title || `Scene ${s.position + 1}`}</b>{s.background_asset_id && <span className="pill">{tr("bg")}</span>}</div>
              {(pres.events ?? []).filter((e) => e.scene_id === s.id).map((e) => {
                const vi = visibleEvents.findIndex((v) => v.id === e.id);
                return (
                  <div key={e.id} className={`evt ${vi === index ? 'current' : ''} ${e.hidden ? 'hidden' : ''}`} onClick={() => { if (vi >= 0) setIndex(vi); }}>
                    <div className="row"><input type="checkbox" checked={selected.includes(e.id)} onChange={(ev) => setSelected(ev.target.checked ? [...selected, e.id] : selected.filter((x) => x !== e.id))} onClick={(ev) => ev.stopPropagation()} /><span className="who">{e.speaker_name_override ?? e.character_name ?? e.speaker_display_name}</span><span className="pill" style={{ fontSize: 10 }}>{e.display_kind}</span>{e.audio_asset_id && <span title={tr("voiced")}>🔊</span>}{e.ai_suggestion && <span className="sug" title={tr("AI suggestion pending")}>✦</span>}</div>
                    <div className="tiny muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.display_text}</div>
                  </div>
                );
              })}
            </div>
          ))}
          {canEdit && <div className="row" style={{ marginTop: 8 }}><button className="small" onClick={merge} disabled={selected.length < 2}>{tr("merge selected")}</button><button className="small" onClick={async () => { if (!channelId || !selected.length) return; await api.bulkPEvents(channelId, pres.id, selected, { hidden: true }); setSelected([]); loadPres(pres.id); }} disabled={!selected.length}>{tr("hide selected")}</button></div>}
        </div>
        <div>
          <VNPlayer channelId={channelId!} presentation={pres} index={index} onIndexChange={setIndex} editorMode characterNames={names} />
          <div className="vn-timeline">{visibleEvents.map((e, i) => <div key={e.id} className={`tick ${i === index ? 'current' : ''} ${e.audio_asset_id ? 'voiced' : ''} ${e.display_kind === 'scene_change' ? 'scene' : ''}`} title={`${i + 1}: ${e.display_text.slice(0, 60)}`} onClick={() => setIndex(i)} />)}</div>
          <div className="row"><button className="small" onClick={() => setIndex(Math.max(0, index - 1))}>{tr("⟨ prev")}</button><button className="small" onClick={() => setIndex(Math.min(visibleEvents.length - 1, index + 1))}>{tr("next ⟩")}</button><span className="tiny muted">{index + 1}/{visibleEvents.length}</span></div>
          <VnTemplatePanel presentation={pres} characters={characters} canEdit={!!canEdit}
            onPreview={(template) => setPres((p) => (p ? { ...p, settings: { ...p.settings, template } } : p))}
            onSave={async (template, presentationId) => { if (!channelId) return; try { await api.updatePresentation(channelId, presentationId, { settings: { template } }); } catch (err: any) { toast(err.message, 'error'); } }} />
        </div>
        <div className="card list">
          {scene && (
            <>
              <h3>{tr("Scene")}</h3>
              <input value={scene.title} onChange={(e) => setPres({ ...pres, scenes: pres.scenes!.map((s) => (s.id === scene.id ? { ...s, title: e.target.value } : s)) })} onBlur={(e) => patchScene(scene, { title: e.target.value })} disabled={!canEdit} />
              <label className="tiny">{tr("Background")}<select value={scene.background_asset_id ?? ''} onChange={(e) => patchScene(scene, { background_asset_id: e.target.value || null } as any)} disabled={!canEdit || scene.locked}><option value="">{tr("— none —")}</option>{bgAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label className="tiny">{tr("BGM")}<select value={scene.bgm_asset_id ?? ''} onChange={(e) => patchScene(scene, { bgm_asset_id: e.target.value || null } as any)} disabled={!canEdit}><option value="">{tr("— none —")}</option>{bgmAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label className="tiny">{tr("Environment")}<select value={scene.environment?.effect ?? 'none'} onChange={(e) => patchScene(scene, { environment: { ...scene.environment, effect: e.target.value } })} disabled={!canEdit}>{['none', 'rain', 'fog', 'dim', 'warm', 'cold'].map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
              <label className="tiny"><input type="checkbox" checked={scene.locked} onChange={(e) => patchScene(scene, { locked: e.target.checked })} disabled={!canEdit} />{tr(" lock background")}</label>
            </>
          )}
          {cur && (
            <>
              <h3 style={{ marginTop: 12 }}>{tr("Line ")}{index + 1}</h3>
              {/* The script's wording: the composer's rewrite or an edit here; the log keeps its own words. */}
              <label className="tiny">{tr("Script wording")}<textarea value={cur.script_text ?? cur.display_text} onChange={(e) => setPres({ ...pres, events: pres.events!.map((x) => (x.id === cur.id ? { ...x, script_text: e.target.value } : x)) })} onBlur={(e) => e.target.value !== (cur.script_text ?? cur.content ?? '') && patchEvent(cur, { script_text: e.target.value.trim() && e.target.value !== cur.content ? e.target.value : null })} disabled={!canEdit} style={{ minHeight: 60 }} /></label>
              {cur.script_text && <div className="tiny muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 90, overflow: 'auto', background: 'var(--bg-1)', padding: 6, borderRadius: 6 }}>{tr("In the log:")} {cur.content}{canEdit && <button className="ghost small" onClick={() => patchEvent(cur, { script_text: null })}>{tr("Use the log's wording")}</button>}</div>}
              <label className="tiny">{tr("Display as")}<select value={cur.display_kind} onChange={(e) => patchEvent(cur, { display_kind: e.target.value as any })} disabled={!canEdit}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
              <label className="tiny">{tr("Speaker")}<select value={cur.speaker_character_id ?? ''} onChange={(e) => patchEvent(cur, { speaker_character_id: e.target.value || null })} disabled={!canEdit}><option value="">{tr("— as logged —")}</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label className="tiny">{tr("Name override")}<input value={cur.speaker_name_override ?? ''} onChange={(e) => setPres({ ...pres, events: pres.events!.map((x) => (x.id === cur.id ? { ...x, speaker_name_override: e.target.value } : x)) })} onBlur={(e) => patchEvent(cur, { speaker_name_override: e.target.value || null })} disabled={!canEdit} /></label>
              <div className="tiny" style={{ marginTop: 6 }}><b>{tr("Standees on stage")}</b></div>
              {(cur.character_asset_ids ?? []).map((p) => (
                <div key={p.character_id} className="row tiny" style={{ flexWrap: 'wrap' }}>
                  <span style={{ minWidth: 80 }}>{names[p.character_id] ?? '?'}</span>
                  <select value={p.position} onChange={(e) => setPlacement(cur, p.character_id, { position: e.target.value })} disabled={!canEdit}><option value="left">{tr("left")}</option><option value="center">{tr("center")}</option><option value="right">{tr("right")}</option></select>
                  <select value={p.asset_id ?? ''} onChange={(e) => setPlacement(cur, p.character_id, { asset_id: e.target.value || null })} disabled={!canEdit}><option value="">{tr("no standee")}</option>{standees(p.character_id).map((a) => <option key={a.id} value={a.id}>{a.name}{a.expression ? ` (${a.expression})` : ''}</option>)}</select>
                  <label><input type="checkbox" checked={!!p.flip} onChange={(e) => setPlacement(cur, p.character_id, { flip: e.target.checked })} disabled={!canEdit} />{tr(" flip")}</label>
                  <button className="ghost small" onClick={() => setPlacement(cur, p.character_id, null)} disabled={!canEdit}>✕</button>
                </div>
              ))}
              {canEdit && <select onChange={(e) => { if (e.target.value) setPlacement(cur, e.target.value, { position: 'center' }); e.target.value = ''; }} defaultValue=""><option value="">{tr("+ add character to stage…")}</option>{characters.filter((c) => !(cur.character_asset_ids ?? []).some((p) => p.character_id === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
              <label className="tiny">{tr("Transition")}<select value={cur.transition} onChange={(e) => patchEvent(cur, { transition: e.target.value })} disabled={!canEdit}>{TRANSITIONS.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
              <label className="tiny">{tr("Effect")}<select value={cur.effect} onChange={(e) => patchEvent(cur, { effect: e.target.value })} disabled={!canEdit}>{EFFECTS.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
              <label className="tiny">{tr("Speech text (TTS adaptation; the script wording above stays as shown)")}<textarea value={cur.tts_text ?? ''} placeholder={cur.display_text} onChange={(e) => setPres({ ...pres, events: pres.events!.map((x) => (x.id === cur.id ? { ...x, tts_text: e.target.value } : x)) })} onBlur={(e) => patchEvent(cur, { tts_text: e.target.value || null })} disabled={!canEdit} style={{ minHeight: 50 }} /></label>
              <label className="tiny">{tr("Delivery instruction")}<input value={cur.style_instruction} placeholder={tr("e.g. whispering, hesitant, cold")} onChange={(e) => setPres({ ...pres, events: pres.events!.map((x) => (x.id === cur.id ? { ...x, style_instruction: e.target.value } : x)) })} onBlur={(e) => patchEvent(cur, { style_instruction: e.target.value })} disabled={!canEdit} /></label>
              {cur.ai_suggestion && canEdit && <div className="node"><div className="tiny"><b>{tr("✦ AI suggestion")}</b> — {cur.ai_suggestion.reason}</div><pre className="tiny" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(Object.fromEntries(Object.entries(cur.ai_suggestion).filter(([k]) => k !== 'reason' && k !== 'source')), null, 1)}</pre><div className="row"><button className="small primary" onClick={async () => { await api.decidePSuggestion(channelId!, cur.id, true); loadPres(pres.id); }}>{tr("accept")}</button><button className="small" onClick={async () => { await api.decidePSuggestion(channelId!, cur.id, false); loadPres(pres.id); }}>{tr("dismiss")}</button></div></div>}
              {canEdit && <div className="row" style={{ marginTop: 8 }}><button className="small" onClick={() => split(cur)}>{tr("split line…")}</button><button className="small" onClick={() => patchEvent(cur, { hidden: true })}>{tr("hide line")}</button></div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
