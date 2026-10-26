import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../../../api/client';
import type { Presentation, PresentationEvent, PresentationScene } from '../../../types';
import { VnAudio } from './audio';
import './vn.css';

export interface VNPlayerProps {
  channelId: string;
  presentation: Presentation;
  index: number;                       // controlled current event index (over visible, non-hidden events)
  onIndexChange: (i: number) => void;
  editorMode?: boolean;                // disables progress saving / fullscreen keys when embedded in the editor
  characterNames: Record<string, string>;
}

const POS_CLASS: Record<string, string> = { left: 'pos-left', center: 'pos-center', right: 'pos-right' };

export default function VNPlayer({ channelId, presentation, index, onIndexChange, editorMode, characterNames }: VNPlayerProps) {
  const settings = presentation.settings ?? {};
  const animations: boolean = settings.animations_enabled !== false;
  const events = useMemo(() => (presentation.events ?? []).filter((e) => !e.hidden), [presentation.events]);
  const scenes = useMemo(() => { const m: Record<string, PresentationScene> = {}; for (const s of presentation.scenes ?? []) m[s.id] = s; return m; }, [presentation.scenes]);
  const cur: PresentationEvent | undefined = events[index];
  const scene = cur?.scene_id ? scenes[cur.scene_id] : undefined;
  const prevSceneId = useRef<string | null>(null);
  const [sceneTitleFlash, setSceneTitleFlash] = useState<string | null>(null);
  const audio = useMemo(() => new VnAudio(), []);
  const [needUnlock, setNeedUnlock] = useState(false);
  const [playing, setPlaying] = useState(false);           // auto-play
  const [speed, setSpeed] = useState(1);
  const [skipTts, setSkipTts] = useState(false);
  const [hideUi, setHideUi] = useState(false);
  const [hideChars, setHideChars] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [typed, setTyped] = useState(0);                    // typewriter progress (chars)
  const [audioMs, setAudioMs] = useState(0);
  const [volumes, setVolumes] = useState(audio.volumes);
  const stageRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  const text = cur?.display_text ?? '';
  const chars = useMemo(() => [...text], [text]);
  const cps = (settings.typewriter_cps ?? 28) * speed;
  const hasAudio = !!cur?.audio_asset_id && !skipTts;

  // ---- typewriter + audio per line -------------------------------------------------------------
  useEffect(() => {
    doneRef.current = false; setTyped(0); setAudioMs(0);
    audio.stopVoice();
    if (!cur) return;
    if (cur.display_kind === 'dice' && animations) { /* dice effect rendered below */ }
    if (scene?.id && scene.id !== prevSceneId.current) { prevSceneId.current = scene.id; if (cur.display_kind === 'scene_change' || index === 0) { setSceneTitleFlash(scene.title); setTimeout(() => setSceneTitleFlash(null), 1400); } }
    const bgm = scene?.bgm_asset_id ? api.mediaUrl(channelId, scene.bgm_asset_id) : null; audio.playBgm(bgm);
    let timer: number | null = null; let cancelled = false;
    const total = chars.length;
    const finishLine = () => { if (cancelled || doneRef.current) return; doneRef.current = true; setTyped(total); };
    if (hasAudio && cur.audio_asset_id) {
      const src = api.ttsAudioUrl(channelId, cur.audio_asset_id);
      const fmt = cur.audio_mime === 'audio/wav' ? 'wav' : cur.audio_mime === 'audio/mpeg' ? 'mp3' : undefined;
      audio.unlock().then((ok) => {
        if (cancelled) return;
        if (!ok) { setNeedUnlock(true); return; }
        audio.setRate(speed);
        audio.onVoiceTime = (ms) => { setAudioMs(ms); const dur = audio.voiceDurationMs() || cur.audio_duration_ms || 1; if (!cur.word_timestamps) setTyped(Math.min(total, Math.round(total * (ms / dur) * 1.05))); };
        audio.playVoice(src, fmt, () => { finishLine(); if (playing) advance(); });
      });
    } else {
      // Manual/auto reading: character-paced typewriter, then dwell by estimated duration when auto-playing.
      const step = Math.max(8, 1000 / cps); let n = 0;
      timer = window.setInterval(() => { n += Math.max(1, Math.round(cps / 30)); if (n >= total) { if (timer) clearInterval(timer); finishLine(); if (playing) { const dwell = Math.max(600, (cur.estimated_duration_ms || 1500) / speed - total * step); timer = window.setTimeout(() => advance(), dwell) as unknown as number; } } else setTyped(n); }, step);
    }
    return () => { cancelled = true; if (timer) { clearInterval(timer); clearTimeout(timer); } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id, playing, skipTts, speed, needUnlock === false]);

  useEffect(() => () => audio.dispose(), [audio]);
  useEffect(() => { if (!editorMode) { const t = setTimeout(() => api.saveVnProgress(channelId, presentation.id, index).catch(() => undefined), 800); return () => clearTimeout(t); } }, [index, channelId, presentation.id, editorMode]);

  const advance = useCallback(() => { onIndexChange(Math.min(events.length - 1, index + 1)); }, [index, events.length, onIndexChange]);
  const back = useCallback(() => onIndexChange(Math.max(0, index - 1)), [index, onIndexChange]);
  const next = useCallback(() => { if (!doneRef.current && !hasAudio) { doneRef.current = true; setTyped(chars.length); return; } if (hasAudio && !doneRef.current) { audio.stopVoice(); doneRef.current = true; setTyped(chars.length); return; } advance(); }, [advance, chars.length, hasAudio, audio]);

  // ---- keyboard --------------------------------------------------------------------------------
  useEffect(() => {
    const el = stageRef.current; if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
      else if (e.key.toLowerCase() === 'a') setPlaying((p) => !p);
      else if (e.key.toLowerCase() === 'h') setHideUi((h) => !h);
      else if (e.key.toLowerCase() === 'c') setHideChars((h) => !h);
      else if (e.key.toLowerCase() === 'r') setShowRaw((r) => !r);
      else if (e.key.toLowerCase() === 's') setSkipTts((s) => !s);
      else if (e.key.toLowerCase() === 'l') audio.replayVoice();
      else if (e.key.toLowerCase() === 'f' && !editorMode) toggleFullscreen();
    };
    el.addEventListener('keydown', onKey); return () => el.removeEventListener('keydown', onKey);
  }, [next, back, audio, editorMode]);
  const toggleFullscreen = () => { const el = stageRef.current; if (!el) return; if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen?.(); };

  if (!cur) return <div className="vn-stage" ref={stageRef} tabIndex={0}><div className="vn-layer vn-bg empty" /><div className="vn-dialogue narration"><div className="vn-text">No visible lines in this presentation.</div></div></div>;

  const bgUrl = scene?.background_asset_id ? api.mediaUrl(channelId, scene.background_asset_id, scene.background_asset_version) : null;
  const placements = cur.display_kind === 'narration' || cur.display_kind === 'scene_change' ? [] : (cur.character_asset_ids ?? []);
  const speaker = cur.speaker_name_override ?? cur.character_name ?? cur.speaker_display_name;
  const isNarr = cur.display_kind === 'narration' || cur.display_kind === 'scene_change' || cur.display_kind === 'system';
  const shownText = chars.slice(0, typed).join('');
  const words = cur.word_timestamps;
  const fadeDur = animations ? 0.45 : 0;
  const dialogueStyle = cur.dialogue_style ?? {};

  return (
    <div className={`vn-stage ${hideUi ? '' : 'show-hud'}`} ref={stageRef} tabIndex={0} onClick={(e) => { if ((e.target as HTMLElement).closest('.vn-hud, .vn-raw, .vn-unlock')) return; next(); }} style={{ ['--vn-font' as any]: settings.font || undefined }}>
      {/* 1. background */}
      <AnimatePresence initial={false}>
        <motion.div key={bgUrl ?? 'empty'} className={`vn-layer vn-bg ${bgUrl ? '' : 'empty'}`} style={bgUrl ? { backgroundImage: `url("${bgUrl}")` } : undefined}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: fadeDur * 1.6 }} />
      </AnimatePresence>
      {/* 2. environment */}
      {scene?.environment?.effect && scene.environment.effect !== 'none' && <div className={`vn-layer vn-env ${scene.environment.effect}`} />}
      {/* 3. characters */}
      {!hideChars && (
        <div className="vn-layer vn-chars">
          <AnimatePresence>
            {placements.map((p) => {
              const active = p.character_id === cur.speaker_character_id || p.active;
              const url = p.asset_id ? api.mediaUrl(channelId, p.asset_id, p.asset_version) : null;
              return (
                <motion.div key={p.character_id} className={`vn-char ${POS_CLASS[p.position] ?? 'pos-center'}`} layout={animations}
                  initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0, scale: active ? 1 : 0.94, filter: active ? 'brightness(1)' : 'brightness(0.55)', zIndex: active ? 2 : 1 }} exit={{ opacity: 0, y: 20 }} transition={{ duration: fadeDur }}>
                  {url ? <img src={url} alt={characterNames[p.character_id] ?? ''} style={{ transform: p.flip ? 'scaleX(-1)' : undefined }} /> : <div className="vn-char-placeholder">{characterNames[p.character_id] ?? 'character'}<br /><span style={{ fontSize: 10 }}>no standee assigned</span></div>}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
      {/* dice effect */}
      {cur.display_kind === 'dice' && cur.dice?.total != null && animations && settings.dice_effect !== 'none' && (
        <motion.div className="vn-dice-fx" key={cur.id} initial={{ scale: 0.3, opacity: 0, rotate: -40 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }}>
          {cur.dice.total}{cur.dice.outcome ? <span style={{ fontSize: '0.4em', marginLeft: 12 }}>{cur.dice.outcome}</span> : null}
        </motion.div>
      )}
      {/* 4. dialogue */}
      {!hideUi && (
        <AnimatePresence mode="wait">
          <motion.div key={cur.id} className={`vn-dialogue ${isNarr ? 'narration' : ''} ${cur.display_kind === 'dice' ? 'dice' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: animations ? 0.2 : 0 }}
            style={{ ['--vn-name-bg' as any]: dialogueStyle.name_color, fontFamily: dialogueStyle.font }}>
            {!isNarr && <div className="vn-name">{speaker}</div>}
            <div className="vn-text">
              {words && hasAudio ? words.map((w, i) => <span key={i} className={`vn-word ${audioMs >= w.start_ms ? 'said' : ''}`}>{w.word}</span>) : shownText}
              {typed < chars.length && <span className="vn-cursor">▌</span>}
            </div>
          </motion.div>
        </AnimatePresence>
      )}
      {sceneTitleFlash && animations && <motion.div className="vn-scene-title" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>{sceneTitleFlash}</motion.div>}
      {/* 5. HUD */}
      {!hideUi && (
        <div className="vn-hud" onClick={(e) => e.stopPropagation()}>
          <button onClick={back} title="previous (←)">⟨</button>
          <button onClick={() => setPlaying(!playing)} className={playing ? 'on' : ''} title="auto-play (a)">{playing ? '❚❚ auto' : '▶ auto'}</button>
          <button onClick={next} title="next (space)">⟩</button>
          <button onClick={() => setSkipTts(!skipTts)} className={skipTts ? 'on' : ''} title="skip voice (s)">skip TTS</button>
          <button onClick={() => audio.replayVoice()} title="replay line (l)">↻ line</button>
          <select value={speed} onChange={(e) => { setSpeed(+e.target.value); audio.setRate(+e.target.value); }} title="speed" style={{ fontSize: 11, padding: '2px 4px' }}>{[0.75, 1, 1.25, 1.5, 2].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
          <select value={cur.scene_id ?? ''} onChange={(e) => { const i = events.findIndex((ev) => ev.scene_id === e.target.value); if (i >= 0) onIndexChange(i); }} title="jump to scene" style={{ fontSize: 11, padding: '2px 4px', maxWidth: 160 }}>{(presentation.scenes ?? []).map((s) => <option key={s.id} value={s.id}>{s.title || `Scene ${s.position + 1}`}</option>)}</select>
          <span className="grow" />
          <label className="tiny" title="voice volume">🗣<input type="range" min={0} max={1} step={0.05} value={volumes.voice} onChange={(e) => { audio.setVolumes({ voice: +e.target.value }); setVolumes({ ...audio.volumes }); }} style={{ width: 60 }} /></label>
          <label className="tiny" title="BGM volume">♫<input type="range" min={0} max={1} step={0.05} value={volumes.bgm} onChange={(e) => { audio.setVolumes({ bgm: +e.target.value }); setVolumes({ ...audio.volumes }); }} style={{ width: 60 }} /></label>
          <button onClick={() => setHideChars(!hideChars)} className={hideChars ? 'on' : ''} title="hide standees (c)">standees</button>
          <button onClick={() => setShowRaw(!showRaw)} className={showRaw ? 'on' : ''} title="raw log (r)">raw</button>
          <button onClick={() => setHideUi(true)} title="hide UI (h)">hide UI</button>
          {!editorMode && <button onClick={toggleFullscreen} title="fullscreen (f)">⛶</button>}
          <span className="tiny" style={{ color: '#ccc' }}>{index + 1}/{events.length}</span>
        </div>
      )}
      <div className="vn-progress"><div style={{ width: `${((index + 1) / Math.max(1, events.length)) * 100}%` }} /></div>
      {showRaw && <div className="vn-raw" onClick={(e) => e.stopPropagation()}><div className="row"><b>Raw log (canonical, verbatim)</b><span className="grow" /><button className="small" onClick={() => setShowRaw(false)}>close</button></div>{events.map((e, i) => <div key={e.id} style={{ padding: '3px 0', color: i === index ? '#ffe74c' : undefined, cursor: 'pointer' }} onClick={() => onIndexChange(i)}><b>{e.speaker_display_name}</b>: {e.content}</div>)}</div>}
      {needUnlock && <div className="vn-unlock" onClick={async () => { const ok = await audio.unlock(); if (ok) { setNeedUnlock(false); } }}><div style={{ textAlign: 'center' }}><div style={{ fontSize: 28 }}>🔊</div><div>Click to enable audio playback</div><div className="tiny" style={{ opacity: .7 }}>Browsers block sound until you interact with the page.</div></div></div>}
    </div>
  );
}
