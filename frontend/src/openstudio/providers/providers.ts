// The AI services, called from this computer with the user's own keys. Requests go through the desktop app's
// native HTTP client (no browser CORS rules), straight to the provider.
import type { LlmCall } from '../types';
import { getSecret } from '../storage';
import { type AiSettings, KEY_NAMES } from './settings';

async function http(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { fetch } = await import('@tauri-apps/plugin-http');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 300_000);
  if (init.signal) init.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  catch (e) { if (ctrl.signal.aborted) throw new Error(`The service did not answer in time (${url.replace(/\?.*$/, '')}).`); throw e; }
  finally { clearTimeout(timer); }
}
async function failure(res: Response, service: string): Promise<Error> {
  let detail = '';
  try { const j = await res.json(); detail = j?.error?.message ?? j?.message ?? j?.error ?? ''; } catch { /* not JSON */ }
  return new Error(`${service} answered HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
}
async function key(kind: keyof typeof KEY_NAMES, service: string): Promise<string> {
  const k = await getSecret(KEY_NAMES[kind]);
  if (!k) throw new Error(`No API key saved for ${service}. Add it in Open Log Studio → AI services.`);
  return k;
}
const trimBase = (u: string) => u.replace(/\/+$/, '');

// ---- language model -------------------------------------------------------------------------------------
export function makeLlm(s: AiSettings['llm']): LlmCall | null {
  if (s.provider === 'none') return null;
  return async ({ system, user, json, max_tokens }) => {
    if (s.provider === 'anthropic') {
      const res = await http(`${trimBase(s.base_url)}/messages`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': await key('llm', 'Anthropic'), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: s.model, max_tokens: max_tokens ?? 16000, system, messages: [{ role: 'user', content: user }] }) });
      if (!res.ok) throw await failure(res, 'Anthropic');
      const j = await res.json();
      return (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    }
    const body: Record<string, unknown> = { model: s.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (json) body.response_format = { type: 'json_object' };
    if (max_tokens) body.max_completion_tokens = max_tokens;
    const res = await http(`${trimBase(s.base_url)}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await key('llm', 'the language model')}` }, body: JSON.stringify(body) });
    if (!res.ok) throw await failure(res, 'The language model');
    const j = await res.json();
    return j.choices?.[0]?.message?.content ?? '';
  };
}

// ---- images ---------------------------------------------------------------------------------------------
export interface ImageRequest { kind: 'background' | 'standee' | 'portrait' | 'avatar'; prompt: string; reference?: { bytes: Uint8Array; mime: string } }
function b64ToBytes(b64: string): Uint8Array { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
// The same framing the server sends: one TRPG asset, identity kept, standees cut out on true transparency.
export function imagePrompt(r: ImageRequest): string {
  let p = 'Create one TRPG visual asset from the following selected art direction and source data. Preserve the specified character identity and style. Do not invent narrative facts or add text/watermarks. Use attached images as visual references when present.\n' + r.prompt;
  if (r.kind === 'standee') p += '\nMandatory image requirement, even if the gateway omits the background option: output a PNG with a true transparent alpha background. Every pixel outside the character silhouette must have alpha=0; never simulate transparency with white, a solid color or a checkerboard. Output one isolated full-body character cutout on a transparent background with a real alpha channel. Use the main profile portrait as the identity reference, retaining the face, hairstyle, clothing and art style while applying the requested gesture and expression. Keep hands, feet and the entire silhouette inside the frame. Do not copy the reference background or add scenery, a solid backdrop, a checkerboard pattern or a ground shadow.';
  return p;
}
export async function generateImage(s: AiSettings['image'], r: ImageRequest): Promise<Uint8Array> {
  if (s.provider === 'none') throw new Error('No image service is set up.');
  const auth = `Bearer ${await key('image', 'the image service')}`;
  const size = r.kind === 'background' ? '1536x1024' : s.size;
  let res: Response;
  if (r.reference) {
    // An edit with the main portrait as the identity reference (multipart, built by hand).
    const boundary = '----acerciae' + Math.random().toString(16).slice(2);
    const enc = new TextEncoder(); const parts: Uint8Array[] = [];
    const field = (name: string, value: string) => parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    field('model', s.model); field('prompt', imagePrompt(r)); field('n', '1'); field('size', size); field('output_format', 'png');
    if (s.quality !== 'auto') field('quality', s.quality);
    if (r.kind === 'standee') field('background', 'transparent');
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference.${r.reference.mime.split('/')[1]}"\r\nContent-Type: ${r.reference.mime}\r\n\r\n`), r.reference.bytes, enc.encode(`\r\n--${boundary}--\r\n`));
    const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { body.set(p, o); o += p.length; }
    res = await http(`${trimBase(s.base_url)}/images/edits`, { method: 'POST', headers: { authorization: auth, 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
  } else {
    const body: Record<string, unknown> = { model: s.model, prompt: imagePrompt(r), n: 1, size, output_format: 'png' };
    if (s.quality !== 'auto') body.quality = s.quality;
    if (r.kind === 'standee') body.background = 'transparent';
    res = await http(`${trimBase(s.base_url)}/images/generations`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  if (!res.ok) throw await failure(res, 'The image service');
  const j = await res.json();
  const item = j.data?.[0];
  if (item?.b64_json) return b64ToBytes(item.b64_json);
  if (item?.url) { const img = await http(item.url, { method: 'GET' }); if (img.ok) return new Uint8Array(await img.arrayBuffer()); }
  throw new Error('The image service returned no image.');
}

// ---- speech ---------------------------------------------------------------------------------------------
export function wavDurationMs(b: Uint8Array): number {
  if (b.length < 44 || String.fromCharCode(...b.slice(0, 4)) !== 'RIFF') return 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12, byteRate = 0;
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(...b.slice(off, off + 4)), size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') byteRate = dv.getUint32(off + 16, true);
    if (id === 'data') return byteRate ? Math.round((Math.min(size, b.length - off - 8) / byteRate) * 1000) : 0;
    off += 8 + size + (size % 2);
  }
  return 0;
}
const SPOKEN: Record<string, string> = { zh: 'Mandarin Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', es: 'Spanish', fr: 'French', de: 'German', ru: 'Russian', pt: 'Portuguese', it: 'Italian' };
export interface Speech { bytes: Uint8Array; mime: string; ext: string; ms: number }
export async function synthesize(s: AiSettings['tts'], text: string, voice: string, delivery = ''): Promise<Speech> {
  if (s.provider === 'none') throw new Error('No speech service is set up.');
  if (s.provider === 'qwen') {
    const input: Record<string, unknown> = { text, voice, format: 'wav' };
    if (s.language && s.language !== 'auto') input.language_hints = [s.language];
    if (delivery) input.instruction = delivery;
    const res = await http(`${trimBase(s.base_url)}/api/v1/services/audio/tts/SpeechSynthesizer`, { method: 'POST', headers: { authorization: `Bearer ${await key('tts', 'Qwen')}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: s.model, input }) });
    if (!res.ok) throw await failure(res, 'Qwen speech');
    const j = await res.json(); const audio = j.output?.audio ?? {};
    let bytes: Uint8Array;
    if (audio.data) bytes = b64ToBytes(audio.data);
    else if (audio.url) { const r = await http(audio.url, { method: 'GET' }); if (!r.ok) throw await failure(r, 'Qwen audio download'); bytes = new Uint8Array(await r.arrayBuffer()); }
    else throw new Error('Qwen speech returned no audio.');
    return { bytes, mime: 'audio/wav', ext: 'wav', ms: wavDurationMs(bytes) };
  }
  const body: Record<string, unknown> = { model: s.model, input: text, voice: voice || 'alloy', response_format: 'wav' };
  const lang = SPOKEN[s.language];
  const instructions = [lang ? `Speak in ${lang}.` : '', delivery].filter(Boolean).join(' ');
  if (instructions && !s.model.startsWith('tts-1')) body.instructions = instructions;
  const res = await http(`${trimBase(s.base_url)}/audio/speech`, { method: 'POST', headers: { authorization: `Bearer ${await key('tts', 'OpenAI speech')}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res, 'OpenAI speech');
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, mime: 'audio/wav', ext: 'wav', ms: wavDurationMs(bytes) };
}
