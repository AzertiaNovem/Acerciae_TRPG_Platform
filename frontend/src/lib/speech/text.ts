// What the chat's read-aloud says for a message. Two Kokoro models are used, chosen by the server language its
// maintainers set: the Mandarin one (v1.1-zh, @uzen/kokoro-js) for Chinese servers, which also reads English spans,
// and the English one (kokoro-js) for every other language. Text a model cannot say (other scripts) is left out, a line
// with nothing left is skipped, and markup, links and dice commands are not read.
import type { Message } from '../../types';

export type SpeechModel = 'en' | 'zh';
export const MAX_SPOKEN = 1000;

/** The model for a server language: Chinese (simplified or traditional) → zh, anything else → en. */
export function modelForLanguage(language: string | null | undefined): SpeechModel {
  return /^zh\b/i.test(language ?? '') ? 'zh' : 'en';
}

const EN_KEEP = /[^\p{Script=Latin}\p{N}\s.,;:!?'"()\-–—…%&/+=@$€£]/gu;
const ZH_KEEP = /[^\p{Script=Han}\p{Script=Latin}\p{N}\s.,;:!?'"()\-–—…%&/+=@$€£¥，。！？、；：“”‘’（）《》〈〉「」『』【】～·]/gu;

/** The words of a chat line the model can say: links, CQ codes and markdown dropped, scripts it cannot read removed. */
export function speakableText(raw: string, model: SpeechModel = 'en'): string {
  return raw
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_~`#>|]+/g, ' ')
    .replace(model === 'zh' ? ZH_KEEP : EN_KEEP, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SAYABLE: Record<SpeechModel, RegExp> = { en: /\p{Script=Latin}|\p{N}/u, zh: /\p{Script=Han}|\p{Script=Latin}|\p{N}/u };

export interface Spoken { text: string; speaker: string }

/**
 * The utterance for a message, or null when there is nothing to say. The speaker is named when it changes from the
 * previous line read aloud (`previous`); narration is read without a name. Dice read their result, not the command.
 */
export function spokenLine(m: Message, previous: string | null, model: SpeechModel = 'en'): Spoken | null {
  if (m.kind === 'system') return null;
  const narration = m.kind === 'narration';
  const speaker = narration ? '' : m.kind === 'ooc' ? m.author_name : m.character_name ?? m.author_name;
  const body = speakableText(m.dice?.text ? String(m.dice.text) : m.content, model);
  if (!SAYABLE[model].test(body)) return null;
  const name = speakableText(speaker ?? '', model);
  const prefix = !narration && name && speaker !== previous ? `${name}${model === 'zh' ? '：' : ': '}` : '';
  const text = (prefix + body).slice(0, MAX_SPOKEN);
  return { text, speaker: speaker ?? '' };
}

export interface Voice { id: string; label: string; female: boolean }
const v = (id: string, label: string): Voice => ({ id, label, female: id[1] === 'f' });

/** Each model's voices, the default first: English (American and British) and Mandarin (numbered speakers). */
export const VOICES: Record<SpeechModel, Voice[]> = {
  en: [
    ['af_heart', 'Heart'], ['af_bella', 'Bella'], ['af_nicole', 'Nicole'], ['af_sarah', 'Sarah'], ['af_sky', 'Sky'], ['af_nova', 'Nova'],
    ['am_michael', 'Michael'], ['am_fenrir', 'Fenrir'], ['am_puck', 'Puck'], ['am_adam', 'Adam'], ['am_eric', 'Eric'], ['am_onyx', 'Onyx'],
    ['bf_emma', 'Emma (UK)'], ['bf_isabella', 'Isabella (UK)'], ['bf_alice', 'Alice (UK)'], ['bm_george', 'George (UK)'], ['bm_fable', 'Fable (UK)'], ['bm_lewis', 'Lewis (UK)'],
  ].map(([id, label]) => v(id, label)),
  zh: [
    ...['001', '002', '003', '004', '005', '006', '007', '008', '017', '018', '019', '021'].map((n) => v(`zf_${n}`, n)),
    ...['009', '010', '011', '012', '013', '014', '015', '016', '020', '025', '029', '030'].map((n) => v(`zm_${n}`, n)),
  ],
};
/** Kept for callers of the English list. */
export const KOKORO_VOICES = VOICES.en;
