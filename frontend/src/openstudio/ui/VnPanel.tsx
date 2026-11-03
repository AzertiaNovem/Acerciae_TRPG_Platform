import { t as tr, useLocale } from '../../i18n';
import { useMemo, useState } from 'react';
import { useUi } from '../../store/ui';
import type { Project } from '../types';
import { bundleFiles, bundleFolderName, characterNames, lastScriptedSeq, standaloneData, toPresentation, unscriptedCount } from '../vn';
import { openNeeds } from '../actions';
import { answerDraft, conflictFor, discardDraft, startCompose, startContinue, startPaint, startVoice, useTasks } from '../tasks';
import { VnQuestionBox } from '../../components/studio/VnWizard';
import { conflictText, TaskRow } from './TaskTray';
import { loadAiSettings, TTS_VOICES } from '../providers/settings';
import { assetAbsolutePath, exportToFolder, readAsset } from '../storage';
import { useAssetUrls } from './useAssetUrls';
import VNPlayer from '../../components/studio/vn/VNPlayer';
import VnTemplatePanel from '../../components/studio/VnTemplatePanel';
import type { VideoProgress, VideoQuality } from '../../components/studio/vn/videoExport';

const LANGS = [['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['ru', 'Русский'], ['pt', 'Português'], ['it', 'Italiano']];

// The project as a visual novel: compose the script (by rules, or with the user's language model), paint what it
// needs and voice its lines with the user's services, look at it, and save it as a player folder or a video.
export default function VnPanel({ p, update }: { p: Project; update: (fn: (d: Project) => void) => void }) {
  const toast = useUi((s) => s.toast);
  const ui = useLocale((s) => s.language);
  const ai = loadAiSettings();
  const vn = p.vn;
  const [language, setLanguage] = useState(vn?.language ?? (ui.startsWith('zh') ? 'zh' : ui.slice(0, 2)));
  const [instructions, setInstructions] = useState(vn?.instructions ?? '');
  const [useModel, setUseModel] = useState(ai.llm.provider !== 'none');
  const [busy, setBusy] = useState<string | null>(null);   // saving a folder or a video (not an AI task)
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [quality, setQuality] = useState<VideoQuality>('lossless');
  const [height, setHeight] = useState<720 | 1080>(1080);

  // The AI work runs as tasks (../tasks): it goes on when this panel is left, and its results land in the project
  // as they finish. Painting and voicing may run at the same time; the script waits for neither and neither for it.
  const tasks = useTasks((s) => s.tasks).filter((t) => t.projectId === p.id && (t.kind === 'compose' || t.kind === 'continue' || t.kind === 'paint' || t.kind === 'voice'));
  const running = tasks.filter((t) => t.status === 'running');
  const scriptBlocked = conflictFor(p.id, 'compose', `compose:${p.id}`);
  const paintBlocked = conflictFor(p.id, 'paint', `paint:${p.id}`);
  const voiceBlocked = conflictFor(p.id, 'voice', `voice:${p.id}`);
  const start = (fn: () => void) => { try { fn(); } catch (e: any) { toast(conflictText(e?.message), 'error'); } };
  const options = { useModel, language, instructions };
  const compose = () => start(() => { discardDraft(p.id); startCompose(p.id, options); });
  // The script editor asked about some parts: the draft waits in the project until every part is answered or skipped.
  const draft = p.vn_draft;
  const open = draft?.pending.filter((x) => !x.skip && !x.answers) ?? [];
  const answer = (index: number, answers: Record<string, string>, skip: boolean) => start(() => { answerDraft(p.id, index, answers, skip); });
  // The lines after the visual novel's last one (a supplement log): composed on their own and appended, reusing
  // the novel's backgrounds and poses; the voice lines already made are kept.
  const fresh = vn ? unscriptedCount(p) : 0;
  const carryOn = () => start(() => { discardDraft(p.id); startContinue(p.id, options); });
  const paint = () => start(() => startPaint(p.id));
  const voice = () => start(() => startVoice(p.id));

  const template = preview ?? vn?.template ?? {};
  const presentation = useMemo(() => {
    if (!vn) return null;
    const pres = toPresentation(p, vn.script, template);
    for (const e of pres.events ?? []) { const a = vn.audio[Number(e.canonical_event_id)]; if (a) { e.audio_asset_id = a.path; (e as any).audio_duration_ms = a.ms; } }
    return pres;
  }, [p, vn, template]);
  const paths = useMemo(() => [
    ...(vn?.script.scenes.map((s) => s.background) ?? []),
    ...p.characters.flatMap((c) => [c.portrait, ...Object.values(c.poses)]),
    ...Object.values(vn?.audio ?? {}).map((a) => a.path),
  ], [p, vn]);
  const url = useAssetUrls(p.id, paths);

  const folder = async () => {
    if (!vn) return;
    try {
      const files = bundleFiles(p, vn.script, vn.template, vn.audio);
      const r = await exportToFolder(p.id, bundleFolderName(p.title), files);
      if (r) toast(r.failed.length ? tr('{n} files could not be saved: {first}', { n: r.failed.length, first: r.failed[0] }) : tr('Saved'), r.failed.length ? 'error' : 'info');
    } catch (e: any) { toast(String(e?.message ?? e), 'error'); }
  };
  const video = async () => {
    if (!vn) return;
    setBusy(tr('Preparing…'));
    try {
      const { renderVideo } = await import('../../components/studio/vn/videoExport');
      const data = standaloneData(p, vn.script, vn.template, vn.audio);
      const assetOf = new Map(bundleFiles(p, vn.script, vn.template, vn.audio).filter((f) => f.asset).map((f) => [f.path, f.asset!]));
      const label = (x: VideoProgress) => x.phase === 'encode' ? tr('Encoding… {percent}%', { percent: x.total ? Math.floor((x.done / x.total) * 100) : 0 }) : x.phase === 'frames' ? tr('Drawing lines… {done}/{total}', { done: x.done, total: x.total }) : x.phase === 'voices' ? tr('Fetching voices… {done}/{total}', { done: x.done, total: x.total }) : tr('Loading pictures… {done}/{total}', { done: x.done, total: x.total });
      const out = await renderVideo({
        folder: bundleFolderName(p.title), script: data as any,
        image: async (path) => { const a = assetOf.get(path); if (!a) return null; return createImageBitmap(new Blob([(await readAsset(p.id, a)) as Uint8Array<ArrayBuffer>])); },
        voice: async (path) => { const a = assetOf.get(path); return a ? { path: await assetAbsolutePath(p.id, a) } : null; },
      }, quality, height, (x) => setBusy(label(x)));
      if (out) toast(tr('Video saved'));
    } catch (e: any) { toast(String(e?.message ?? e), 'error'); }
    finally { setBusy(null); }
  };

  const needs = vn ? openNeeds(p).length : 0;
  const scriptRows = tasks.filter((t) => t.kind === 'compose' || t.kind === 'continue');
  const artRows = tasks.filter((t) => t.kind === 'paint' || t.kind === 'voice');
  const voiced = vn ? Object.keys(vn.audio).length : 0;
  const voices = ai.tts.provider === 'none' ? [] : TTS_VOICES[ai.tts.provider];
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card col" style={{ gap: 8, maxWidth: 860 }}>
        <h3 style={{ margin: 0 }}>{tr('1. Script')}</h3>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="row tiny"><input type="radio" checked={!useModel} onChange={() => setUseModel(false)} />{tr('Rule-based (free, offline)')}</label>
          <label className="row tiny" title={ai.llm.provider === 'none' ? tr('Set up a language model in AI services') : ''}><input type="radio" checked={useModel} disabled={ai.llm.provider === 'none'} onChange={() => setUseModel(true)} />{tr('Language model ({model})', { model: ai.llm.model || '—' })}</label>
          <label className="tiny">{tr('Language')} <select value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
        {useModel && <textarea rows={2} placeholder={tr('Direction for the writer (optional): tone, what to focus on, what to leave out')} value={instructions} onChange={(e) => setInstructions(e.target.value)} />}
        <div className="row" style={{ gap: 8 }}>
          {vn && fresh > 0 && <button className="primary small" disabled={!!scriptBlocked} onClick={carryOn} title={tr('Writes the lines after line #{n} as new scenes, reusing this novel\'s backgrounds and poses and asking only for new art', { n: lastScriptedSeq(vn.script) })}>{tr('Continue the story ({n} new lines)', { n: fresh })}</button>}
          <button className={vn && fresh > 0 ? 'small' : 'primary small'} disabled={!!scriptBlocked} onClick={() => { if (!vn || !fresh || confirm(tr('Compose the whole log again? The current script and its voice lines are replaced.'))) compose(); }}>{vn ? tr('Compose again') : tr('Compose the script')}</button>
          {scriptBlocked === 'script-in-use' && <span className="tiny muted">{conflictText(scriptBlocked)}</span>}
        </div>
        {scriptRows.map((t) => <TaskRow key={t.id} task={t} />)}
        {draft && !scriptBlocked && (
          <div className="col" style={{ gap: 6 }} data-testid="vn-draft">
            <div className="row tiny" style={{ gap: 8 }}>
              <span>{open.length ? tr('{n} parts wait for your answers', { n: open.length }) : tr('waiting for your answers')}</span>
              <span className="grow" />
              <button className="ghost small" onClick={() => { if (confirm(tr('Drop this draft? The questions are forgotten and the current script stays.'))) discardDraft(p.id); }}>{tr('Drop the draft')}</button>
            </div>
            {open.map((x) => <VnQuestionBox key={`${x.index}:${x.rounds}`} part={{ first_line: x.first_line, last_line: x.last_line, items: x.questions }} busy={false} onAnswer={(a, skip) => answer(x.index, a, skip)} />)}
          </div>
        )}
        {vn?.script.notes.length ? <div className="tiny muted">{vn.script.notes.join(' · ')}</div> : null}
      </div>
      {vn && (
        <div className="card col" style={{ gap: 8, maxWidth: 860 }}>
          <h3 style={{ margin: 0 }}>{tr('2. Art and voices')}</h3>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="small" disabled={!!paintBlocked || ai.image.provider === 'none' || !needs} onClick={paint}>{tr('Paint backgrounds and poses ({n} asked for)', { n: needs })}</button>
            {voices.length > 0 && <label className="tiny">{tr('Narrator')} <select value={vn.narrator_voice} onChange={(e) => update((d) => { d.vn!.narrator_voice = e.target.value; })}><option value="">{tr('— no voice —')}</option>{voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label>}
            <button className="small" disabled={!!voiceBlocked || ai.tts.provider === 'none'} onClick={voice}>{tr('Voice the lines ({n} done)', { n: voiced })}</button>
            {voiced > 0 && <button className="ghost small" disabled={running.some((t) => t.kind === 'voice')} onClick={() => update((d) => { d.vn!.audio = {}; })}>{tr('Clear voices')}</button>}
          </div>
          {(ai.image.provider === 'none' || ai.tts.provider === 'none') && <div className="tiny muted">{tr('Image and voice generation need a service in AI services; you can also add character art yourself in Characters.')}</div>}
          {artRows.map((t) => <TaskRow key={t.id} task={t} />)}
          {running.length > 0 && <div className="tiny muted">{tr('These keep going if you leave this page; the results are saved as they arrive.')}</div>}
        </div>
      )}
      {vn && presentation && (
        <div className="open-studio-vn">
          <div className="col" style={{ gap: 8, minWidth: 0 }}>
            <VNPlayer channelId="" presentation={presentation} index={index} onIndexChange={setIndex} editorMode characterNames={characterNames(p)} assetUrl={(id) => url(id) ?? ''} audioUrl={(id) => url(id) ?? ''} />
            <div className="card col" style={{ gap: 8 }}>
              <h3 style={{ margin: 0 }}>{tr('3. Save')}</h3>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="small" disabled={!!busy} onClick={folder} title={tr('index.html (the player), script.json, every picture and voice line')}>{tr('Save as a folder (player)…')}</button>
                <select value={quality} onChange={(e) => setQuality(e.target.value as VideoQuality)} disabled={!!busy}><option value="lossless">{tr('Lossless (MKV)')}</option><option value="compatible">{tr('Compatible (MP4)')}</option></select>
                <select value={height} onChange={(e) => setHeight(Number(e.target.value) as 720 | 1080)} disabled={!!busy}><option value={1080}>1080p</option><option value={720}>720p</option></select>
                <button className="small" disabled={!!busy} onClick={video}>{tr('Export video…')}</button>
                {busy && <span className="tiny muted">{busy}</span>}
              </div>
            </div>
          </div>
          <VnTemplatePanel presentation={presentation} characters={p.characters.map((c) => ({ id: c.name, name: c.name }))} canEdit onPreview={setPreview} onSave={async (tpl) => { update((d) => { if (d.vn) d.vn.template = tpl; }); setPreview(null); }} />
        </div>
      )}
    </div>
  );
}
