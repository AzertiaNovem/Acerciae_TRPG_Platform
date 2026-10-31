// What the Voice Studio shows for the configured speech service (the backend's provider.features()). Every service
// casts one voice per character; the rest of the panel follows what the service's API really accepts.
export interface TtsParam { key: string; label: string; min: number; max: number; step: number; default: number }
export interface TtsFeatures {
  label: string;
  voice_design: boolean;
  voice_clone: boolean;
  languages: { id: string; label: string }[];
  language_note?: string;
  dialect: { label: string; placeholder: string } | null;
  instructions: boolean;
  instruction_note?: string;
  params: TtsParam[];
  phoneme_dictionary: boolean;
  models: string[];
  highlights: string[];
}

// Display names of the provider ids stored on voice profiles.
export const SERVICE_NAMES: Record<string, string> = { qwen: 'Qwen', openai: 'OpenAI', mock: 'Mock' };

// Before the status arrives: presets only, nothing provider-specific.
export const NO_FEATURES: TtsFeatures = { label: '', voice_design: false, voice_clone: false, languages: [], dialect: null, instructions: false, params: [], phoneme_dictionary: false, models: [], highlights: [] };

// Dictionary text: one entry per line, "term=reading" replaces the word; "term=[pin1 yin1]" is a phonetic reading
// for services that take one (elsewhere it is kept as a plain replacement by the backend).
export type DictEntry = { term: string; reading: string; mode: 'replace' | 'phoneme'; language: string };
export function parseDictionary(text: string, phonetic: boolean): DictEntry[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); const term = l.slice(0, i).trim(); let reading = l.slice(i + 1).trim();
    const m = reading.match(/^\[(.*)\]$/);
    if (m) reading = m[1].trim();
    return { term, reading, mode: m && phonetic ? 'phoneme' : 'replace', language: 'zh' } as DictEntry;
  }).filter((e) => e.term && e.reading);
}
export function formatDictionary(entries: { term: string; reading: string; mode: string }[]): string {
  return entries.map((e) => `${e.term}=${e.mode === 'phoneme' ? `[${e.reading}]` : e.reading}`).join('\n');
}
// A voice's own parameters for the current service, defaults filled in.
export function paramValues(f: TtsFeatures, stored: Record<string, any> | undefined): Record<string, number> {
  return Object.fromEntries(f.params.map((p) => [p.key, typeof stored?.[p.key] === 'number' ? stored[p.key] : p.default]));
}
