import { t as tr, currentLocale } from '../../i18n';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useNav } from '../../store/nav';
import { useStudio } from '../../store/studio';
import { useUi } from '../../store/ui';
import { contextSocket } from '../../api/ws';
import type { VoiceProfile, PronunciationDictionary, TtsJob, Presentation } from '../../types';

const STYLE_PRESETS = ['calm narration', 'whispering', 'surprised', 'angry', 'hesitant', 'afraid', 'sad', 'cold', 'slow and cautious'];

// Maintain character voices, audition them, manage pronunciation, batch-synthesize with cost control.
export default function VoiceStudio() {
  const { channelId, channel, characters } = useNav();
  const { presentationId, project } = useStudio();
  const toast = useUi((s) => s.toast);
  const isGm = channel?.my_role === 'gm';
  const [status, setStatus] = useState<any>(null);
  const [available, setAvailable] = useState<{ id: string; name: string; language: string; gender: string }[]>([]);
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [dicts, setDicts] = useState<PronunciationDictionary[]>([]);
  const [usage, setUsage] = useState<any>(null);
  const [form, setForm] = useState<any>({ voice_type: 'preset', name: '', character_id: '', voice_id: '', language: 'zh', dialect: '', style_instruction: '', design_prompt: '', pronunciation_dictionary_id: '', consent_given: false, rights_holder: '', statement: '' });
  const [refFile, setRefFile] = useState<File | null>(null);
  const [previewText, setPreviewText] = useState('你说这把钥匙从未离开过办公室——那么昨晚是谁打开了地下室？ Then who unlocked the basement last night?');
  const [previewStyle, setPreviewStyle] = useState('');
  const [previewAudio, setPreviewAudio] = useState<{ url: string; note: string; mock: boolean; spoken: string } | null>(null);
  const [dictEdit, setDictEdit] = useState<{ id: string | null; name: string; text: string }>({ id: null, name: 'Campaign pronunciations', text: 'Cthulhu=克苏鲁\nNyarlathotep=奈亚拉托提普\nR\'lyeh=拉莱耶' });
  const [presentations, setPresentations] = useState<Presentation[]>([]);
  const [selPres, setSelPres] = useState<string>(presentationId ?? '');
  const [estimate, setEstimate] = useState<any>(null);
  const [jobs, setJobs] = useState<TtsJob[]>([]);
  const [force, setForce] = useState(false);
  const load = async () => { if (!channelId) return; const [st, av, vs, ds, us, ps] = await Promise.all([api.ttsStatus(channelId), api.ttsAvailableVoices(channelId), api.voices(channelId), api.dictionaries(channelId), api.ttsUsage(channelId), api.presentations(channelId, project?.id)]); setStatus(st); setAvailable(av); setVoices(vs); setDicts(ds); setUsage(us); setPresentations(ps); if (!selPres && ps[0]) setSelPres(presentationId ?? ps[0].id); };
  useEffect(() => { load().catch(() => undefined); }, [channelId, project?.id]);
  useEffect(() => { if (!channelId || !selPres) return; let active=true; const refresh=()=>api.ttsJobs(channelId,selPres).then(rows=>active&&setJobs(rows)).catch(()=>undefined); refresh(); const timer=setInterval(refresh,2500); return()=>{active=false;clearInterval(timer);}; }, [channelId,selPres]);
  useEffect(()=>{setEstimate(null);},[selPres,force,voices]);
  useEffect(() => contextSocket.on((m) => { if (m.type === 'studio.tts.progress' || m.type === 'studio.tts.finished') { if (channelId && selPres) api.ttsJobs(channelId, selPres).then(setJobs).catch(() => undefined); if (m.type === 'studio.tts.finished') { toast(`Voiceover job ${m.payload.status}: ${m.payload.done} done, ${m.payload.cached} from cache, ${m.payload.failed} failed`, 'ai'); api.ttsUsage(channelId!).then(setUsage); } } }), [channelId, selPres]);

  const createVoice = async () => {
    if (!channelId) return;
    try {
      const base: Record<string, any> = { voice_type: form.voice_type, name: form.name, character_id: form.character_id || undefined, voice_id: form.voice_id, language: form.language, dialect: form.dialect, style_instruction: form.style_instruction, pronunciation_dictionary_id: form.pronunciation_dictionary_id || undefined, design_prompt: form.design_prompt };
      if (form.voice_type === 'clone') {
        if (!refFile) { toast('Reference audio required', 'error'); return; }
        const consent = JSON.stringify({ consent_given: form.consent_given, rights_holder: form.rights_holder, statement: form.statement });
        await api.createVoiceWithAudio(channelId, { ...Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])), consent_metadata: consent }, refFile);
      } else await api.createVoice(channelId, base);
      toast('Voice profile created'); setForm({ ...form, name: '', design_prompt: '' }); load();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const audition = async (v: VoiceProfile) => { if (!channelId) return; try { const r = await api.ttsPreview(channelId, { voice_profile_id: v.id, text: previewText, style_instruction: previewStyle }); setPreviewAudio({ url: api.ttsAudioUrl(channelId, r.id), note: r.spoken_text_note, mock: r.is_mock, spoken: r.spoken_text }); api.ttsUsage(channelId).then(setUsage); } catch (e: any) { toast(e.message, 'error'); } };
  const saveDict = async () => { if (!channelId) return; const entries = dictEdit.text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [term, reading] = l.split('='); return { term: term.trim(), reading: (reading ?? '').trim(), mode: 'replace' as const, language: 'zh' }; }); try { const d = await api.saveDictionary(channelId, dictEdit.id, { name: dictEdit.name, entries }); setDictEdit({ ...dictEdit, id: d.id }); toast('Dictionary saved (version ' + d.version + ')'); load(); } catch (e: any) { toast(e.message, 'error'); } };
  const runEstimate = async () => { if (!channelId || !selPres) return; try { setEstimate(await api.ttsEstimate(channelId, selPres, { force })); } catch (e: any) { toast(e.message, 'error'); } };
  const startJob = async () => { if (!channelId || !selPres) return; try { const j = await api.ttsCreateJob(channelId, selPres, { force, retry: true }); toast(`Voiceover job queued: ${j.total} line(s)`); setJobs([j, ...jobs]); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <div>
      <div className="card">
        <div className="row"><h3 style={{ margin: 0 }}>{tr("Voice Studio")}</h3>{status && <span className={`pill ${status.mock ? 'danger' : 'ok'}`}>{status.mock ? tr("MOCK TTS — synthetic tones, not speech") : `Qwen · ${status.official_model}`}</span>}{usage && <span className="tiny muted">{tr("budget ")}{usage.used_chars}/{usage.budget_chars}{tr(" chars · ")}{usage.cached_assets}{tr(" cached clips · ")}{usage.cache_hits}{tr(" cache hits · est. cost ")}{Number(usage.estimated_cost).toFixed(3)}</span>}</div>
        {status && <div className="tiny muted" style={{ marginTop: 4 }}>{status.note}{!status.mock && ' · endpoints and model ids are configuration (see docs/TTS_PROVIDER.md).'}</div>}
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>{tr("Character voices")}</h3>
          <table className="simple"><thead><tr><th>{tr("voice")}</th><th>{tr("character")}</th><th>{tr("source")}</th><th>{tr("identity instruction")}</th><th /></tr></thead><tbody>
            {voices.map((v) => (
              <tr key={v.id}><td><b>{v.name}</b><div className="tiny muted">{v.voice_id} · {v.language}{v.dialect ? `/${v.dialect}` : ''}{tr(" · v")}{v.version}</div></td>
                <td><select value={v.character_id ?? ''} onChange={(e) => channelId && api.updateVoice(channelId, v.id, { character_id: e.target.value || null }).then(load)}><option value="">{tr("narrator / unassigned")}</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
                <td><span className="pill">{v.voice_type}</span>{v.voice_type === 'clone' && <div className="tiny muted">{tr("consent: ")}{v.consent_metadata?.rights_holder}</div>}</td>
                <td><input value={v.style_instruction} onChange={(e) => setVoices(voices.map((x) => (x.id === v.id ? { ...x, style_instruction: e.target.value } : x)))} onBlur={(e) => channelId && api.updateVoice(channelId, v.id, { style_instruction: e.target.value }).then(load)} style={{ width: 160 }} /></td>
                <td className="row"><button className="small" onClick={() => audition(v)}>{tr("▶ audition")}</button><button className="ghost small" aria-label={tr("Delete voice")} title={tr("Delete voice")} onClick={() => channelId && confirm(tr('Delete this voice? Lines already voiced with it keep their audio.')) && api.deleteVoice(channelId, v.id).then(load).catch((e) => toast(e.message, 'error'))}>✕</button></td></tr>
            ))}
          </tbody></table>
          <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            <input placeholder={tr("audition text (中英文混合 ok)")} value={previewText} onChange={(e) => setPreviewText(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
            <select value={previewStyle} onChange={(e) => setPreviewStyle(e.target.value)}><option value="">{tr("delivery: none")}</option>{STYLE_PRESETS.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          </div>
          {previewAudio && <div style={{ marginTop: 8 }}><audio controls autoPlay src={previewAudio.url} style={{ width: '100%' }} />{previewAudio.mock && <div className="tiny" style={{ color: 'var(--danger)' }}>{tr("Mock clip — a tone sequence, explicitly not speech.")}</div>}{previewAudio.note && <div className="tiny muted">{previewAudio.note}: “{previewAudio.spoken}”</div>}</div>}
          <h3 style={{ marginTop: 14 }}>{tr("New voice profile")}</h3>
          <div className="col">
            <div className="row"><select value={form.voice_type} onChange={(e) => setForm({ ...form, voice_type: e.target.value })}><option value="preset">{tr("Preset voice")}</option><option value="design">{tr("Voice design (text description)")}</option><option value="clone">{tr("Voice clone (reference audio, consent required)")}</option></select><input placeholder={tr("profile name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><select value={form.character_id} onChange={(e) => setForm({ ...form, character_id: e.target.value })}><option value="">{tr("narrator / unassigned")}</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            {form.voice_type === 'preset' && <select value={form.voice_id} onChange={(e) => setForm({ ...form, voice_id: e.target.value })}><option value="">{tr("choose a preset voice…")}</option>{available.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.language}{v.gender ? ` · ${v.gender}` : ''}</option>)}</select>}
            {form.voice_type === 'design' && <textarea placeholder={tr("e.g. Young adult female, low and clear voice, calm tone, slightly slow pace, restrained emotion")} value={form.design_prompt} onChange={(e) => setForm({ ...form, design_prompt: e.target.value })} />}
            {form.voice_type === 'clone' && (<><input type="file" accept="audio/*" onChange={(e) => setRefFile(e.target.files?.[0] ?? null)} /><input placeholder={tr("rights holder (who owns this voice)")} value={form.rights_holder} onChange={(e) => setForm({ ...form, rights_holder: e.target.value })} /><input placeholder={tr("consent statement (e.g. 'I am the speaker and consent to cloning for this campaign')")} value={form.statement} onChange={(e) => setForm({ ...form, statement: e.target.value })} /><label className="tiny"><input type="checkbox" checked={form.consent_given} onChange={(e) => setForm({ ...form, consent_given: e.target.checked })} />{tr(" I confirm I hold the rights and consent. Cloning other people's voices without authorisation is prohibited.")}</label></>)}
            <div className="row"><select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}><option value="zh">{tr("Mandarin")}</option><option value="en">{tr("English")}</option><option value="auto">{tr("Auto (mixed)")}</option><option value="zh-dialect">{tr("Chinese dialect")}</option></select><input placeholder={tr("dialect (optional)")} value={form.dialect} onChange={(e) => setForm({ ...form, dialect: e.target.value })} /><select value={form.pronunciation_dictionary_id} onChange={(e) => setForm({ ...form, pronunciation_dictionary_id: e.target.value })}><option value="">{tr("no dictionary")}</option>{dicts.map((d) => <option key={d.id} value={d.id}>{d.name}{tr(" v")}{d.version}</option>)}</select></div>
            <input placeholder={tr("voice identity instruction (stable across lines, e.g. 'warm, measured, low register')")} value={form.style_instruction} onChange={(e) => setForm({ ...form, style_instruction: e.target.value })} />
            <button className="primary small" onClick={createVoice} disabled={!form.name}>{tr("Create voice profile")}</button>
          </div>
        </div>
        <div>
          <div className="card">
            <h3>{tr("Pronunciation dictionary")}</h3>
            <div className="tiny muted">{tr("One `term=reading` per line. Applied to the spoken text only; the displayed log never changes. Providers without phoneme APIs use replacement readings.")}</div>
            <div className="row" style={{ marginTop: 6 }}><select value={dictEdit.id ?? ''} onChange={(e) => { const d = dicts.find((x) => x.id === e.target.value); setDictEdit(d ? { id: d.id, name: d.name, text: d.entries.map((x) => `${x.term}=${x.reading}`).join('\n') } : { id: null, name: 'Campaign pronunciations', text: '' }); }}><option value="">{tr("— new dictionary —")}</option>{dicts.map((d) => <option key={d.id} value={d.id}>{d.name}{tr(" (v")}{d.version})</option>)}</select><input value={dictEdit.name} onChange={(e) => setDictEdit({ ...dictEdit, name: e.target.value })} /></div>
            <textarea value={dictEdit.text} onChange={(e) => setDictEdit({ ...dictEdit, text: e.target.value })} style={{ width: '100%', minHeight: 90, marginTop: 6, fontFamily: 'var(--mono)' }} disabled={!isGm} />
            {isGm && <button className="small" onClick={saveDict}>{tr("Save dictionary")}</button>}
          </div>
          <div className="card">
            <h3>{tr("Batch voiceover")}</h3>
            <div className="row" style={{ flexWrap: 'wrap' }}><select value={selPres} onChange={(e) => setSelPres(e.target.value)}><option value="">{tr("choose presentation…")}</option>{presentations.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.voiced_count}/{p.line_count}{tr(" voiced)")}</option>)}</select><label className="tiny"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />{tr(" re-generate even if voiced")}</label><button className="small" onClick={runEstimate} disabled={!selPres}>{tr("Estimate")}</button><button className="primary small" onClick={startJob} disabled={!selPres||!estimate||!estimate.within_budget}>{tr("Synthesize")}</button></div>
            {estimate && <div className="small" style={{ marginTop: 6 }}>{estimate.lines}{tr(" line(s) in scope · ")}{estimate.cached_lines}{tr(" already cached · ")}<b>{estimate.lines_to_synthesize}</b>{tr(" to synthesize (")}{estimate.chars}{tr(" chars, est. ")}{estimate.cost_known ? Number(estimate.estimated_cost).toFixed(4) : tr("unknown — check provider pricing")}) · {estimate.within_budget ? <span className="pill ok">{tr("within budget")}</span> : <span className="pill danger">{tr("exceeds budget")}</span>}<div className="tiny muted">{tr("Identical text+voice+instruction reuses cached audio; replays never call the provider.")}</div></div>}
            <table className="simple" style={{ marginTop: 8 }}><thead><tr><th>{tr("job")}</th><th>{tr("status")}</th><th>{tr("progress")}</th><th>{tr("errors")}</th><th /></tr></thead><tbody>
              {jobs.map((j) => <tr key={j.id}><td className="tiny muted">{new Date(j.created_at).toLocaleTimeString(currentLocale())} · {j.provider}</td><td><span className={`pill ${j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'danger' : j.status === 'running' ? 'ai' : ''}`}>{tr(j.status)}</span></td><td className="small">{j.done}/{j.total} · {j.cached}{tr(" cached · ")}{j.failed}{tr(" failed")}<div style={{ height: 4, background: 'var(--bg-4)', borderRadius: 2 }}><div style={{ width: `${(100 * (j.done + j.failed)) / Math.max(1, j.total)}%`, height: 4, background: 'var(--accent-2)', borderRadius: 2 }} /></div></td><td className="tiny" style={{ color: 'var(--danger)' }}>{(j.result?.errors ?? []).slice(0, 2).map((e: any) => e.error).join('; ')}{j.error}</td><td>{(j.status === 'pending' || j.status === 'running') && <button className="ghost small" onClick={() => channelId && api.ttsCancel(channelId, j.id).then(() => api.ttsJobs(channelId, selPres).then(setJobs))}>{tr("cancel")}</button>}</td></tr>)}
            </tbody></table>
          </div>
        </div>
      </div>
    </div>
  );
}
