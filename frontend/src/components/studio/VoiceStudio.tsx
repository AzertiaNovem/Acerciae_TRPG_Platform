import { t as tr, currentLocale } from '../../i18n';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useNav } from '../../store/nav';
import { useStudio } from '../../store/studio';
import { useUi } from '../../store/ui';
import { contextSocket } from '../../api/ws';
import type { VoiceProfile, PronunciationDictionary, TtsJob, Presentation } from '../../types';
import { NO_FEATURES, SERVICE_NAMES, formatDictionary, paramValues, parseDictionary, type TtsFeatures } from './voiceFeatures';

const STYLE_PRESETS = ['calm narration', 'whispering', 'surprised', 'angry', 'hesitant', 'afraid', 'sad', 'cold', 'slow and cautious'];

// Maintain character voices, audition them, manage pronunciation, batch-synthesize with cost control. The controls
// follow the configured speech service (status.features): every service gives each character its own voice; language,
// dialect or accent, instructions, voice parameters, models, voice design/cloning and phonetic readings appear only
// where the service's API takes them.
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
  const [form, setForm] = useState<any>({ voice_type: 'preset', name: '', character_id: '', voice_id: '', language: 'zh', dialect: '', model_id: '', params: {}, style_instruction: '', design_prompt: '', pronunciation_dictionary_id: '', consent_given: false, rights_holder: '', statement: '' });
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

  const features: TtsFeatures = status?.features ?? NO_FEATURES;
  const service = features.label || status?.provider || '';
  const createVoice = async () => {
    if (!channelId) return;
    try {
      const base: Record<string, any> = { voice_type: form.voice_type, name: form.name, character_id: form.character_id || undefined, voice_id: form.voice_id, pronunciation_dictionary_id: form.pronunciation_dictionary_id || undefined, design_prompt: form.design_prompt,
        language: features.languages.length ? form.language : 'auto', dialect: features.dialect ? form.dialect : '', style_instruction: features.instructions ? form.style_instruction : '',
        model_id: features.models.length && form.model_id ? form.model_id : undefined, synthesis_parameters: features.params.length ? paramValues(features, form.params) : undefined };
      if (form.voice_type === 'clone') {
        if (!refFile) { toast('Reference audio required', 'error'); return; }
        const consent = JSON.stringify({ consent_given: form.consent_given, rights_holder: form.rights_holder, statement: form.statement });
        await api.createVoiceWithAudio(channelId, { ...Object.fromEntries(Object.entries(base).filter(([k, v]) => v !== undefined && k !== 'synthesis_parameters').map(([k, v]) => [k, String(v)])), consent_metadata: consent }, refFile);
      } else await api.createVoice(channelId, base);
      toast('Voice profile created'); setForm({ ...form, name: '', design_prompt: '' }); load();
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const saveVoice = (v: VoiceProfile, patch: Partial<VoiceProfile>) => channelId && api.updateVoice(channelId, v.id, patch).then(load).catch((e) => toast(e.message, 'error'));
  const audition = async (v: VoiceProfile) => { if (!channelId) return; try { const r = await api.ttsPreview(channelId, { voice_profile_id: v.id, text: previewText, style_instruction: features.instructions ? previewStyle : '' }); setPreviewAudio({ url: api.ttsAudioUrl(channelId, r.id), note: r.spoken_text_note, mock: r.is_mock, spoken: r.spoken_text }); api.ttsUsage(channelId).then(setUsage); } catch (e: any) { toast(e.message, 'error'); } };
  const saveDict = async () => { if (!channelId) return; const entries = parseDictionary(dictEdit.text, features.phoneme_dictionary); try { const d = await api.saveDictionary(channelId, dictEdit.id, { name: dictEdit.name, entries }); setDictEdit({ ...dictEdit, id: d.id }); toast('Dictionary saved (version ' + d.version + ')'); load(); } catch (e: any) { toast(e.message, 'error'); } };
  const runEstimate = async () => { if (!channelId || !selPres) return; try { setEstimate(await api.ttsEstimate(channelId, selPres, { force })); } catch (e: any) { toast(e.message, 'error'); } };
  const startJob = async () => { if (!channelId || !selPres) return; try { const j = await api.ttsCreateJob(channelId, selPres, { force, retry: true }); toast(`Voiceover job queued: ${j.total} line(s)`); setJobs([j, ...jobs]); } catch (e: any) { toast(e.message, 'error'); } };
  // The provider-specific controls of one voice (or of the new-voice form): only what the service accepts.
  const serviceFields = (val: { language: string; dialect: string; model_id?: string; params: Record<string, number> }, set: (patch: Record<string, any>) => void, commitText = false) => (
    <>
      {(features.languages.length > 0 || features.dialect || features.models.length > 0) && <div className="row" style={{ flexWrap: 'wrap' }}>
        {features.languages.length > 0 && <label className="field"><span>{tr('Language')}</span><select value={val.language} title={features.language_note ? tr(features.language_note) : undefined} onChange={(e) => set({ language: e.target.value })}>{features.languages.map((l) => <option key={l.id} value={l.id}>{tr(l.label)}</option>)}</select></label>}
        {features.dialect && <label className="field"><span>{tr(features.dialect.label)}</span><input defaultValue={val.dialect} placeholder={tr(features.dialect.placeholder)} onChange={(e) => !commitText && set({ dialect: e.target.value })} onBlur={(e) => commitText && e.target.value !== val.dialect && set({ dialect: e.target.value })} /></label>}
        {features.models.length > 0 && <label className="field"><span>{tr('Model')}</span><select value={val.model_id || features.models[0]} onChange={(e) => set({ model_id: e.target.value })}>{features.models.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>}
      </div>}
      {features.params.length > 0 && <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
        {features.params.map((p) => <label key={p.key} className="tiny voice-param"><span>{tr(p.label)} <b>{val.params[p.key]}</b></span><input type="range" min={p.min} max={p.max} step={p.step} value={val.params[p.key]} onChange={(e) => set({ params: { ...val.params, [p.key]: Number(e.target.value) } })} /></label>)}
      </div>}
    </>
  );
  return (
    <div>
      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap' }}><h3 style={{ margin: 0 }}>{tr("Voice Studio")}</h3>{status && <span className={`pill ${status.mock ? 'danger' : 'ok'}`}>{status.mock ? tr("MOCK TTS — synthetic tones, not speech") : `${service} · ${status.official_model}`}</span>}{usage && <span className="tiny muted">{tr("budget ")}{usage.used_chars}/{usage.budget_chars}{tr(" chars · ")}{usage.cached_assets}{tr(" cached clips · ")}{usage.cache_hits}{tr(" cache hits · est. cost ")}{Number(usage.estimated_cost).toFixed(3)}</span>}</div>
        {status && !status.mock && features.highlights.length > 0 && <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 6 }}><span className="tiny muted">{tr('With {service}:', { service })}</span>{features.highlights.map((h) => <span key={h} className="pill">{tr(h)}</span>)}</div>}
        {status?.mock && <div className="tiny muted" style={{ marginTop: 4 }}>{status.note}</div>}
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>{tr("Character voices")}</h3>
          <div className="tiny muted">{tr("Give every character (and the narrator) a voice of their own; lines are voiced with their speaker's voice.")}</div>
          <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            <input placeholder={tr("audition text (中英文混合 ok)")} value={previewText} onChange={(e) => setPreviewText(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
            {features.instructions && <select value={previewStyle} onChange={(e) => setPreviewStyle(e.target.value)} title={features.instruction_note ? tr(features.instruction_note) : undefined}><option value="">{tr("delivery: none")}</option>{STYLE_PRESETS.map((s) => <option key={s} value={s}>{s}</option>)}</select>}
          </div>
          {previewAudio && <div style={{ marginTop: 8 }}><audio controls autoPlay src={previewAudio.url} style={{ width: '100%' }} />{previewAudio.mock && <div className="tiny" style={{ color: 'var(--danger)' }}>{tr("Mock clip — a tone sequence, explicitly not speech.")}</div>}{previewAudio.note && <div className="tiny muted">{previewAudio.note}: “{previewAudio.spoken}”</div>}</div>}
          {voices.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>{tr("No voices yet.")}</div>}
          {voices.map((v) => {
            const foreign = !!status && v.provider !== status.provider;
            const val = { language: v.language, dialect: v.dialect, model_id: v.model_id, params: paramValues(features, v.synthesis_parameters) };
            return (
              <div key={v.id} className={`voice-card ${foreign ? 'foreign' : ''}`}>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <b className="grow">{v.name}</b>
                  <select value={v.character_id ?? ''} onChange={(e) => saveVoice(v, { character_id: e.target.value || null })}><option value="">{tr("narrator / unassigned")}</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                  <span className="pill">{tr(v.voice_type)}</span>
                  <button className="small" onClick={() => audition(v)} disabled={foreign}>{tr("▶ audition")}</button>
                  <button className="ghost small" aria-label={tr("Delete voice")} title={tr("Delete voice")} onClick={() => channelId && confirm(tr('Delete this voice? Lines already voiced with it keep their audio.')) && api.deleteVoice(channelId, v.id).then(load).catch((e) => toast(e.message, 'error'))}>✕</button>
                </div>
                <div className="tiny muted">{v.voice_id} · v{v.version}{v.voice_type === 'clone' && <> · {tr("consent: ")}{v.consent_metadata?.rights_holder}</>}{v.cached_lines ? <> · {v.cached_lines} {tr("cached")}</> : null}</div>
                {foreign ? <div className="tiny" style={{ color: 'var(--danger)' }}>{tr("Made for {old}; the server now uses {current}. Create a new voice for this character.", { old: SERVICE_NAMES[v.provider] ?? v.provider, current: service })}</div> : (
                  <details>
                    <summary className="tiny">{tr("Voice settings")}</summary>
                    <div className="col" style={{ gap: 6, marginTop: 6 }}>
                      {v.voice_type === 'preset' && <label className="field"><span>{tr("Voice")}</span><select value={v.voice_id} onChange={(e) => saveVoice(v, { voice_id: e.target.value })}>{!available.some((a) => a.id === v.voice_id) && <option value={v.voice_id}>{v.voice_id}</option>}{available.map((a) => <option key={a.id} value={a.id}>{a.name}{a.gender ? ` · ${a.gender}` : ''}</option>)}</select></label>}
                      {serviceFields(val, (p) => saveVoice(v, p.params ? { synthesis_parameters: p.params } : p), true)}
                      {features.instructions && <label className="field"><span>{tr("identity instruction")}</span><input defaultValue={v.style_instruction} title={features.instruction_note ? tr(features.instruction_note) : undefined} onBlur={(e) => e.target.value !== v.style_instruction && saveVoice(v, { style_instruction: e.target.value })} /></label>}
                      <label className="field"><span>{tr("Pronunciation dictionary")}</span><select value={v.pronunciation_dictionary_id ?? ''} onChange={(e) => saveVoice(v, { pronunciation_dictionary_id: e.target.value || null } as any)}><option value="">{tr("no dictionary")}</option>{dicts.map((d) => <option key={d.id} value={d.id}>{d.name}{tr(" v")}{d.version}</option>)}</select></label>
                    </div>
                  </details>
                )}
              </div>
            );
          })}
          <h3 style={{ marginTop: 14 }}>{tr("New voice profile")}</h3>
          <div className="col">
            <div className="row" style={{ flexWrap: 'wrap' }}><select value={form.voice_type} onChange={(e) => setForm({ ...form, voice_type: e.target.value })}><option value="preset">{tr("Preset voice")}</option>{features.voice_design && <option value="design">{tr("Voice design (text description)")}</option>}{features.voice_clone && <option value="clone">{tr("Voice clone (reference audio, consent required)")}</option>}</select><input placeholder={tr("profile name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><select value={form.character_id} onChange={(e) => setForm({ ...form, character_id: e.target.value })}><option value="">{tr("narrator / unassigned")}</option>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            {form.voice_type === 'preset' && <select value={form.voice_id} onChange={(e) => setForm({ ...form, voice_id: e.target.value })}><option value="">{tr("choose a preset voice…")}</option>{available.map((v) => <option key={v.id} value={v.id}>{v.name}{v.language && v.language !== 'multi' ? ` · ${v.language}` : ''}{v.gender ? ` · ${v.gender}` : ''}</option>)}</select>}
            {form.voice_type === 'design' && <textarea placeholder={tr("e.g. Young adult female, low and clear voice, calm tone, slightly slow pace, restrained emotion")} value={form.design_prompt} onChange={(e) => setForm({ ...form, design_prompt: e.target.value })} />}
            {form.voice_type === 'clone' && (<><input type="file" accept="audio/*" onChange={(e) => setRefFile(e.target.files?.[0] ?? null)} /><input placeholder={tr("rights holder (who owns this voice)")} value={form.rights_holder} onChange={(e) => setForm({ ...form, rights_holder: e.target.value })} /><input placeholder={tr("consent statement (e.g. 'I am the speaker and consent to cloning for this campaign')")} value={form.statement} onChange={(e) => setForm({ ...form, statement: e.target.value })} /><label className="tiny"><input type="checkbox" checked={form.consent_given} onChange={(e) => setForm({ ...form, consent_given: e.target.checked })} />{tr(" I confirm I hold the rights and consent. Cloning other people's voices without authorisation is prohibited.")}</label></>)}
            {serviceFields({ language: features.languages.some((l) => l.id === form.language) ? form.language : features.languages[0]?.id ?? 'auto', dialect: form.dialect, model_id: form.model_id, params: paramValues(features, form.params) }, (p) => setForm({ ...form, ...p }))}
            {features.instructions && <input placeholder={tr("voice identity instruction (stable across lines, e.g. 'warm, measured, low register')")} title={features.instruction_note ? tr(features.instruction_note) : undefined} value={form.style_instruction} onChange={(e) => setForm({ ...form, style_instruction: e.target.value })} />}
            <select value={form.pronunciation_dictionary_id} onChange={(e) => setForm({ ...form, pronunciation_dictionary_id: e.target.value })}><option value="">{tr("no dictionary")}</option>{dicts.map((d) => <option key={d.id} value={d.id}>{d.name}{tr(" v")}{d.version}</option>)}</select>
            <button className="primary small" onClick={createVoice} disabled={!form.name || (form.voice_type === 'preset' && !form.voice_id)}>{tr("Create voice profile")}</button>
          </div>
        </div>
        <div>
          <div className="card">
            <h3>{tr("Pronunciation dictionary")}</h3>
            <div className="tiny muted">{tr("One `term=reading` per line, applied to the spoken text only; the displayed log never changes.")} {features.phoneme_dictionary ? tr("{service} also takes phonetic readings: write `term=[pin1 yin1]`.", { service }) : tr("{service} has no phonetic input, so each reading replaces the word.", { service })}</div>
            <div className="row" style={{ marginTop: 6 }}><select value={dictEdit.id ?? ''} onChange={(e) => { const d = dicts.find((x) => x.id === e.target.value); setDictEdit(d ? { id: d.id, name: d.name, text: formatDictionary(d.entries) } : { id: null, name: 'Campaign pronunciations', text: '' }); }}><option value="">{tr("— new dictionary —")}</option>{dicts.map((d) => <option key={d.id} value={d.id}>{d.name}{tr(" (v")}{d.version})</option>)}</select><input value={dictEdit.name} onChange={(e) => setDictEdit({ ...dictEdit, name: e.target.value })} /></div>
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
