// HTML fragments both documents use.
import type { CharacterSheet, LogEvent } from '../types';
import { esc, resolveAsset, safeUrl } from './escape';
import { diceSummary, outcomeClass, type RenderLabels } from './common';

/** Images inline; audio and other files as a labelled link (no players, no scripts). */
export function mediaHtml(e: LogEvent, assetUrl: (ref: string) => string | null, l: RenderLabels): string {
  if (!Array.isArray(e.media) || !e.media.length) return '';
  const out: string[] = [];
  for (const m of e.media) {
    const src = resolveAsset(m.file ?? null, assetUrl) ?? (m.url && /^https?:\/\//i.test(m.url) ? safeUrl(m.url) : null);
    const shown = m.file ?? (m.url && /^https?:\/\//i.test(m.url) ? m.url.split(/[?#]/)[0] : '');
    const name = shown.split(/[\\/]/).pop() ?? '';
    if (m.kind === 'image' && src) out.push(`<img class="media-img" src="${esc(src)}" alt="${esc(l.image)}">`);
    else {
      const label = `${m.kind === 'audio' ? l.audio : m.kind === 'image' ? l.image : l.attachment}${name ? `: ${name}` : ''}`;
      out.push(src ? `<a class="media-link" href="${esc(src)}" rel="noopener noreferrer">${esc(label)}</a>` : `<span class="media-link">${esc(label)}</span>`);
    }
  }
  return `<div class="media">${out.join('')}</div>`;
}

/** The structured dice result as a chip: check, expression, rolls, total, outcome. */
export function diceChip(e: LogEvent, tag: 'span' | 'aside', cls: string): string {
  if (!e.dice) return '';
  const text = diceSummary(e.dice);
  if (!text) return '';
  const oc = outcomeClass(e.dice.outcome);
  return `<${tag} class="${cls}${oc ? ` ${oc}` : ''}">${esc(text)}</${tag}>`;
}

export function avatarHtml(c: CharacterSheet, color: string, assetUrl: (ref: string) => string | null, cls: string, preferPortrait = false): string {
  const src = preferPortrait ? resolveAsset(c.portrait, assetUrl) ?? resolveAsset(c.avatar, assetUrl) : resolveAsset(c.avatar, assetUrl) ?? resolveAsset(c.portrait, assetUrl);
  if (src) return `<img class="${cls}" src="${esc(src)}" alt="${esc(c.name)}">`;
  const initial = [...(c.name || '?').trim()][0] ?? '?';
  return `<span class="${cls} initial" style="background:${color}" aria-hidden="true">${esc(initial)}</span>`;
}
