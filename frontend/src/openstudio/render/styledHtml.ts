// The styled HTML log: a port of the server's LogStudioService::renderStyledHtml (dark chat-log look, one colour per
// speaker, narration in italics, dice in a monospace chip, scene dividers), extended with what a local project
// knows: the background, the cast and the scene grouping.
import type { CharacterSheet, LogEvent, Project } from '../types';
import { DOCUMENT_CSP, esc } from './escape';
import {
  FONT_MONO, FONT_SANS, characterIndex, displayName, docTitle, groupScenes, isSecret, labelsFor, langOf, makeColors,
  timeLabel, visibleCast, visibleEvents, type RenderLabels, type RenderOptions,
} from './common';
import { avatarHtml, diceChip, mediaHtml } from './parts';

// The server's palette and GM colour.
const PALETTE = ['#7c9cff', '#5bd1b9', '#f0b35b', '#ef6b73', '#c9a4ff', '#6fcf97', '#ff9f6e', '#9ad0ff'] as const;
const GM_COLOR = '#d7b26d';

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{font-family:${FONT_SANS};background:#14171d;color:#e8ebf1;max-width:820px;margin:0 auto;padding:24px 16px 40px;line-height:1.6;font-size:15px;overflow-wrap:anywhere;line-break:strict}
h1{font-size:1.9em;line-height:1.25;margin:.2em 0 .1em}
h2{font-size:1.15em;margin:2em 0 .8em;color:#c5ccd8;letter-spacing:.04em;border-bottom:1px solid #2a2f3a;padding-bottom:6px}
.sub{color:#9aa3b2;margin:0}
.era{display:inline-block;margin-top:8px;color:#d7b26d;border:1px solid #4a4130;border-radius:999px;padding:1px 10px;font-size:13px}
.bg dl{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px}
.bg dt{color:#9aa3b2;font-size:13px;padding-top:2px}
.bg dd{margin:0;white-space:pre-wrap}
.cast-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.cast-card{display:flex;gap:10px;align-items:center;background:#1a1e26;border:1px solid #2a2f3a;border-radius:10px;padding:10px}
.avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;flex:none;background:#232833}
.avatar.initial{display:flex;align-items:center;justify-content:center;color:#14171d;font-weight:700;font-size:20px}
.cast-name{font-weight:600}
.cast-meta{color:#9aa3b2;font-size:12px}
.kind{display:inline-block;font-size:11px;border:1px solid #3a404c;border-radius:4px;padding:0 5px;margin-left:6px;color:#c5ccd8;vertical-align:1px}
.scene-title{margin:34px 0 14px;text-align:center;color:#e8ebf1;font-size:1.1em;letter-spacing:.08em}
.scene{margin:28px 0 14px;text-align:center;color:#9aa3b2;font-variant:small-caps;letter-spacing:.08em;border-top:1px solid #2a2f3a;padding-top:12px;white-space:pre-wrap}
.msg{margin:0 0 10px;display:grid;grid-template-columns:minmax(3em,9em) minmax(0,1fr);gap:8px 12px}
.name{font-weight:600;text-align:right;overflow-wrap:anywhere}
.body{min-width:0}
.text{white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal}
.time{color:#7a8290;font-size:11px;margin-left:6px;white-space:nowrap}
.tag{display:inline-block;font-size:10px;letter-spacing:.06em;border-radius:3px;padding:0 4px;margin-right:6px;vertical-align:2px;border:1px solid currentColor}
.narr .text{font-style:italic;color:#c5ccd8}
.action .text{color:#d9dde6}
.ooc .text{color:#7a8290;font-size:13px}
.ooc .tag{color:#7a8290}
.system .text,.unrecognised .text{color:#8a93a3;font-size:13px}
.dice .text{font-family:${FONT_MONO};background:#1f2430;border-radius:6px;padding:2px 8px;display:inline-block;font-size:13px}
.dice-chip{display:inline-block;margin:4px 0 0;font-family:${FONT_MONO};font-size:13px;background:#232a38;border:1px solid #33405a;color:#dfe6f5;border-radius:6px;padding:1px 8px}
.dice .dice-chip{margin-left:6px}
.dice-chip.ok{border-color:#2f6b4f;color:#8fe0b5}
.dice-chip.fail{border-color:#7a3a3f;color:#ff9aa1}
.secret{border-left:3px solid #ef6b73;padding-left:8px}
.secret .tag{color:#ef6b73}
.media{margin-top:6px;display:flex;flex-wrap:wrap;gap:8px}
.media-img{max-width:100%;max-height:420px;border-radius:6px;display:block}
.media-link{color:#7c9cff}
footer{color:#555;font-size:11px;margin-top:40px}
@media (max-width:560px){.msg{grid-template-columns:minmax(0,1fr);gap:0}.name{text-align:left}}
@media print{:root{color-scheme:light}body{background:#fff;color:#1d232b}.msg{break-inside:avoid}.cast-card{background:#fff}h2,.scene-title{break-after:avoid}}
`;

function messageHtml(e: LogEvent, color: string, name: string, opts: RenderOptions, l: RenderLabels): string {
  const cls = e.type === 'narration' ? 'narr' : e.type === 'dice_roll' ? 'dice' : e.type === 'ooc' ? 'ooc'
    : e.type === 'media' ? 'media-msg' : e.type === 'system' ? 'system' : e.type === 'action' ? 'action' : '';
  const classes = ['msg', cls, isSecret(e) ? 'secret' : '', e.unrecognised ? 'unrecognised' : ''].filter(Boolean).join(' ');
  const tags = (isSecret(e) ? `<span class="tag">${esc(l.secret)}</span>` : '') + (e.type === 'ooc' ? `<span class="tag">${esc(l.ooc)}</span>` : '');
  const t = timeLabel(e, opts.timeZone ?? 'UTC', false);
  const time = t.text ? `<span class="time" title="${esc(t.full)}">${esc(t.text)}</span>` : '';
  const text = e.content ? `<span class="text">${esc(e.content)}</span>` : '';
  const chip = diceChip(e, 'span', 'dice-chip');
  return `<div class="${classes}" id="e${Number.isFinite(e.seq) ? e.seq : 0}"><span class="name" style="color:${color}">${esc(name)}</span>`
    + `<div class="body">${tags}${text}${e.type === 'dice_roll' ? chip : ''}${time}${e.type !== 'dice_roll' && chip ? `<div>${chip}</div>` : ''}${mediaHtml(e, opts.assetUrl, l)}</div></div>`;
}

export function styledHtml(project: Project, opts: RenderOptions): string {
  const l = labelsFor(opts);
  const chars = characterIndex(project);
  const events = visibleEvents(project, !!opts.includeOoc, !!opts.includeSecret);
  const colors = makeColors(chars, PALETTE, () => undefined, GM_COLOR);
  // Colours are handed out in the order speakers first talk, so the cast shows the same colour as the log.
  const lineColors = events.map((e) => (e.type === 'scene_change' ? '' : colors.eventColor(e)));
  const cast = visibleCast(project, events);
  const title = docTitle(project, l);
  const bg = project.background ?? { title: '', era: '', setting: '', summary: '' };

  let html = `<!doctype html><html lang="${esc(langOf(opts))}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="${esc(DOCUMENT_CSP)}">`
    + `<title>${esc(title)}</title><style>${CSS}</style></head><body>`;

  html += `<header><h1>${esc(title)}</h1>`;
  const projectTitle = (project.title ?? '').trim();
  if (projectTitle && projectTitle !== title) html += `<p class="sub">${esc(projectTitle)}</p>`;
  if (bg.era?.trim()) html += `<span class="era">${esc(bg.era.trim())}</span>`;
  html += `</header>`;

  const bgRows: [string, string][] = [[l.era, bg.era], [l.setting, bg.setting], [l.summary, bg.summary]]
    .filter((r): r is [string, string] => typeof r[1] === 'string' && r[1].trim() !== '');
  if (bgRows.length) html += `<section class="bg"><h2>${esc(l.background)}</h2><dl>${bgRows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v.trim())}</dd>`).join('')}</dl></section>`;

  if (cast.length) {
    html += `<section class="cast"><h2>${esc(l.cast)}</h2><ul class="cast-list">`;
    for (const c of cast) html += castCard(c, colors.characterColor(c), opts, l);
    html += `</ul></section>`;
  }

  html += `<main class="log"><h2>${esc(l.log)}</h2>`;
  let i = 0;
  for (const s of groupScenes(events)) {
    html += `<section class="scene-block">`;
    if (s.title) html += `<h3 class="scene-title">${esc(s.title)}</h3>`;
    for (const e of s.events) {
      const color = lineColors[i++];
      if (e.type === 'scene_change') {
        if ((e.content ?? '').trim() && e.content.trim() !== s.title) html += `<div class="scene">${esc(e.content.trim())}</div>`;
        continue;
      }
      html += messageHtml(e, color, displayName(e, chars), opts, l);
    }
    html += `</section>`;
  }
  html += `</main>`;
  html += `<footer>${esc(l.generatedBy)} · ${events.length} ${esc(l.events)} · ${esc(opts.includeSecret ? l.scopeFull : l.scopePlayer)}</footer></body></html>`;
  return html;
}

function castCard(c: CharacterSheet, color: string, opts: RenderOptions, l: RenderLabels): string {
  const meta = c.player?.trim() ? `<div class="cast-meta">${esc(l.player)}: ${esc(c.player.trim())}</div>` : '';
  return `<li class="cast-card">${avatarHtml(c, color, opts.assetUrl, 'avatar')}<div><div class="cast-name"><span style="color:${color}">${esc(c.name)}</span>`
    + `<span class="kind">${esc(l.kind[c.kind] ?? c.kind)}</span></div>${meta}</div></li>`;
}
