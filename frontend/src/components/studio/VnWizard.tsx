import { t as tr } from '../../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { contextSocket } from '../../api/ws';
import { useNav } from '../../store/nav';
import { useUi } from '../../store/ui';
import type { Presentation, TtsJob, VnScriptJob, VoiceProfile } from '../../types';
import VNPlayer from './vn/VNPlayer';
import { VN_BASE_INFO, VN_BASES, type VnBase } from './vn/templates';

type Step = 'script' | 'art' | 'cast' | 'export';
const STEPS: { id: Step; label: string }[] = [{ id: 'script', label: 'Script' }, { id: 'art', label: 'Art' }, { id: 'cast', label: 'Dubbing cast' }, { id: 'export', label: 'Export' }];
type Scope = 'gm_full' | 'pl_public' | 'character';

// Visual novel in four steps, open to every member: the AI reads the campaign log (in the reader's own scope)
// and writes the script, the image AI paints missing backgrounds and portraits, the reader casts a voice for
// every character and the narration, then downloads a standalone zip. The advanced editor stays one click away.
export default function VnWizard({ onOpenEditor }: { onOpenEditor: (presentationId: string) => void }) {
  const { channelId, channel, characters } = useNav();
  const toast = useUi((s) => s.toast);
  const isGm = channel?.my_role === 'gm';
  const myCharacters = channel?.my_character_ids ?? [];
  const [status, setStatus] = useState<{ mock: boolean; model: string; cloud_allowed: boolean; images: boolean; note: string } | null>(null);
  const [jobs, setJobs] = useState<VnScriptJob[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<VnScriptJob | null>(null);
  const [pres, setPres] = useState<Presentation | null>(null);
  const [step, setStep] = useState<Step>('script');
  // Script step
  // A player reads what their character witnessed; in an isolated channel few lines are public to everyone.
  const [scope, setScope] = useState<Scope>(isGm ? 'gm_full' : myCharacters.length ? 'character' : 'pl_public');
  const [scopeChar, setScopeChar] = useState(myCharacters[0] ?? '');
  const [title, setTitle] = useState('');
  const [base, setBase] = useState<VnBase>('adv');
  const [direction, setDirection] = useState('');
  const [cloudOk, setCloudOk] = useState(false);
  const [busy, setBusy] = useState(false);
  // Cast step
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [presets, setPresets] = useState<{ id: string; name: string; language: string; gender: string }[]>([]);
  const [cast, setCastState] = useState<Record<string, string>>({});
  // The cast the author is choosing stays theirs: polls refresh it from the server only until they touch it.
  const castTouched = useRef<string | null>(null);
  const setCast = (next: Record<string, string> | ((c: Record<string, string>) => Record<string, string>)) => { castTouched.current = pres?.id ?? null; setCastState(next); };
  const [tts, setTts] = useState<TtsJob | null>(null);
  const [index, setIndex] = useState(0);

  const loadJobs = () => { if (channelId) api.vnScripts(channelId).then(setJobs).catch(() => undefined); };
  const loadJob = async (id: string) => {
    if (!channelId) return;
    const j = await api.vnScript(channelId, id); setJob(j);
    if (j.presentation_id) { const p = await api.presentation(channelId, j.presentation_id); setPres(p); if (castTouched.current !== p.id) setCastState((p.settings?.cast as Record<string, string>) ?? {}); }
  };
  useEffect(() => { if (!channelId) return; api.vnScriptStatus(channelId).then(setStatus).catch(() => undefined); loadJobs(); }, [channelId]);
  useEffect(() => { if (jobId) loadJob(jobId).catch((e) => toast(e.message, 'error')); else { setJob(null); setPres(null); } }, [jobId, channelId]);
  useEffect(() => contextSocket.on((m) => {
    if (m.type === 'studio.vnscript.progress') { loadJobs(); if (jobId && m.payload?.job_id === jobId) loadJob(jobId).catch(() => undefined); }
    if ((m.type === 'asset.generated' || m.type === 'module.updated') && jobId && pres && (m.payload?.presentation_id === pres.id)) loadJob(jobId).catch(() => undefined);
  }), [channelId, jobId, pres?.id]);
  // Polling covers reconnects while the script or the art is still on its way.
  const running = jobs.some((j) => j.status === 'pending' || j.status === 'running');
  const artPending = !!pres && ((pres.scenes ?? []).some((s) => !s.background_asset_id) || (pres.events ?? []).some((e) => (e.character_asset_ids ?? []).some((p) => !p.asset_id)));
  useEffect(() => { if (!running && !(step === 'art' && artPending)) return; const t = setInterval(() => { loadJobs(); if (jobId) loadJob(jobId).catch(() => undefined); }, 2500); return () => clearInterval(t); }, [running, step, artPending, jobId]);
  useEffect(() => { if (step !== 'cast' || !channelId) return; Promise.all([api.voices(channelId), api.ttsAvailableVoices(channelId)]).then(([v, a]) => { setVoices(v); setPresets(a); }).catch(() => undefined); }, [step, channelId]);
  useEffect(() => { if (!tts || !channelId || tts.status === 'completed' || tts.status === 'failed' || tts.status === 'cancelled') return; const t = setInterval(async () => { const s = await api.ttsJob(channelId, tts.id).catch(() => null); if (s) { setTts(s); if (s.status === 'completed' && jobId) loadJob(jobId); } }, 1500); return () => clearInterval(t); }, [tts?.id, tts?.status]);

  // Who speaks in this draft: the characters on its lines, plus the narration.
  const speakers = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of pres?.events ?? []) if (!e.hidden && e.speaker_character_id && (e.display_kind === 'dialogue' || e.display_kind === 'action')) m.set(e.speaker_character_id, e.character_name ?? e.speaker_display_name);
    return [...m.entries()];
  }, [pres]);
  const names = useMemo(() => Object.fromEntries(speakers), [speakers]);
  const visible = (pres?.events ?? []).filter((e) => !e.hidden);

  const generate = async () => {
    if (!channelId) return;
    setBusy(true);
    try {
      const j = await api.createVnScript(channelId, { scope, scope_character_id: scope === 'character' ? scopeChar : undefined, title: title.trim() || undefined, template: { base }, instructions: direction.trim() || undefined, allow_cloud: status?.mock ? undefined : cloudOk });
      toast(tr('Script job started'), 'ai'); setJobId(j.id); loadJobs();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const quickVoice = async (key: string, presetId: string) => {
    if (!channelId || !presetId) return;
    try {
      const preset = presets.find((p) => p.id === presetId);
      // A voice is bound to a character only by its actor or the Keeper; anyone else's voice for it stays unbound
      // and the cast alone assigns it, so it never changes how that character sounds elsewhere.
      const bind = key !== 'narrator' && (isGm || myCharacters.includes(key));
      const v = await api.createVoice(channelId, { name: key === 'narrator' ? tr('Narrator') : names[key] ?? preset?.name, character_id: bind ? key : undefined, voice_type: 'preset', voice_id: presetId });
      setVoices((vs) => [...vs, v]); setCast((c) => ({ ...c, [key]: v.id }));
    } catch (e: any) { toast(e.message, 'error'); }
  };
  const applyCastAndVoice = async () => {
    if (!channelId || !pres) return;
    setBusy(true);
    try {
      const p = await api.applyCast(channelId, pres.id, cast); setPres(p);
      setTts(await api.ttsCreateJob(channelId, pres.id, {}));
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const voicesFor = (key: string) => voices.filter((v) => (key === 'narrator' ? !v.character_id : !v.character_id || v.character_id === key));
  const needsCloud = status && !status.mock;
  const blocked = !!needsCloud && (!status!.cloud_allowed || !cloudOk);
  const done = job?.status === 'completed' && !!pres;
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const gen = job?.script?.generation;

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="row"><h3 style={{ margin: 0 }}>{tr('Make a visual novel')}</h3><span className="grow" />{status && (status.mock ? <span className="pill">MOCK</span> : <span className="pill ai">{status.model}</span>)}</div>
      <ol className="wizard-steps">
        {STEPS.map((s, i) => <li key={s.id} className={`${s.id === step ? 'current' : ''} ${i < stepIndex ? 'done' : ''}`}><button className="ghost small" disabled={i > 0 && !done} onClick={() => setStep(s.id)}>{i + 1}. {tr(s.label)}</button></li>)}
      </ol>

      {step === 'script' && (
        <div>
          <div className="tiny muted">{tr('The AI reads the campaign log block by block (a block ends after an hour without lines) and writes the script: which background each line plays on and which portrait each speaker shows. It never rewrites or adds lines.')}</div>
          <div className="vn-tpl-fields tiny">
            <label>{tr('Lines to read')}<select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              {isGm && <option value="gm_full">{tr('Everything, including private windows (GM only result)')}</option>}
              <option value="pl_public">{tr('Lines every player can read')}</option>
              <option value="character" disabled={!isGm && myCharacters.length === 0}>{tr("One character's point of view")}</option>
            </select></label>
            {scope === 'character' && <label>{tr('Character')}<select value={scopeChar} onChange={(e) => setScopeChar(e.target.value)}>{(isGm ? characters : characters.filter((c) => myCharacters.includes(c.id))).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
            <label>{tr('Title')}<input value={title} maxLength={200} placeholder={tr('Visual novel')} onChange={(e) => setTitle(e.target.value)} /></label>
            <label>{tr('Look template')}<select value={base} onChange={(e) => setBase(e.target.value as VnBase)}>{VN_BASES.map((b) => <option key={b} value={b}>{tr(VN_BASE_INFO[b].label)}</option>)}</select></label>
          </div>
          <label className="tiny" style={{ display: 'block', marginTop: 6 }}>{tr('Direction for the AI (optional)')}<textarea value={direction} maxLength={1000} onChange={(e) => setDirection(e.target.value)} placeholder={tr('e.g. Keep the investigation scenes tense; skip rules discussion.')} style={{ minHeight: 44, display: 'block', width: '100%', marginTop: 2 }} /></label>
          {needsCloud && (status!.cloud_allowed
            ? <label className="tiny" style={{ display: 'block', marginTop: 6 }}><input type="checkbox" checked={cloudOk} onChange={(e) => setCloudOk(e.target.checked)} /> {tr('Send these lines to the configured model')}</label>
            : <div className="tiny" style={{ marginTop: 6, color: 'var(--warn)' }}>{tr('Cloud processing is off for this campaign. Enable it in Library settings, or use the mock planner.')}</div>)}
          <div className="row" style={{ marginTop: 8 }}><button className="primary" onClick={generate} disabled={busy || blocked || (scope === 'character' && !scopeChar)}>{busy ? tr('Starting the script job…') : tr('Write the script')}</button></div>
          {jobs.length > 0 && (
            <table className="simple" style={{ marginTop: 10 }}><tbody>
              {jobs.map((j) => (
                <tr key={j.id} className={j.id === jobId ? 'selected' : ''}>
                  <td>
                    <b>{j.title}</b> <span className={`pill ${j.status === 'failed' ? 'danger' : j.status === 'completed' ? 'ok' : ''}`}>{tr(j.status)}</span>
                    <div className="tiny muted">{j.snapshot_scope}{j.stats ? ` · ${tr('{n} scenes', { n: j.stats.scenes })} · ${tr('{n} lines shown', { n: j.stats.shown })}` : ''}{j.status === 'running' && j.progress?.chunks_total ? ` · ${tr('part {a} of {b}', { a: j.progress.chunks_done ?? 0, b: j.progress.chunks_total })}` : ''}</div>
                    {j.error && <div className="tiny" style={{ color: 'var(--danger)' }}>{j.error}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {j.status === 'completed' && <button className="small primary" onClick={() => { setJobId(j.id); setStep('art'); }}>{tr('continue')}</button>}
                    {(j.status === 'pending' || j.status === 'running') && <button className="small ghost" onClick={async () => { await api.cancelVnScript(channelId!, j.id).catch(() => undefined); loadJobs(); }}>{tr('cancel')}</button>}
                  </td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
      )}

      {step === 'art' && pres && (
        <div>
          <div className="tiny muted">{gen?.enabled === false ? tr('Image generation is off on this server: upload backgrounds in Assets and portraits in each character space, then assign them in the editor.') : tr('Backgrounds the log needs and portraits for characters in generated mode are being painted. Characters in uploaded mode use only the portraits their players uploaded.')}</div>
          <div className="wizard-art">
            {(pres.scenes ?? []).map((s) => (
              <div key={s.id} className="wizard-tile">
                {s.background_asset_id ? <img src={api.mediaUrl(channelId!, s.background_asset_id, s.background_asset_version)} alt="" /> : <div className="placeholder">{tr('painting…')}</div>}
                <div className="tiny"><b>{s.title}</b></div>
              </div>
            ))}
          </div>
          {(gen?.portraits?.length ?? 0) > 0 && <div className="tiny" style={{ marginTop: 6 }}><b>{tr('Portraits requested')}</b>: {gen!.portraits.map((p) => `${names[p.character_id] ?? '?'} · ${p.subtitle}`).join(', ')}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <span className="tiny muted">{artPending ? tr('Some art is still missing; you can continue and it will appear when ready.') : tr('All art is in place.')}</span><span className="grow" />
            <button className="ghost small" onClick={() => onOpenEditor(pres.id)}>{tr('Advanced editor')}</button>
            <button className="primary small" onClick={() => setStep('cast')}>{tr('Next: dubbing cast')}</button>
          </div>
        </div>
      )}

      {step === 'cast' && pres && (
        <div>
          <div className="tiny muted">{tr('Choose a voice for every character and for the narration (Keeper narration, dice and scene titles). Pick an existing voice or a preset to create one.')}</div>
          <table className="simple" style={{ marginTop: 6 }}><tbody>
            {[['narrator', tr('Narrator')] as [string, string], ...speakers].map(([key, name]) => (
              <tr key={key}>
                <td><b>{name}</b></td>
                <td>
                  <select value={cast[key] ?? ''} onChange={(e) => setCast({ ...cast, [key]: e.target.value })}>
                    <option value="">{tr('— no voice —')}</option>
                    {voicesFor(key).map((v) => <option key={v.id} value={v.id}>{v.name}{v.character_name ? ` (${v.character_name})` : ''}</option>)}
                  </select>
                </td>
                <td>
                  <select value="" onChange={(e) => quickVoice(key, e.target.value)}>
                    <option value="">{tr('+ new voice from a preset…')}</option>
                    {presets.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.language} · {p.gender}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody></table>
          <div className="row" style={{ marginTop: 8 }}>
            {tts && <span className="tiny">{tr('Voiceover')}: {tr(tts.status)} · {tts.done}/{tts.total}{tts.failed ? ` · ${tr('{n} failed', { n: tts.failed })}` : ''}</span>}
            <span className="grow" />
            <button className="small" onClick={applyCastAndVoice} disabled={busy || !pres.can_edit || Object.values(cast).every((v) => !v)}>{busy ? tr('Working…') : tr('Apply cast and voice every line')}</button>
            <button className="primary small" onClick={() => setStep('export')}>{tr('Next: export')}</button>
          </div>
          {!pres.can_edit && <div className="tiny muted">{tr('Only the author of this draft or the Keeper can change its cast.')}</div>}
        </div>
      )}

      {step === 'export' && pres && (
        <div>
          {visible.length > 0 && <VNPlayer channelId={channelId!} presentation={pres} index={Math.min(index, visible.length - 1)} onIndexChange={setIndex} editorMode characterNames={names} />}
          <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            <span className="tiny muted">{tr('{n} lines', { n: visible.length })} · {tr('{n} voiced', { n: visible.filter((e) => e.audio_asset_id).length })}</span>
            <span className="grow" />
            <button className="ghost small" onClick={() => onOpenEditor(pres.id)}>{tr('Advanced editor')}</button>
            <a className="button primary small" href={api.bundleUrl(channelId!, pres.id)}>{tr('Download the visual novel (zip)')}</a>
          </div>
          <div className="tiny muted" style={{ marginTop: 4 }}>{tr('The zip holds index.html with every image and voice line; open it in any browser, no server needed.')}</div>
        </div>
      )}
    </div>
  );
}
