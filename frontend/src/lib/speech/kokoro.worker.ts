// Kokoro text-to-speech in a worker, so the chat stays responsive while lines are synthesized. Each model is fetched
// from Hugging Face on first use, kept on this device (the Cache API, or cachePolyfill.ts where there is none), and
// runs here:
// - en: kokoro-js with Kokoro-82M v1.0 (8-bit, about 90 MB, WebAssembly);
// - zh: @uzen/kokoro-js with Kokoro-82M v1.1-zh (Mandarin and mixed Chinese/English, about 330 MB; WebGPU when the
//   device has it, else WebAssembly). Its voice files are not in the package: they come from the model repository.
// Only the package for the model in use is downloaded.
import type { SpeechModel } from './text';
import { installCachePolyfill } from './cachePolyfill';

// The model files are kept on this device after the first download, also in webviews without the Cache API.
installCachePolyfill(self);

type Request = { type: 'speak'; id: number; text: string; voice: string; speed: number; model: SpeechModel };
interface Tts { generate(text: string, o: { voice: any; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }> }

const ZH_MODEL = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX';
const models = new Map<SpeechModel, Promise<Tts>>();

const progress = (model: SpeechModel) => (p: any) => {
  if (p?.status === 'progress' && typeof p.progress === 'number') postMessage({ type: 'loading', model, progress: Math.round(p.progress) });
};

async function webgpu(): Promise<boolean> {
  try { return !!(await (navigator as any).gpu?.requestAdapter()); } catch { return false; }
}

function load(model: SpeechModel): Promise<Tts> {
  let m = models.get(model);
  if (!m) {
    m = (async (): Promise<Tts> => {
      if (model === 'zh') {
        const { KokoroTTS } = await import('@uzen/kokoro-js');
        return KokoroTTS.from_pretrained(ZH_MODEL, {
          dtype: 'fp32', device: (await webgpu()) ? 'webgpu' : 'wasm',
          voicePath: `https://huggingface.co/${ZH_MODEL}/resolve/main/voices`, progress_callback: progress(model),
        }) as unknown as Promise<Tts>;
      }
      const { KokoroTTS } = await import('kokoro-js');
      return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'wasm', progress_callback: progress(model) }) as unknown as Promise<Tts>;
    })();
    models.set(model, m);
    m.then(() => postMessage({ type: 'ready', model }), () => { models.delete(model); });
  }
  return m;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const r = event.data;
  if (r?.type !== 'speak') return;
  try {
    const tts = await load(r.model);
    const out = await tts.generate(r.text, { voice: r.voice, speed: r.speed });
    const audio = out.audio;
    (self as unknown as Worker).postMessage({ type: 'audio', id: r.id, audio, rate: out.sampling_rate }, [audio.buffer]);
  } catch (e: any) {
    postMessage({ type: 'error', id: r.id, model: r.model, error: String(e?.message ?? e) });
  }
};
