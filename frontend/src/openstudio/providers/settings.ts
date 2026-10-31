// Which AI services Open Log Studio uses, with the user's own keys. Settings live on this device; keys in the
// system keychain (never in the settings or a project).
import { readJson } from '../../lib/storage';
import { writeStorage } from '../../lib/storage';

export type LlmProvider = 'none' | 'openai' | 'anthropic';
export type ImageProvider = 'none' | 'openai';
export type TtsProvider = 'none' | 'openai' | 'qwen';
export interface AiSettings {
  llm: { provider: LlmProvider; base_url: string; model: string };
  image: { provider: ImageProvider; base_url: string; model: string; size: '1024x1024' | '1536x1024' | '1024x1536'; quality: 'auto' | 'low' | 'medium' | 'high' };
  tts: { provider: TtsProvider; base_url: string; model: string; language: string };
}
export const KEY_NAMES = { llm: 'openstudio-llm-key', image: 'openstudio-image-key', tts: 'openstudio-tts-key' } as const;

// Each service's usual address and model; any OpenAI-compatible address works (DeepSeek, OpenRouter, a local server…).
export const DEFAULTS = {
  llm: { openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' }, anthropic: { base_url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' } },
  image: { openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-image-1' } },
  tts: { openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts' }, qwen: { base_url: 'https://dashscope.aliyuncs.com', model: 'qwen-audio-3.1-tts-plus' } },
} as const;

const STORE = 'acerciae.openstudio.ai';
const empty: AiSettings = {
  llm: { provider: 'none', base_url: '', model: '' },
  image: { provider: 'none', base_url: '', model: '', size: '1024x1536', quality: 'auto' },
  tts: { provider: 'none', base_url: '', model: '', language: 'auto' },
};
export function loadAiSettings(): AiSettings {
  const s = readJson<Partial<AiSettings>>(STORE, {});
  return { llm: { ...empty.llm, ...s.llm }, image: { ...empty.image, ...s.image }, tts: { ...empty.tts, ...s.tts } };
}
export function saveAiSettings(s: AiSettings) { writeStorage(STORE, JSON.stringify(s)); }

// Voices the services offer (neither lists them through its API).
export const TTS_VOICES: Record<Exclude<TtsProvider, 'none'>, { id: string; label: string }[]> = {
  openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((id) => ({ id, label: id })),
  qwen: [{ id: 'longanhuan_v3.1', label: 'Anhuan (zh, female)' }, { id: 'longanlingxin_v3.1', label: 'Lingxin (zh, female)' }, { id: 'xunanchuan_v3.1', label: 'Nanchuan (zh, male)' }, { id: 'longanfengyue_v3.1', label: 'Fengyue (zh, female)' }],
};
