import { t as tr } from '../../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import BundleDownload from './BundleDownload';
import { contextSocket } from '../../api/ws';
import { useNav } from '../../store/nav';
import { useUi } from '../../store/ui';
import type { Presentation, TtsJob, VnScriptJob, VnScriptQuestions, VnScriptWindows, VoiceProfile } from '../../types';
import VNPlayer from './vn/VNPlayer';
import { VN_BASE_INFO, VN_BASES, type VnBase } from './vn/templates';
import { CachedImg } from '../CachedImg';

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
  // The chat windows to tell: every window with lines in the point of view, except those the author leaves out.
  const [windowReport, setWindowReport] = useState<VnScriptWindows | null>(null);
  const [omitted, setOmitted] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [base, setBase] = useState<VnBase>('adv');
  const [direction, setDirection] = useState('');
  const [cloudOk, setCloudOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryFailedChunks, setRetryFailedChunks] = useState(true);
  const [imageStatus, setImageStatus] = useState<{ enabled: boolean; mock: boolean } | null>(null);
  const [artCloudOk, setArtCloudOk] = useState(false);
  // Cast step
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [presets, setPresets] = useState<{ id: string; name: string; language: string; gender: string }[]>([]);
  const [cast, setCastState] = useState<Record<string, string>>({});
  // The cast the author is choosing stays theirs: polls refresh it from the server only until they touch it.
  const castTouched = useRef<string | null>(null);
  const setCast = (next: Record<string, string> | ((c: Record<string, string>) => Record<string, string>)) => { castTouched.current = pres?.id ?? null; setCastState(next); };
  const [tts, setTts] = useState<TtsJob | null>(null);
  // Continuing a finished visual novel as the story goes on: the presentation whose ending the next job picks up.
  const [continueFor, setContinueFor] = useState<string | null>(null);
  const [waitingJobs, setWaitingJobs] = useState<Record<string, VnScriptJob>>({});   // the questions of jobs waiting for answers
  const [index, setIndex] = useState(0);

  const loadJobs = () => { if (channelId) api.vnScripts(channelId).then(setJobs).catch(() => undefined); };
  const loadJob = async (id: string) => {
    if (!channelId) return;
    const j = await api.vnScript(channelId, id); setJob(j);
    if (j.presentation_id) { const p = await api.presentation(channelId, j.presentation_id); setPres(p); if (castTouched.current !== p.id) setCastState((p.settings?.cast as Record<string, string>) ?? {}); }
  };
  useEffect(() => {
    if (!channelId || (scope === 'character' && !scopeChar)) { setWindowReport(null); return; }
    let live = true;
    api.vnScriptWindows(channelId, scope, scope === 'character' ? scopeChar : undefined).then((r) => { if (live) setWindowReport(r); }).catch(() => { if (live) setWindowReport(null); });
    return () => { live = false; };
  }, [channelId, scope, scopeChar]);
  const tellable = (windowReport?.windows ?? []).filter((w) => w.line_count > 0);
  const told = tellable.filter((w) => !omitted.has(w.id));
  // Without anything left out, no list is sent: the visual novel tells every window, later ones too when continued.
  const windowChoice = windowReport && told.length < tellable.length ? told.map((w) => w.id) : undefined;
  const noWindow = !!windowReport && tellable.length > 0 && told.length === 0;
  const toggleWindow = (id: string, on: boolean) => setOmitted((o) => { const n = new Set(o); if (on) n.delete(id); else n.add(id); return n; });
  const windowName = (id: string) => windowReport?.windows.find((w) => w.id === id)?.name;
  useEffect(() => { if (!channelId) return; api.vnScriptStatus(channelId).then((s) => { setStatus(s); setRetryFailedChunks(s.retry_failed_chunks ?? true); }).catch(() => undefined); loadJobs(); }, [channelId]);
  useEffect(() => { if (jobId) loadJob(jobId).catch((e) => toast(e.message, 'error')); else { setJob(null); setPres(null); } }, [jobId, channelId]);
  useEffect(() => contextSocket.on((m) => {
    if (m.type === 'studio.vnscript.progress') { loadJobs(); if (jobId && m.payload?.job_id === jobId) loadJob(jobId).catch(() => undefined); }
    if ((m.type === 'asset.generated' || m.type === 'module.updated') && jobId && pres && (m.payload?.presentation_id === pres.id)) loadJob(jobId).catch(() => undefined);
  }), [channelId, jobId, pres?.id]);
  useEffect(() => {
    setArtCloudOk(false); setImageStatus(null);
    if (step === 'art' && channelId) api.vnImageStatus(channelId).then(setImageStatus).catch((e) => toast(e.message, 'error'));
  }, [channelId, jobId, step]);
  // Polling covers reconnects while the script or the art is still on its way.
  const running = jobs.some((j) => j.status === 'pending' || j.status === 'running');
  // A job that waits for answers carries its questions in its own record, not in the list.
  useEffect(() => {
    if (!channelId) return;
    const waiting = jobs.filter((j) => j.status === 'waiting');
    setWaitingJobs((w) => Object.fromEntries(Object.entries(w).filter(([id]) => waiting.some((j) => j.id === id))));
    for (const j of waiting) if (!waitingJobs[j.id] || waitingJobs[j.id].updated_at !== j.updated_at) api.vnScript(channelId, j.id).then((d) => setWaitingJobs((w) => ({ ...w, [j.id]: d }))).catch(() => undefined);
  }, [channelId, jobs.map((j) => j.id + j.status + j.updated_at).join()]);
  const answerQuestions = async (j: VnScriptJob, part: VnScriptQuestions, answers: Record<string, string>, skip: boolean) => {
    setBusy(true);
    try { await api.answerVnScript(channelId!, j.id, skip ? { part_index: part.part_index, skip: true } : { part_index: part.part_index, answers }); await loadJobs(); if (jobId === j.id) loadJob(j.id).catch(() => undefined); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
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
      const j = await api.createVnScript(channelId, { scope, scope_character_id: scope === 'character' ? scopeChar : undefined, windows: windowChoice, title: title.trim() || undefined, template: { base }, retry_failed_chunks: retryFailedChunks, instructions: direction.trim() || undefined, allow_cloud: status?.mock ? undefined : cloudOk });
      toast(tr('Script job started'), 'ai'); setJobId(j.id); loadJobs();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  // The lines posted since the visual novel's last one become new scenes of the same presentation; the writer is
  // told where the story ended and reuses its backgrounds and portraits, asking only for new art.
  const continueStory = async (presentationId: string) => {
    if (!channelId) return;
    setBusy(true);
    try {
      const j = await api.createVnScript(channelId, { continue_presentation_id: presentationId, instructions: direction.trim() || undefined, retry_failed_chunks: retryFailedChunks, allow_cloud: status?.mock ? undefined : cloudOk });
      toast(tr('Continuing the visual novel with {n} new lines', { n: j.params?.new_lines ?? 0 }), 'ai'); setContinueFor(null); setJobId(j.id); loadJobs();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  // A presentation is continued from its newest finished job; older jobs of it, and those with a job still running, are not.
  const continuable = (j: VnScriptJob) => j.status === 'completed' && !!j.presentation_id
    && !jobs.some((o) => o.id !== j.id && (o.presentation_id === j.presentation_id || o.continues_presentation_id === j.presentation_id) && (o.created_at > j.created_at || o.status === 'pending' || o.status === 'running' || o.status === 'waiting'));
  const retryBackgrounds = async (sceneKey?: string) => {
    if (!channelId || !jobId) return;
    setBusy(true);
    try {
      setJob(await api.retryVnBackgrounds(channelId, jobId, sceneKey, artCloudOk));
      await loadJob(jobId);
      toast(tr('Missing backgrounds queued; completed images are kept.'), 'ai');
    } catch (e: any) { toast(e.message, 'error'); await loadJob(jobId).catch(() => undefined); }
    finally { setBusy(false); }
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
  const artNeedsCloud = !!imageStatus?.enabled && !imageStatus.mock && !job?.params?.cloud_authorized;
  const artRetryBlocked = busy || !pres?.can_edit || !imageStatus?.enabled || (artNeedsCloud && !artCloudOk);
  const retryableBackgrounds = (job?.background_jobs ?? []).some((b) => ['missing', 'failed', 'cancelled'].includes(b.status));

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="row"><h3 style={{ margin: 0 }}>{tr('Make a visual novel')}</h3><span className="grow" />{status && (status.mock ? <span className="pill">MOCK</span> : <span className="pill ai">{status.model}</span>)}</div>
      <ol className="wizard-steps">
        {STEPS.map((s, i) => <li key={s.id} className={`${s.id === step ? 'current' : ''} ${i < stepIndex ? 'done' : ''}`}><button className="ghost small" disabled={i > 0 && !done} onClick={() => setStep(s.id)}>{i + 1}. {tr(s.label)}</button></li>)}
      </ol>

      {step === 'script' && (
        <div>
          <div className="tiny muted">{tr('The AI reads the campaign log block by block (a block ends after an hour without lines) and writes the script: which background each line plays on, which portrait each speaker shows, and the wording of the story. It leaves out chatter, bot messages and placeholders, never adds lines, and asks you when a line is unclear; the log keeps every original.')}</div>
          <div className="vn-tpl-fields tiny">
            <label title={tr('Who may watch the visual novel, and whose eyes read the log')}>{tr('Point of view')}<select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              {isGm && <option value="gm_full">{tr('Everything, including private windows (GM only result)')}</option>}
              <option value="pl_public">{tr('Lines every player can read')}</option>
              <option value="character" disabled={!isGm && myCharacters.length === 0}>{tr("One character's point of view")}</option>
            </select></label>
            {scope === 'character' && <label>{tr('Character')}<select value={scopeChar} onChange={(e) => setScopeChar(e.target.value)}>{(isGm ? characters : characters.filter((c) => myCharacters.includes(c.id))).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
            <label>{tr('Title')}<input value={title} maxLength={200} placeholder={tr('Visual novel')} onChange={(e) => setTitle(e.target.value)} /></label>
            <label>{tr('Look template')}<select value={base} onChange={(e) => setBase(e.target.value as VnBase)}>{VN_BASES.map((b) => <option key={b} value={b}>{tr(VN_BASE_INFO[b].label)}</option>)}</select></label>
          </div>
          {windowReport && (
            <div className="vn-windows" data-testid="vn-windows">
              <div className="row tiny" style={{ gap: 6 }}>
                <b>{tr('Chat windows to tell')}</b><span className="grow" />
                <button className="ghost small" onClick={() => setOmitted(new Set())}>{tr('All')}</button>
                <button className="ghost small" onClick={() => setOmitted(new Set(tellable.map((w) => w.id)))}>{tr('None')}</button>
              </div>
              {windowReport.windows.map((w) => (
                <label key={w.id} className="row tiny" style={{ gap: 6 }} title={w.line_count ? undefined : tr('This point of view reads no line of this window')}>
                  <input type="checkbox" disabled={!w.line_count} checked={w.line_count > 0 && !omitted.has(w.id)} onChange={(e) => toggleWindow(w.id, e.target.checked)} />
                  <span className={w.line_count ? '' : 'muted'}>{w.name}</span>
                  <span className="muted">{tr('{n} lines', { n: w.line_count })}</span>
                </label>
              ))}
              <div className="tiny muted">{tr('Windows you leave out are not told. Scene changes outside any window always stay; a continuation tells the same windows.')}</div>
              {noWindow && <div className="tiny" style={{ color: 'var(--warn)' }}>{tr('Choose at least one chat window.')}</div>}
            </div>
          )}
          <label className="tiny" style={{ display: 'block', marginTop: 6 }}>{tr('Direction for the AI (optional)')}<textarea value={direction} maxLength={1000} onChange={(e) => setDirection(e.target.value)} placeholder={tr('e.g. Keep the investigation scenes tense; skip rules discussion.')} style={{ minHeight: 44, display: 'block', width: '100%', marginTop: 2 }} /></label>
          <label className="tiny" style={{ display: 'block', marginTop: 6 }}><input type="checkbox" checked={retryFailedChunks} onChange={(e) => setRetryFailedChunks(e.target.checked)} /> {tr('Keep completed parts when retrying')}</label>
          {needsCloud && (status!.cloud_allowed
            ? <label className="tiny" style={{ display: 'block', marginTop: 6 }}><input type="checkbox" checked={cloudOk} onChange={(e) => setCloudOk(e.target.checked)} /> {tr('Send these lines to the configured model')}</label>
            : <div className="tiny" style={{ marginTop: 6, color: 'var(--warn)' }}>{tr('Cloud processing is off for this campaign. Enable it in Library settings, or use the mock planner.')}</div>)}
          <div className="row" style={{ marginTop: 8 }}><button className="primary" onClick={generate} disabled={busy || blocked || noWindow || (scope === 'character' && !scopeChar)}>{busy ? tr('Starting the script job…') : tr('Write the script')}</button></div>
          {jobs.length > 0 && (
            <table className="simple" style={{ marginTop: 10 }}><tbody>
              {jobs.map((j) => (
                <tr key={j.id} className={j.id === jobId ? 'selected' : ''}>
                  <td>
                    <b>{j.title}</b> <span className={`pill ${j.status === 'failed' ? 'danger' : j.status === 'completed' ? 'ok' : j.status === 'waiting' ? 'gm' : ''}`}>{j.status === 'waiting' ? tr('waiting for your answers') : tr(j.status)}</span>{j.continues_presentation_id && <span className="pill">{tr('continuation')}</span>}
                    <div className="tiny muted">{j.snapshot_scope}{j.windows?.length ? ` · ${j.windows.map((id) => windowName(id) ?? '…').join(', ')}` : ''}{j.stats ? ` · ${tr('{n} scenes', { n: j.stats.scenes })} · ${tr('{n} lines shown', { n: j.stats.shown })}` : ''}{j.status === 'running' && j.progress?.chunks_total ? ` · ${tr('part {a} of {b}', { a: j.progress.chunks_done ?? 0, b: j.progress.chunks_total })}` : ''}{j.status === 'waiting' && j.progress?.questions_open ? ` · ${tr('{n} parts wait for your answers', { n: j.progress.questions_open })}` : ''}</div>
                    {j.error && <div className="tiny" style={{ color: 'var(--danger)' }}>{j.error}</div>}
                    {j.status === 'waiting' && (waitingJobs[j.id]?.questions ?? []).filter((q) => !q.answered).map((q) => (
                      <VnQuestionBox key={q.part_index} part={q} busy={busy} onAnswer={(answers, skip) => answerQuestions(j, q, answers, skip)} />
                    ))}
                    {continueFor === j.presentation_id && continuable(j) && (
                      <div className="vn-continue">
                        <div className="tiny muted">{tr('The lines posted since this visual novel ends are written as new scenes after it, in the same point of view. The AI is told where the story stopped and reuses its backgrounds and portraits; it asks only for the places and poses that are new. The direction above applies.')}</div>
                        <div className="row" style={{ gap: 6, marginTop: 6 }}>
                          <button className="primary small" disabled={busy || blocked} onClick={() => continueStory(j.presentation_id!)}>{busy ? tr('Starting the script job…') : tr('Continue from the last line')}</button>
                          <button className="ghost small" onClick={() => setContinueFor(null)}>{tr('Cancel')}</button>
                          {blocked && <span className="tiny muted">{tr('Confirm sending the lines to the configured model above.')}</span>}
                        </div>
                      </div>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {j.status === 'completed' && <button className="small primary" onClick={() => { setJobId(j.id); setStep('art'); }}>{tr('Open')}</button>}
                    {continuable(j) && continueFor !== j.presentation_id && <button className="small" title={tr('Write the lines posted since its last line as new scenes')} onClick={() => setContinueFor(j.presentation_id)}>{tr('Continue the story')}</button>}
                    {j.status === 'failed' && <button className="small" disabled={busy} onClick={async () => {
                      setBusy(true);
                      try { await api.retryVnScript(channelId!, j.id, retryFailedChunks); setJobId(j.id); await loadJob(j.id); loadJobs(); }
                      catch (e: any) { toast(e.message, 'error'); }
                      finally { setBusy(false); }
                    }}>{tr('Retry script')}</button>}
                    {(j.status === 'pending' || j.status === 'running' || j.status === 'waiting') && <button className="small ghost" onClick={async () => { await api.cancelVnScript(channelId!, j.id).catch(() => undefined); loadJobs(); }}>{tr('cancel')}</button>}
                  </td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
      )}

      {step === 'art' && pres && (
        <div>
          <div className="tiny muted">{imageStatus?.enabled === false ? tr('Image generation is off on this server: upload backgrounds in Assets and portraits in each character space, then assign them in the editor.') : tr('Backgrounds the log needs and portraits for characters in generated mode are being painted. Characters in uploaded mode use only the portraits their players uploaded.')}</div>
          <div className="wizard-art">
            {(pres.scenes ?? []).map((s) => {
              const bg = job?.background_jobs?.find((b) => b.scene_id === s.id);
              const state = s.background_asset_id ? 'completed' : bg?.status ?? 'missing';
              const label = state === 'running' ? tr('painting…') : state === 'pending' ? tr('Queued') : state === 'missing' ? tr('Background not generated') : tr(state);
              return <div key={s.id} className="wizard-tile">
                {s.background_asset_id ? <CachedImg src={api.mediaUrl(channelId!, s.background_asset_id, s.background_asset_version)} hash={s.background_asset_hash} alt="" /> : <div className="placeholder">{label}</div>}
                <div className="tiny"><b>{s.title}</b></div>
                {!s.background_asset_id && bg?.error && <div className="tiny" style={{ color: 'var(--danger)', overflowWrap: 'anywhere' }}>{bg.error}</div>}
                {!s.background_asset_id && ['missing', 'failed', 'cancelled'].includes(state) && <button className="small" disabled={artRetryBlocked} onClick={() => retryBackgrounds(s.canonical_scene_key)}>{tr('Retry background')}</button>}
              </div>;
            })}
          </div>
          {artNeedsCloud && <label className="tiny"><input type="checkbox" checked={artCloudOk} onChange={(e) => setArtCloudOk(e.target.checked)} /> {tr('Send background prompts to the configured image model')}</label>}
          {retryableBackgrounds && <div className="row" style={{ marginTop: 8 }}><button className="small" disabled={artRetryBlocked} onClick={() => retryBackgrounds()}>{tr('Generate missing backgrounds')}</button><span className="tiny muted">{tr('Completed images are kept. Queued and running images are not submitted again.')}</span></div>}
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
            <BundleDownload channelId={channelId!} presentationId={pres.id} primary />
          </div>
          <div className="tiny muted" style={{ marginTop: 4 }}>{tr('The zip holds index.html with every image and voice line; open it in any browser, no server needed.')}</div>
        </div>
      )}
    </div>
  );
}

// The script editor asked about a part of the log instead of guessing: the questions are shown with the lines they
// are about; the answers (or a skip, which keeps the editor's draft) let the job go on with that part.
export function VnQuestionBox({ part, busy, onAnswer }: { part: Pick<VnScriptQuestions, 'first_line' | 'last_line' | 'items'>; busy: boolean; onAnswer: (answers: Record<string, string>, skip: boolean) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const given = Object.values(answers).some((a) => a.trim());
  return (
    <div className="vn-questions" data-testid="vn-questions">
      <div className="tiny muted">{tr('The script editor asks about lines {a}–{b}. The other parts go on meanwhile; your answers finish this one. Skipping keeps its draft.', { a: part.first_line, b: part.last_line })}</div>
      {part.items.map((q) => (
        <div key={q.id} className="vn-question">
          <div><b>{q.question}</b>{q.refs.length > 0 && <span className="tiny muted"> · {q.refs.join(', ')}</span>}</div>
          {q.options.length > 0 && <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 4 }}>{q.options.map((o) => <button key={o} type="button" className={`small ${answers[q.id] === o ? 'primary' : 'ghost'}`} onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}>{o}</button>)}</div>}
          <input value={answers[q.id] ?? ''} maxLength={2000} placeholder={tr('Your answer (optional)')} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} style={{ display: 'block', width: '100%', marginTop: 4 }} />
        </div>
      ))}
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <button className="primary small" disabled={busy || !given} onClick={() => onAnswer(answers, false)}>{tr('Answer and continue')}</button>
        <button className="ghost small" disabled={busy} onClick={() => onAnswer({}, true)}>{tr('Skip (use the draft)')}</button>
      </div>
    </div>
  );
}
