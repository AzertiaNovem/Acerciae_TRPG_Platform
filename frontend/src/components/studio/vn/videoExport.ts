// A visual novel as a video (desktop app). Each line is drawn once on a canvas, the way the standalone player shows
// it (background, standees in the template's framing, the text box), and handed to the native side with its
// duration and voice line; FFmpeg there makes the video. A line on screen does not change while it is read, so the
// video is mostly still pictures and the lossless encoding stays small.
import { api, ensureFileToken, getToken } from '../../../api/client';
import { apiBase } from '../../../lib/platform';

export type VideoQuality = 'lossless' | 'compatible';
interface Stage { name: string; position: string; active: boolean; image: string | null }
interface Line { id: string; scene_id: string; kind: string; text: string; speaker: string | null; stage: Stage[]; dice?: { total: number; outcome?: string }; audio?: string; audio_ms?: number }
export interface Script { title: string; template: Record<string, any>; scenes: { id: string; title: string; background: string | null }[]; events: Line[] }
export interface VideoProgress { phase: 'prepare' | 'frames' | 'voices' | 'encode'; done: number; total: number }

const FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

// How long a line stays: its voice plus a breath, or a reading time from its length.
export function lineDuration(l: Pick<Line, 'text' | 'audio_ms' | 'kind'>): number {
  if (l.audio_ms && l.audio_ms > 0) return Math.max(1500, l.audio_ms + 600);
  const text = l.text ?? '';
  const cjk = (text.match(/[　-鿿가-힯＀-￯]/g) ?? []).length;
  const words = text.replace(/[　-鿿가-힯＀-￯]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.min(14000, Math.max(2000, 900 + cjk * 170 + words * 300));
}

// Lines that fit `width`: words stay whole, CJK text breaks between characters, long words break anywhere.
export function wrapText(measure: (s: string) => number, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const tokens = para.match(/[　-鿿가-힯＀-￯]|[^\s　-鿿가-힯＀-￯]+|\s+/g) ?? [''];
    let line = '';
    for (const tok of tokens) {
      const next = line + tok;
      if (measure(next) <= width || !line.trim()) {
        if (measure(next) > width && !/\s/.test(tok)) {   // a single token wider than the line
          for (const ch of tok) { if (measure(line + ch) > width && line) { out.push(line); line = ''; } line += ch; }
        } else line = next;
      } else { out.push(line.trimEnd()); line = /\s/.test(tok) ? '' : tok; }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawCover(ctx: CanvasRenderingContext2D, img: ImageBitmap, W: number, H: number) {
  const s = Math.max(W / img.width, H / img.height);
  const w = img.width * s, h = img.height * s;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

// A darker copy of a standee: black laid over its own pixels only, transparency kept.
const dimCache = new WeakMap<ImageBitmap, HTMLCanvasElement>();
function dimmed(im: ImageBitmap): HTMLCanvasElement {
  let c = dimCache.get(im);
  if (c) return c;
  c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
  const x = c.getContext('2d')!;
  x.drawImage(im, 0, 0); x.globalCompositeOperation = 'source-atop'; x.fillStyle = 'rgba(0,0,0,0.45)'; x.fillRect(0, 0, c.width, c.height);
  dimCache.set(im, c);
  return c;
}

function drawBackdrop(ctx: CanvasRenderingContext2D, W: number, H: number, bg: ImageBitmap | null) {
  ctx.fillStyle = '#10131a'; ctx.fillRect(0, 0, W, H);
  if (bg) drawCover(ctx, bg, W, H);
  else { const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#1b2130'); g.addColorStop(1, '#0c0e13'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
}

export function drawTitleCard(ctx: CanvasRenderingContext2D, W: number, H: number, bg: ImageBitmap | null, title: string, subtitle?: string) {
  drawBackdrop(ctx, W, H, bg);
  ctx.fillStyle = 'rgba(6,8,12,0.62)'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#f2f4f8';
  ctx.font = `600 ${Math.round(H * 0.06)}px ${FONT}`;
  const lines = wrapText((s) => ctx.measureText(s).width, title, W * 0.8).slice(0, 3);
  lines.forEach((l, i) => ctx.fillText(l, W / 2, H / 2 + (i - (lines.length - 1) / 2) * H * 0.075));
  if (subtitle) { ctx.font = `400 ${Math.round(H * 0.028)}px ${FONT}`; ctx.fillStyle = '#b9c0cc'; ctx.fillText(subtitle, W / 2, H / 2 + (lines.length / 2) * H * 0.075 + H * 0.04); }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

export function drawLine(ctx: CanvasRenderingContext2D, W: number, H: number, bg: ImageBitmap | null, line: Line, img: (p: string | null) => ImageBitmap | null, template: Record<string, any>) {
  drawBackdrop(ctx, W, H, bg);
  // Standees: upper half lower on the stage (the default framing), or the whole figure.
  const upper = template.portrait_framing !== 'full';
  const anyActive = line.stage.some((s) => s.active);
  const xs: Record<string, number> = { left: 0.22, center: 0.5, right: 0.78 };
  if (line.kind !== 'narration' && line.kind !== 'scene_change') for (const s of line.stage) {
    const im = img(s.image); if (!im) continue;
    const h = upper ? H * 1.76 : H * 0.92, w = (im.width / im.height) * h;
    const top = upper ? H * 0.12 : H - h;
    const x = W * (xs[s.position] ?? 0.5) - w / 2;
    if (anyActive && !s.active && template.dim_inactive !== false) ctx.drawImage(dimmed(im), x, top, w, h);   // (canvas filters are missing in WebKit)
    else ctx.drawImage(im, x, top, w, h);
  }
  // Text box with the speaker's name tag.
  const bx = W * 0.04, by = H * 0.69, bw = W * 0.92, bh = H * 0.27, pad = H * 0.03;
  ctx.fillStyle = 'rgba(12,14,20,0.84)'; roundRect(ctx, bx, by, bw, bh, H * 0.018); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = Math.max(1, H / 720); ctx.stroke();
  const narration = line.kind === 'narration' || !line.speaker;
  if (!narration && line.speaker) {
    ctx.font = `600 ${Math.round(H * 0.03)}px ${FONT}`;
    const tw = ctx.measureText(line.speaker).width + pad * 1.4, th = H * 0.05;
    ctx.fillStyle = 'rgba(40,46,62,0.95)'; roundRect(ctx, bx + pad * 0.6, by - th * 0.6, tw, th, th * 0.3); ctx.fill();
    ctx.fillStyle = '#f5f6fa'; ctx.textBaseline = 'middle'; ctx.fillText(line.speaker, bx + pad * 1.3, by - th * 0.1); ctx.textBaseline = 'alphabetic';
  }
  let text = line.text ?? '';
  if (line.dice) text += `\n🎲 ${line.dice.total}${line.dice.outcome ? ` · ${line.dice.outcome}` : ''}`;
  let size = H * 0.034, lines: string[] = [];
  for (; size > H * 0.022; size *= 0.92) {
    ctx.font = `${narration ? 'italic ' : ''}400 ${Math.round(size)}px ${FONT}`;
    lines = wrapText((s) => ctx.measureText(s).width, text, bw - pad * 2);
    if (lines.length * size * 1.45 <= bh - pad * 1.6) break;
  }
  ctx.fillStyle = narration ? '#dfe3ea' : '#f2f4f8';
  lines.slice(0, Math.floor((bh - pad * 1.2) / (size * 1.45))).forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + size + i * size * 1.45));
}

async function loadImage(url: string): Promise<ImageBitmap | null> {
  try {
    // A token header makes the server send the bytes itself (with CORS), so the canvas stays readable.
    const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch { return null; }
}

// Where a video's pictures and voices come from: a server visual novel (its file list) or a local project.
export interface VideoSource {
  folder: string;                                             // the suggested file name
  script: Script;                                             // the standalone player's script data
  image: (path: string) => Promise<ImageBitmap | null>;       // a picture named in the script
  voice: (path: string) => Promise<{ url: string } | { path: string } | null>;   // a voice line named in the script
}

// Renders and encodes a server visual novel; returns the saved path, or null when the user cancelled the dialog.
export async function exportVideo(channelId: string, presentationId: string, quality: VideoQuality, height: 720 | 1080, onProgress: (p: VideoProgress) => void): Promise<string | null> {
  onProgress({ phase: 'prepare', done: 0, total: 1 });
  const manifest = await api.vnFiles(channelId, presentationId);
  const script: Script = JSON.parse(manifest.files.find((f) => f.path === 'script.json')?.content ?? '{}');
  const urlOf = new Map(manifest.files.filter((f) => f.url).map((f) => [f.path, apiBase() + f.url!]));
  const fileToken = await ensureFileToken();
  return renderVideo({
    folder: manifest.folder, script,
    image: async (p) => (urlOf.has(p) ? loadImage(urlOf.get(p)!) : null),
    voice: async (p) => { const u = urlOf.get(p); return u ? { url: `${u}${u.includes('?') ? '&' : '?'}token=${encodeURIComponent(fileToken)}` } : null; },
  }, quality, height, onProgress);
}

// Draws every line once, holds each for its voice or reading time, and has the native side encode the video.
export async function renderVideo(source: VideoSource, quality: VideoQuality, height: 720 | 1080, onProgress: (p: VideoProgress) => void): Promise<string | null> {
  const [{ invoke }, { save }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/plugin-dialog'), import('@tauri-apps/api/event')]);
  const status = await invoke<{ available: boolean }>('ffmpeg_status');
  if (!status.available) throw new Error('FFmpeg was not found. Install FFmpeg (or use an installer that includes it) to export videos.');
  const ext = quality === 'lossless' ? 'mkv' : 'mp4';
  const output = await save({ defaultPath: `${source.folder}.${ext}`, filters: [{ name: quality === 'lossless' ? 'Matroska video (lossless)' : 'MP4 video', extensions: [ext] }] });
  if (!output) return null;
  const script = source.script;
  const images = new Map<string, ImageBitmap | null>();
  const wanted = new Set<string>();
  for (const s of script.scenes) if (s.background) wanted.add(s.background);
  for (const e of script.events) for (const st of e.stage) if (st.image) wanted.add(st.image);
  let loaded = 0;
  await Promise.all([...wanted].map(async (p) => { images.set(p, await source.image(p).catch(() => null)); onProgress({ phase: 'prepare', done: ++loaded, total: wanted.size }); }));
  const img = (p: string | null) => (p ? images.get(p) ?? null : null);

  const W = Math.round((height * 16) / 9 / 2) * 2, H = height;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const job = await invoke<string>('video_begin');
  const segments: { frame: number; ms: number }[] = [];
  const audio: { url?: string; path?: string; start_ms: number }[] = [];
  let clock = 0, frame = 0;
  const emit = async (ms: number) => {
    const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('Could not draw a frame.'))), 'image/png'));
    await invoke('video_frame', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-job': job, 'x-index': String(frame) } });
    segments.push({ frame, ms }); frame++; clock += ms;
  };
  const unlisten = await listen<{ phase: 'voices' | 'encode'; done: number; total: number }>('video-progress', (e) => onProgress(e.payload));
  try {
    const sceneOf = new Map(script.scenes.map((s) => [s.id, s]));
    drawTitleCard(ctx, W, H, img(script.scenes[0]?.background ?? null), script.title);
    await emit(3000);
    let scene: string | null = null;
    for (let i = 0; i < script.events.length; i++) {
      const e = script.events[i];
      const sc = sceneOf.get(e.scene_id);
      const bg = img(sc?.background ?? null);
      if (e.scene_id !== scene) {
        scene = e.scene_id;
        if (sc?.title) { drawTitleCard(ctx, W, H, bg, sc.title); await emit(2200); }
      }
      if (e.kind === 'scene_change') { drawTitleCard(ctx, W, H, bg, e.text || sc?.title || ''); await emit(2200); continue; }
      drawLine(ctx, W, H, bg, e, img, script.template ?? {});
      if (e.audio) { const v = await source.voice(e.audio).catch(() => null); if (v) audio.push({ ...v, start_ms: clock + 200 }); }
      await emit(lineDuration(e));
      onProgress({ phase: 'frames', done: i + 1, total: script.events.length });
    }
    drawTitleCard(ctx, W, H, null, script.title, '— Fin —');
    await emit(3000);
    return await invoke<string>('video_finish', { job, spec: { output, quality, segments, audio, total_ms: clock } });
  } catch (e) {
    invoke('video_cancel', { job }).catch(() => undefined);
    throw e;
  } finally { unlisten(); }
}
