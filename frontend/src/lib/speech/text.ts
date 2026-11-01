// What the chat's read-aloud says for a message. Kokoro's voices speak English only, so text in other scripts is left
// out (a line with no Latin letters left is skipped), and markup, links and dice commands are not read.
import type { Message } from '../../types';

export const MAX_SPOKEN = 1000;

/** The words of a chat line Kokoro can say: links, CQ codes and markdown dropped, non-Latin scripts removed. */
export function speakableText(raw: string): string {
  return raw
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_~`#>|]+/g, ' ')
    // Keep Latin letters (with accents), digits, spaces and common punctuation; everything else is not English.
    .replace(/[^\p{Script=Latin}\p{N}\s.,;:!?'"()\-–—…%&/+=@$€£]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Spoken { text: string; speaker: string }

/**
 * The utterance for a message, or null when there is nothing to say. The speaker is named when it changes from the
 * previous line read aloud (`previous`); narration is read without a name. Dice read their result, not the command.
 */
export function spokenLine(m: Message, previous: string | null): Spoken | null {
  if (m.kind === 'system') return null;
  const narration = m.kind === 'narration';
  const speaker = narration ? '' : m.kind === 'ooc' ? m.author_name : m.character_name ?? m.author_name;
  const body = speakableText(m.dice?.text ? String(m.dice.text) : m.content);
  if (!/\p{Script=Latin}|\p{N}/u.test(body)) return null;
  const name = speakableText(speaker ?? '');
  const prefix = !narration && name && speaker !== previous ? `${name}: ` : '';
  const text = (prefix + body).slice(0, MAX_SPOKEN);
  return { text, speaker: speaker ?? '' };
}

/** The Kokoro voices (American and British English). The first is the default. */
export const KOKORO_VOICES: { id: string; label: string }[] = [
  ['af_heart', 'Heart'], ['af_bella', 'Bella'], ['af_nicole', 'Nicole'], ['af_sarah', 'Sarah'], ['af_sky', 'Sky'], ['af_nova', 'Nova'],
  ['am_michael', 'Michael'], ['am_fenrir', 'Fenrir'], ['am_puck', 'Puck'], ['am_adam', 'Adam'], ['am_eric', 'Eric'], ['am_onyx', 'Onyx'],
  ['bf_emma', 'Emma (UK)'], ['bf_isabella', 'Isabella (UK)'], ['bf_alice', 'Alice (UK)'], ['bm_george', 'George (UK)'], ['bm_fable', 'Fable (UK)'], ['bm_lewis', 'Lewis (UK)'],
].map(([id, label]) => ({ id, label }));
