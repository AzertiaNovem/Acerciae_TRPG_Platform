import { t as tr, useLocale } from '../../i18n';
import { useMemo, useRef, useState } from 'react';
import { useUi } from '../../store/ui';
import type { Project, StudioVn } from '../types';
import { bundleFiles, bundleFolderName, characterNames, composeScript, standaloneData, toPresentation } from '../vn';
import { paintNeeds, voiceLines } from '../actions';
import { makeLlm } from '../providers/providers';
import { loadAiSettings, TTS_VOICES } from '../providers/settings';
import { assetAbsolutePath, exportToFolder, readAsset } from '../storage';
import { useAssetUrls } from './useAssetUrls';
import VNPlayer from '../../components/studio/vn/VNPlayer';
import VnTemplatePanel from '../../components/studio/VnTemplatePanel';
import type { VideoProgress, VideoQuality } from '../../components/studio/vn/videoExport';

const LANGS = [['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['ru', 'Русский'], ['pt', 'Português'], ['it', 'Italiano']];

// The project as a visual novel: compose the script (by rules, or with the user's language model), paint what it
// needs and voice its lines with the user's services, look at it, and save it as a player folder or a video.
export default function VnPanel({ p, update, save }: { p: Project; update: (fn: (d: Project) => void) => void; save: () => void }) {
  const toast = useUi((s) => s.toast);
  const ui = useLocale((s) => s.language);
  const ai = loadAiSettings();
  const vn = p.vn;
  const [language, setLanguage] = useState(vn?.language ?? (ui.startsWith('zh') ? 'zh' : ui.slice(0, 2)));
  const [instructions, setInstructions] = useState(vn?.instructions ?? '');
  const [useModel, setUseModel] = useState(ai.llm.provider !== 'none');
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [quality, setQuality] = useState<VideoQuality>('lossless');
  const [height, setHeight] = useState<720 | 1080>(1080);
  const abort = useRef<AbortController | null>(null);

  const compose = async () => {
    abort.current = new AbortController();
    setBusy(tr('Composing…')); setFailed([]);
    try {
      const backgrounds = (vn?.script.scenes ?? []).filter((s) => s.background).map((s) => ({ name: s.title, path: s.background! }));
      const script = await composeScript(p, { llm: useModel ? makeLlm(ai.llm) : null, language, instructions, backgrounds, signal: abort.current.signal, onProgress: (d, t) => setBusy(tr('Composing… part {done}/{total}', { done: d, total: t })) });
      update((d) => { d.vn = { script, template: d.vn?.template ?? {}, audio: {}, narrator_voice: d.vn?.narrator_voice ?? '', language, instructions, composed_at: new Date().toISOString() }; });
      setIndex(0);
      toast(tr('Composed: {scenes} scenes, {shown} lines', { scenes: script.stats.scenes, shown: script.stats.shown }));
    } catch (e: any) { if (e?.name !== 'AbortError') toast(String(e?.message ?? e), 'error'); }
    finally { setBusy(null); abort.current = null; }
  };
  // Painting and voicing work on a copy, then hand the results back as one change.
  const withCopy = async (label: string, fn: (copy: Project, signal: AbortSignal) => Promise<string[]>) => {
    if (!vn) return;
    abort.current = new AbortController();
    setBusy(label); setFailed([]);
    const copy: Project = structuredClone(p);
    try {
      const f = await fn(copy, abort.current.signal);
      update((d) => { d.characters = copy.characters; d.vn = copy.vn; });
      setFailed(f);
    } catch (e: any) { toast(String(e?.message ?? e), 'error'); }
    finally { setBusy(null); abort.current = null; save(); }
  };
  const paint = () => withCopy(tr('Painting…'), (c, sig) => paintNeeds(c, c.vn!, ai.image, (d, t) => setBusy(tr('Painting… {done}/{total}', { done: d, total: t })), sig));
  const voice = () => withCopy(tr('Voicing…'), (c, sig) => voiceLines(c, c.vn!, ai.tts, (d, t) => setBusy(tr('Voicing… {done}/{total}', { done: d, total: t })), sig));

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

  const needs = vn ? vn.script.asset_needs.length : 0;
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
          <button className="primary small" disabled={!!busy} onClick={compose}>{vn ? tr('Compose again') : tr('Compose the script')}</button>
          {busy && abort.current && <button className="ghost small" onClick={() => abort.current?.abort()}>{tr('Stop')}</button>}
          {busy && <span className="tiny muted">{busy}</span>}
        </div>
        {vn?.script.notes.length ? <div className="tiny muted">{vn.script.notes.join(' · ')}</div> : null}
      </div>
      {vn && (
        <div className="card col" style={{ gap: 8, maxWidth: 860 }}>
          <h3 style={{ margin: 0 }}>{tr('2. Art and voices')}</h3>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="small" disabled={!!busy || ai.image.provider === 'none' || !needs} onClick={paint}>{tr('Paint backgrounds and poses ({n} asked for)', { n: needs })}</button>
            {voices.length > 0 && <label className="tiny">{tr('Narrator')} <select value={vn.narrator_voice} onChange={(e) => update((d) => { d.vn!.narrator_voice = e.target.value; })}><option value="">{tr('— no voice —')}</option>{voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label>}
            <button className="small" disabled={!!busy || ai.tts.provider === 'none'} onClick={voice}>{tr('Voice the lines ({n} done)', { n: voiced })}</button>
            {voiced > 0 && <button className="ghost small" disabled={!!busy} onClick={() => update((d) => { d.vn!.audio = {}; })}>{tr('Clear voices')}</button>}
          </div>
          {(ai.image.provider === 'none' || ai.tts.provider === 'none') && <div className="tiny muted">{tr('Image and voice generation need a service in AI services; you can also add character art yourself in Characters.')}</div>}
          {failed.length > 0 && <details className="tiny" open><summary style={{ color: 'var(--danger)' }}>{tr('{n} could not be made', { n: failed.length })}</summary>{failed.slice(0, 30).map((f, i) => <div key={i}>{f}</div>)}</details>}
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
              </div>
            </div>
          </div>
          <VnTemplatePanel presentation={presentation} characters={p.characters.map((c) => ({ id: c.name, name: c.name }))} canEdit onPreview={setPreview} onSave={async (tpl) => { update((d) => { if (d.vn) d.vn.template = tpl; }); setPreview(null); }} />
        </div>
      )}
    </div>
  );
}
