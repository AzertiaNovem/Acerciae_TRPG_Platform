// Reading the chat aloud with Kokoro, on this device. Lines are synthesized one after another in a worker and played
// in order; turning it off stops the voice and drops what is queued. On or off is for this visit; the voice is kept.
import { create } from 'zustand';
import { readStorage, writeStorage } from '../storage';
import type { Message } from '../../types';
import { KOKORO_VOICES, spokenLine } from './text';

const VOICE_KEY = 'acerciae.chat-speech-voice';
type Status = 'off' | 'loading' | 'ready' | 'error';
interface SpeechState {
  enabled: boolean; status: Status; progress: number; voice: string; error: string; speaking: boolean;
  toggle: () => void; setVoice: (v: string) => void;
}

let worker: Worker | null = null;
let audio: AudioContext | null = null;
let playing: AudioBufferSourceNode | null = null;
let queue: number[] = [];                        // ids waiting to be played, in order
const ready = new Map<number, AudioBuffer>();    // synthesized, not played yet
let nextId = 1;
let generation = 0;                              // bumped on stop: answers for older lines are dropped
let lastSpeaker: string | null = null;
let loaded = false;                              // the model is in memory in the worker

export const useChatSpeech = create<SpeechState>((set, get) => ({
  enabled: false, status: 'off', progress: 0, error: '', speaking: false,
  voice: (() => { const v = readStorage(VOICE_KEY); return KOKORO_VOICES.some((x) => x.id === v) ? v! : KOKORO_VOICES[0].id; })(),
  toggle: () => {
    if (get().enabled) { stop(); set({ enabled: false, status: 'off', speaking: false }); return; }
    // Created inside the click, so the browser lets it play.
    try { audio ??= new AudioContext(); void audio.resume(); } catch { set({ status: 'error', error: 'This browser cannot play audio.' }); return; }
    set({ enabled: true, status: loaded ? 'ready' : 'loading', progress: 0, error: '' });
    ensureWorker();
    if (!loaded) warmUp();   // also retries a download that failed earlier
  },
  setVoice: (v) => { writeStorage(VOICE_KEY, v); set({ voice: v }); },
}));

function ensureWorker() {
  if (worker) return;
  worker = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const d = e.data;
    if (d.type === 'loading') useChatSpeech.setState({ status: 'loading', progress: d.progress });
    else if (d.type === 'ready') { loaded = true; useChatSpeech.setState({ status: 'ready' }); }
    else if (d.type === 'audio' && d.id > 0 && audio && queue.includes(d.id)) {
      const buffer = audio.createBuffer(1, d.audio.length, d.rate);
      buffer.copyToChannel(d.audio, 0);
      ready.set(d.id, buffer);
      playNext();
    } else if (d.type === 'error') {
      queue = queue.filter((id) => id !== d.id);
      useChatSpeech.setState({ error: d.error, ...(useChatSpeech.getState().status === 'loading' ? { status: 'error' } : {}) });
      playNext();
    }
  };
  worker.onerror = (e) => useChatSpeech.setState({ status: 'error', error: e.message || 'The voice model could not start.' });
}

// Loads the model ahead of the first line, so that line does not wait for the download.
function warmUp() {
  worker?.postMessage({ type: 'speak', id: 0, text: 'Ready.', voice: useChatSpeech.getState().voice, speed: 1 });
}

function playNext() {
  if (playing || !audio || !queue.length) { useChatSpeech.setState({ speaking: !!playing }); return; }
  const buffer = ready.get(queue[0]);
  if (!buffer) return;   // the next line is still being synthesized
  const id = queue.shift()!; ready.delete(id);
  const src = audio.createBufferSource();
  src.buffer = buffer; src.connect(audio.destination);
  const g = generation;
  src.onended = () => { if (g !== generation) return; playing = null; playNext(); };
  playing = src; src.start();
  useChatSpeech.setState({ speaking: true });
}

function stop() {
  generation++;
  queue = []; ready.clear(); lastSpeaker = null;
  try { playing?.stop(); } catch { /* already ended */ }
  playing = null;
}

/** Turns reading off (signing out). */
export function stopChatSpeech() {
  stop();
  useChatSpeech.setState({ enabled: false, status: 'off', speaking: false });
}

/** Queues a chat message to be read aloud, when reading is on and it was posted by someone else in the open window. */
export function speakMessage(m: Message, me: string | undefined, channelId: string | null, windowId: string | null) {
  const s = useChatSpeech.getState();
  if (!s.enabled || !worker || m.author_id === me || m.channel_id !== channelId || m.chat_window_id !== windowId) return;
  const line = spokenLine(m, lastSpeaker);
  if (!line) return;
  lastSpeaker = line.speaker;
  const id = nextId++;
  queue.push(id);
  if (queue.length > 20) { const dropped = queue.shift()!; ready.delete(dropped); }   // far behind: skip the oldest
  worker.postMessage({ type: 'speak', id, text: line.text, voice: s.voice, speed: 1 });
}
