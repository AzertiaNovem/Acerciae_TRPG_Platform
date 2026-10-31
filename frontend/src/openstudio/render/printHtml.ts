// The print-ready book: a port of the server PDF worker's template (pdf-worker/src/template.mjs) for the system print
// dialog ("Save as PDF") of the desktop web view. Pure CSS pagination: @page size and margins, margin-box running
// header/footer and page numbers, forced breaks between chapters, no breaks inside a line, headings kept with what
// follows. No script, no external request except the image URLs the caller's assetUrl returns.
import type { PdfConfig } from '../../components/studio/publicationApi';
import type { CharacterSheet, LogEvent, Project } from '../types';
import { DOCUMENT_CSP, cssString, esc, isHexColor, resolveAsset } from './escape';
import {
  FONT_MONO, FONT_SANS, FONT_SERIF, characterIndex, displayName, docTitle, groupScenes, isSecret, labelsFor, langOf,
  makeColors, roleCardRows, timeLabel, visibleCast, visibleEvents, type RenderLabels, type RenderOptions,
} from './common';
import { avatarHtml, diceChip, mediaHtml } from './parts';

export interface PrintOptions extends RenderOptions {
  /** Add the cast chapter with one block per character (portrait, kind, player, appearance, role card). Default true. */
  characterPages?: boolean;
  /** Add the background chapter (era, setting, summary). Default true. */
  backgroundPage?: boolean;
}

// The worker's palette (dark enough for paper).
const PALETTE = ['#355c68', '#894c38', '#3e6b45', '#785781', '#8a5d16'] as const;

/** Page sizes in millimetres (portrait). Explicit lengths print the same in WebKit and Chromium. */
const PAGE_MM: Record<string, [number, number]> = { A4: [210, 297], A5: [148, 210], B5: [176, 250] };

const pick = (v: unknown, allowed: readonly string[], fallback: string) => (typeof v === 'string' && allowed.includes(v) ? v : fallback);
const num = (v: unknown, fallback: number, low: number, high: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 1000) : '');
const strMap = (v: unknown, valid: (s: string) => boolean): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string' && valid(x)) out[k] = x;
  return out;
};

/**
 * The same defaults and bounds as the server's PublicationService::validateConfig, except that an out-of-range or
 * unknown value falls back/clamps instead of failing (a local preview should always render).
 */
export function normalizePdfConfig(input?: Partial<PdfConfig> | null): PdfConfig {
  const c = (input ?? {}) as Partial<Record<keyof PdfConfig, unknown>>;
  return {
    base: pick(c.base, ['classic', 'dossier', 'novel'], 'classic'),
    page_size: pick(c.page_size, ['A4', 'A5', 'B5'], 'A5'),
    orientation: pick(c.orientation, ['portrait', 'landscape'], 'portrait'),
    font: pick(c.font, ['serif', 'sans'], 'serif'),
    dice_style: pick(c.dice_style, ['box', 'inline', 'hide'], 'box'),
    font_size: num(c.font_size, 11, 8, 24),
    line_height: num(c.line_height, 1.7, 1, 2.5),
    margin_mm: num(c.margin_mm, 18, 8, 40),
    include_ooc: bool(c.include_ooc, false),
    timestamps: bool(c.timestamps, false),
    toc: bool(c.toc, true),
    page_numbers: bool(c.page_numbers, true),
    chapter_breaks: bool(c.chapter_breaks, true),
    title: text(c.title),
    subtitle: text(c.subtitle),
    header: text(c.header),
    footer: text(c.footer),
    cover_asset_id: text(c.cover_asset_id),
    scene_images: strMap(c.scene_images, (s) => s.trim() !== ''),
    character_colors: strMap(c.character_colors, isHexColor),
  };
}

/** A built-in template ("classic", "dossier" or "novel") with the server's defaults. */
export const defaultPdfConfig = (base: 'classic' | 'dossier' | 'novel' = 'classic'): PdfConfig => normalizePdfConfig({ base });

function css(c: PdfConfig, pageW: number, pageH: number): string {
  const m = c.margin_mm;
  const contentH = pageH - 2 * m;
  const font = c.font === 'sans' ? FONT_SANS : FONT_SERIF;
  const box = (content: string) => `content:${content};font-family:${FONT_SANS};font-size:8pt;color:#6b767d;`;
  const marginBoxes = [
    c.header.trim() ? `@top-center{${box(cssString(c.header))}}` : '',
    c.footer.trim() ? `@bottom-left{${box(cssString(c.footer))}}` : '',
    c.page_numbers ? `@bottom-center{${box('counter(page)')}}` : '',
  ].join('');
  const blank = [c.header.trim() ? '@top-center{content:none}' : '', c.footer.trim() ? '@bottom-left{content:none}' : '', c.page_numbers ? '@bottom-center{content:none}' : ''].join('');
  const theme = c.base === 'dossier'
    ? `body,html{background:#faf7ed}@page{background:#faf7ed}h2{text-transform:uppercase;letter-spacing:.06em}article{border-bottom:1px dotted #c5bfa9;padding-bottom:3mm}.cover{border:2px solid #788678;padding:10mm}.char{border:1px solid #d6cfb6}`
    : c.base === 'novel'
      ? `.who{font-size:85%}.speech{text-indent:1em}article{margin-bottom:5mm}h2{text-align:center;border:0;margin:18mm 0 10mm}.chapter-head{text-align:center}`
      : '';
  return `
@page{size:${pageW}mm ${pageH}mm;margin:${m}mm;${marginBoxes}}
@page:first{${blank}}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:${font};font-size:${c.font_size}pt;line-height:${c.line_height};color:#243139;line-break:strict;overflow-wrap:anywhere;word-break:normal;orphans:3;widows:3}
h1,h2,h3{line-height:1.3;break-after:avoid;page-break-after:avoid;font-weight:700}
h2{font-size:1.45em;border-bottom:1px solid #8c9c9e;padding-bottom:3mm;margin:0 0 6mm}
p,article{orphans:3;widows:3}
img{max-width:100%;max-height:${Math.round(contentH * 0.6)}mm;object-fit:contain;display:block;margin:5mm auto}
.cover{height:${Math.floor(contentH - 2)}mm;display:flex;flex-direction:column;justify-content:center;break-after:page;page-break-after:always;overflow:hidden}
.cover img{max-height:${Math.round(contentH * 0.45)}mm;margin:0 auto 8mm}
.cover h1{font-size:28pt;margin:0 0 4mm}
.cover .subtitle{font-size:1.2em;margin:0 0 3mm;color:#46545c}
.cover .era{margin:0 0 3mm;color:#6b5a32;letter-spacing:.05em}
.cover small{color:#6b767d;font-family:${FONT_SANS};font-size:8pt;margin-top:6mm}
nav.toc{break-after:page;page-break-after:always}
nav.toc ol{list-style:none;padding:0;margin:0}
nav.toc li{margin:3mm 0;border-bottom:1px dotted #b8c1c3}
nav.toc a{color:inherit;text-decoration:none}
.chapter{break-before:page;page-break-before:always}
.flow{break-before:auto;page-break-before:auto;margin-top:10mm}
.keep{break-inside:avoid;page-break-inside:avoid}
.bg dl{margin:0}
.bg dt{font-weight:700;margin-top:4mm;color:#46545c}
.bg dd{margin:1mm 0 0;white-space:pre-wrap}
.char{display:flex;gap:5mm;align-items:flex-start;margin:0 0 6mm;padding:4mm;border:1px solid #d4dadb;border-radius:2mm;break-inside:avoid;page-break-inside:avoid}
.char .portrait{width:30mm;height:40mm;object-fit:cover;margin:0;flex:none;border-radius:1.5mm;background:#eef1f1}
.char .portrait.initial{display:flex;align-items:center;justify-content:center;color:#fff;font-size:20pt;font-weight:700}
.char h3{margin:0 0 1mm;font-size:1.2em}
.char .meta{font-family:${FONT_SANS};font-size:8.5pt;color:#5d6a71;margin:0 0 2mm}
.char .appearance{white-space:pre-wrap;margin:0 0 2mm;font-size:.95em}
.char table{border-collapse:collapse;font-size:8.5pt;font-family:${FONT_SANS}}
.char td{padding:.4mm 3mm .4mm 0;vertical-align:top}
.char td:first-child{color:#5d6a71;white-space:nowrap}
.kind{display:inline-block;border:1px solid currentColor;border-radius:1mm;padding:0 1.2mm;font-size:7.5pt;margin-left:2mm;vertical-align:1pt;font-family:${FONT_SANS};font-weight:400}
article{margin:0 0 4mm;break-inside:avoid;page-break-inside:avoid}
.speaker{font-weight:600}
.speech{white-space:pre-wrap}
time{font:7pt ${FONT_SANS};color:#667;float:right;margin-left:3mm}
.tag{font:7pt ${FONT_SANS};letter-spacing:.06em;border:1px solid currentColor;border-radius:1mm;padding:0 1mm;margin-left:2mm;vertical-align:1pt}
.dice{display:block;font-size:9pt;font-family:${FONT_MONO};background:#eef1ec;padding:1.5mm 3mm;margin-top:1mm;border-left:2px solid #81998b;white-space:pre-wrap;break-inside:avoid}
.dice.ok{border-left-color:#3e6b45}.dice.fail{border-left-color:#894c38}
.dice-inline{font-family:${FONT_MONO};font-size:.9em;color:#3e5560;margin-left:1.5mm}
.ooc{color:#6a737c;font-size:90%}
.secret{border-left:2px solid #a34a4a;padding-left:3mm}
.secret .tag{color:#a34a4a}
.narration .speaker{font-style:italic}
.narration .speech{font-style:italic}
.system,.unrecognised{color:#6a737c;font-size:90%}
.scene-break{text-align:center;color:#6b767d;letter-spacing:.08em;margin:6mm 0;break-after:avoid;page-break-after:avoid;white-space:pre-wrap}
.scene-break::before,.scene-break::after{content:"  ·  ·  ·  "}
.media{margin-top:1mm}
.media-img{margin:2mm 0}
.media-link{color:#355c68;font-size:.9em}
${theme}
@media screen{html{background:#d9dcdf}body{width:${pageW}mm;min-height:${pageH}mm;margin:8mm auto;padding:${m}mm;background:${c.base === 'dossier' ? '#faf7ed' : '#fff'};box-shadow:0 1px 6px rgba(0,0,0,.25)}}
`;
}

function articleHtml(e: LogEvent, color: string, name: string, c: PdfConfig, opts: RenderOptions, l: RenderLabels): string {
  const cls = [e.type, isSecret(e) ? 'secret' : '', e.unrecognised ? 'unrecognised' : ''].filter(Boolean).join(' ');
  const t = c.timestamps ? timeLabel(e, opts.timeZone ?? 'UTC', true) : null;
  const tags = (isSecret(e) ? `<span class="tag">${esc(l.secret)}</span>` : '') + (e.type === 'ooc' ? `<span class="tag">${esc(l.ooc)}</span>` : '');
  const inline = c.dice_style === 'inline' ? diceChip(e, 'span', 'dice-inline') : '';
  const boxed = c.dice_style === 'box' ? diceChip(e, 'aside', 'dice') : '';
  return `<article class="${esc(cls)}"><div class="who"><span class="speaker" style="color:${color}">${esc(name)}</span>${tags}`
    + `${t && t.text ? `<time title="${esc(t.full)}">${esc(t.text)}</time>` : ''}</div>`
    + `<div class="speech">${esc(e.content)}${inline}</div>${boxed}${mediaHtml(e, opts.assetUrl, l)}</article>`;
}

function characterBlock(ch: CharacterSheet, color: string, opts: RenderOptions, l: RenderLabels): string {
  const meta = [l.kind[ch.kind] ?? ch.kind, ch.player?.trim() ? `${l.player}: ${ch.player.trim()}` : ''].filter(Boolean).join(' · ');
  const rows = roleCardRows(ch.role_card);
  return `<div class="char">${avatarHtml(ch, color, opts.assetUrl, 'portrait', true)}<div class="char-body">`
    + `<h3 style="color:${color}">${esc(ch.name)}</h3><p class="meta">${esc(meta)}</p>`
    + (ch.appearance?.trim() ? `<p class="appearance">${esc(ch.appearance.trim())}</p>` : '')
    + (rows.length ? `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : '')
    + `</div></div>`;
}

export function printHtml(project: Project, config: PdfConfig, opts: PrintOptions): string {
  const c = normalizePdfConfig(config);
  const l = labelsFor(opts);
  const [pw, ph] = PAGE_MM[c.page_size] ?? PAGE_MM.A5;
  const [pageW, pageH] = c.orientation === 'landscape' ? [ph, pw] : [pw, ph];
  const chars = characterIndex(project);
  // OOC lines need both the export option and the template's include_ooc; secret lines need includeSecret.
  const events = visibleEvents(project, !!opts.includeOoc && c.include_ooc, !!opts.includeSecret);
  const colors = makeColors(chars, PALETTE, (k) => c.character_colors[k]);
  const lineColors = events.map((e) => (e.type === 'scene_change' ? '' : colors.eventColor(e)));
  const sections = groupScenes(events);
  const bg = project.background ?? { title: '', era: '', setting: '', summary: '' };
  const title = c.title.trim() || docTitle(project, l);
  const cast = opts.characterPages === false ? [] : visibleCast(project, events);
  const bgRows: [string, string][] = opts.backgroundPage === false ? [] : ([[l.era, bg.era], [l.setting, bg.setting], [l.summary, bg.summary]] as [string, unknown][])
    .filter((r): r is [string, string] => typeof r[1] === 'string' && r[1].trim() !== '');

  let html = `<!doctype html><html lang="${esc(langOf(opts))}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${esc(DOCUMENT_CSP)}">`
    + `<title>${esc(title)}</title><style>${css(c, pageW, pageH)}</style></head><body class="${esc(c.base)}">`;

  // Cover.
  const cover = resolveAsset(c.cover_asset_id || null, opts.assetUrl);
  html += `<section class="cover">${cover ? `<img src="${esc(cover)}" alt="">` : ''}<h1>${esc(title)}</h1>`
    + (c.subtitle.trim() ? `<p class="subtitle">${esc(c.subtitle.trim())}</p>` : '')
    + (bg.era?.trim() ? `<p class="era">${esc(bg.era.trim())}</p>` : '')
    + `<small>${esc(l.generatedBy)} · ${esc(opts.includeSecret ? l.scopeFull : l.scopePlayer)} · ${events.length} ${esc(l.events)}</small></section>`;

  const sectionTitle = (s: { title: string }) => s.title || l.log;
  if (c.toc) {
    const items: string[] = [];
    if (bgRows.length) items.push(`<li><a href="#bg">${esc(l.background)}</a></li>`);
    if (cast.length) items.push(`<li><a href="#cast">${esc(l.cast)}</a></li>`);
    sections.forEach((s, i) => items.push(`<li><a href="#s${i}">${esc(sectionTitle(s))}</a></li>`));
    html += `<nav class="toc" role="doc-toc"><h2>${esc(l.contents)}</h2><ol>${items.join('')}</ol></nav>`;
  }

  if (bgRows.length) html += `<section class="chapter bg" id="bg"><h2>${esc(l.background)}</h2><dl>${bgRows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v.trim())}</dd>`).join('')}</dl></section>`;

  if (cast.length) {
    // Characters first get colours in log order, so the cast and the log agree.
    html += `<section class="chapter cast" id="cast"><h2>${esc(l.cast)}</h2>${cast.map((ch) => characterBlock(ch, colors.characterColor(ch), opts, l)).join('')}</section>`;
  }

  let n = 0;
  sections.forEach((s, i) => {
    // The log always starts on a fresh page; later scenes only with chapter_breaks.
    const cls = i === 0 || c.chapter_breaks ? 'chapter' : 'chapter flow';
    const imgRef = c.scene_images[s.key];
    const img = imgRef ? resolveAsset(imgRef, opts.assetUrl) : null;
    const parts: string[] = [];
    for (const e of s.events) {
      const color = lineColors[n++];
      if (e.type === 'scene_change') {
        if ((e.content ?? '').trim() && e.content.trim() !== s.title) parts.push(`<p class="scene-break">${esc(e.content.trim())}</p>`);
        continue;
      }
      parts.push(articleHtml(e, color, displayName(e, chars), c, opts, l));
    }
    // The heading, its illustration and the first line stay on one page.
    const head = `<h2 class="chapter-head">${esc(sectionTitle(s))}</h2>${img ? `<img src="${esc(img)}" alt="">` : ''}`;
    html += `<section class="${cls}" id="s${i}"><div class="keep">${head}${parts.shift() ?? ''}</div>${parts.join('')}</section>`;
  });

  // The attribution sits on the cover: a closing line could spill onto a page of its own.
  html += `</body></html>`;
  return html;
}
