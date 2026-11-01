// Kokoro text-to-speech in a worker, so the chat stays responsive while lines are synthesized. The model (about
// 90 MB, 8-bit) is fetched from Hugging Face on first use and kept in the browser cache; it runs on this device.
import { KokoroTTS } from 'kokoro-js';

type Request = { type: 'speak'; id: number; text: string; voice: string; speed: number };
let model: Promise<KokoroTTS> | null = null;

function load(): Promise<KokoroTTS> {
  if (!model) {
    model = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8', device: 'wasm',
      progress_callback: (p: any) => { if (p?.status === 'progress' && typeof p.progress === 'number') postMessage({ type: 'loading', progress: Math.round(p.progress) }); },
    });
    model.then(() => postMessage({ type: 'ready' }), () => { model = null; });
  }
  return model;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const r = event.data;
  if (r?.type !== 'speak') return;
  try {
    const tts = await load();
    const out = await tts.generate(r.text, { voice: r.voice as any, speed: r.speed });
    const audio = out.audio as Float32Array;
    (self as unknown as Worker).postMessage({ type: 'audio', id: r.id, audio, rate: out.sampling_rate }, [audio.buffer]);
  } catch (e: any) {
    postMessage({ type: 'error', id: r.id, error: String(e?.message ?? e) });
  }
};
