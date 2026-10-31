// The text formats (story-painter semantics): a header line starts a message; every line up to the next header
// belongs to it; text before the first header is kept as a leading, unrecognised note. Port of parseHeaderFormat
// and the SealDice text / rendered / QQ adapters in LogAdapters.cpp.
import type { ImportIssue, LogEvent, ParsedLog } from '../types';
import { classifyMessage, extractCqMedia, parseDice } from './classify';
import { SpeakerTable } from './speakers';
import { asciiTrim, parseTime, truncateUtf8 } from './util';
import type { LogAdapter } from './adapter';

interface Header { nick: string; identity: string | null; timeStr: string; inlineMsg: string }
type Extract = (m: RegExpExecArray) => Header;

function splitLines(text: string): string[] {
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// detect(): how many of the first ~400 lines are headers.
function headerHits(text: string, header: RegExp): number {
  let hits = 0, lines = 0, start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    let line = nl < 0 ? text.slice(start) : text.slice(start, nl);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (header.test(line)) hits++;
    if (nl < 0 || ++lines > 400) break;
    start = nl + 1;
  }
  return hits;
}

// Finishes a message event the way the server's finishEvent does: media, role, type, dice.
export function finishEvent(e: LogEvent): void {
  const { media } = extractCqMedia(e.content);
  if (media) e.media = media;
  const isDice = e.role === 'dice';
  e.type = classifyMessage(e.content, isDice, e.role === 'gm');
  if (e.role === 'hidden') e.type = e.type === 'ooc' ? 'ooc' : 'secret';
  if (e.type === 'dice_roll' || isDice) { const d = parseDice(e.content); if (d) e.dice = d; }
}

export function blankEvent(adapter: ParsedLog['adapter'], file: string, line: number): LogEvent {
  return {
    seq: 0, type: 'dialogue', content: '', speaker_key: '', speaker_name: '', role: 'pc', time: null, time_text: '',
    scene_title: '', window: '', dice: null, media: null, raw: '', unrecognised: false, source: { file, adapter, line },
  };
}

export function parseHeaderFormat(text: string, header: RegExp, adapter: ParsedLog['adapter'], extract: Extract, file: string): ParsedLog {
  const speakers = new SpeakerTable();
  const lines = splitLines(text);
  const events: LogEvent[] = [];
  let last: LogEvent | null = null, startText = '';
  for (let i = 0; i < lines.length; i++) {
    const more = i + 1 < lines.length;
    const m = header.exec(lines[i]);
    const h = m ? extract(m) : null;
    // A header with an empty nickname is not a header (the server skipped such lines; here they stay as text).
    if (h && h.nick) {
      const e = blankEvent(adapter, file, i + 1);
      e.speaker_name = h.nick;
      e.speaker_key = speakers.add(h.nick, h.identity, false);
      const ts = parseTime(h.timeStr);
      if (ts !== null) e.time = ts; else e.time_text = h.timeStr;
      e.content = h.inlineMsg + (h.inlineMsg && more ? '\n' : '');
      e.raw = lines[i];
      events.push(e); last = e;
      continue;
    }
    if (last) { last.content += lines[i] + (more ? '\n' : ''); last.raw += '\n' + lines[i]; }
    else startText += lines[i] + '\n';
  }
  for (const e of events) { e.role = speakers.get(e.speaker_key)?.role ?? 'pc'; finishEvent(e); }
  // Dice bots: a speaker whose messages (two or more) are at least 80% dice results is a dice bot.
  for (const sp of speakers.list()) {
    const mine = events.filter((e) => e.speaker_key === sp.key);
    const diceLike = mine.filter((e) => e.dice && e.dice.total !== null).length;
    if (mine.length >= 2 && Math.floor((diceLike * 100) / mine.length) >= 80) {
      speakers.setRole(sp.key, 'dice');
      for (const e of mine) { e.role = 'dice'; if (e.type !== 'dice_roll') e.type = e.dice ? 'dice_roll' : 'system'; }
    }
  }
  const issues: ImportIssue[] = [];
  if (asciiTrim(startText)) {
    issues.push({ file, line: 1, raw: truncateUtf8(startText, 200), reason: 'text before the first recognised message was kept as a leading note', severity: 'warning' });
    const e = blankEvent(adapter, file, 1);
    Object.assign(e, { type: 'system', role: 'system', content: startText, raw: startText, unrecognised: true });
    events.unshift(e);
  }
  events.forEach((e, i) => { e.seq = i + 1; });
  return { adapter, format_version: '', events, speakers: speakers.list(), issues };
}

// The id in brackets only tells speakers apart; it never becomes part of a key or a name.
function bracketed(s: string | undefined): string | null {
  return s ? s.slice(1, -1) : null;
}

// SealDice text export / story-painter editor format: "Nick(12345) 2026/10/02 21:41:06" (date optional, "#n" tolerated).
const SEALDICE_TEXT_HEADER = /^([^(<\n]+?)(?:\(([^(\n]+)\)|<([^(\n]+)>)?\s+(\d{4}\/\d{1,2}\/\d{1,2} )?(\d{1,2}:\d{1,2}:\d{2})( #\d+)?\s*$/;
export const sealDiceTextAdapter: LogAdapter = {
  name: 'sealdice_text',
  supportedVersions: "SealDice text log / story-painter editor format: 'nickname(IMUserId) YYYY/MM/DD HH:MM:SS' header lines (date optional, '#n' suffix tolerated)",
  detect: (t) => headerHits(t, SEALDICE_TEXT_HEADER) >= 1,
  parse: (t, file = '') => parseHeaderFormat(t, SEALDICE_TEXT_HEADER, 'sealdice_text', (m) => ({
    nick: asciiTrim(m[1]), identity: m[2] ?? m[3] ?? null, timeStr: asciiTrim((m[4] ?? '') + m[5]), inlineMsg: '',
  }), file),
};

// story-painter rendered export: "[YYYY/MM/DD ]HH:MM:SS<nick[(QQ)]>:message" (time optional).
const RENDERED_HEADER = /^((?:\d{4}\/\d{2}\/\d{2}\s)?\d{2}:\d{2}:\d{2})?<(.+?)(\([^)]+\))?>:(.*)$/;
export const renderedLogAdapter: LogAdapter = {
  name: 'rendered_log',
  supportedVersions: "story-painter rendered text export: '[date ]HH:MM:SS<nickname(QQ)>:message' lines",
  detect: (t) => headerHits(t, RENDERED_HEADER) >= 2,
  parse: (t, file = '') => parseHeaderFormat(t, RENDERED_HEADER, 'rendered_log', (m) => ({
    nick: asciiTrim(m[2]), identity: bracketed(m[3]), timeStr: m[1] ?? '', inlineMsg: m[4],
  }), file),
};

// QQ chat export: "YYYY-MM-DD HH:MM:SS nickname(QQ)" (or "<id>") header, message on the following lines.
const QQ_HEADER = /^(\d{4}-\d{2}-\d{2} \d{1,2}:\d{1,2}:\d{1,2})\s+(.+?)(\([^)]+\)|<[^>]+>)$/;
export const qqExportAdapter: LogAdapter = {
  name: 'qq_export',
  supportedVersions: "QQ chat export: 'YYYY-MM-DD HH:MM:SS nickname(QQ)' header lines",
  detect: (t) => headerHits(t, QQ_HEADER) >= 1,
  parse: (t, file = '') => parseHeaderFormat(t, QQ_HEADER, 'qq_export', (m) => ({
    nick: asciiTrim(m[2]), identity: bracketed(m[3]), timeStr: m[1], inlineMsg: '',
  }), file),
};
