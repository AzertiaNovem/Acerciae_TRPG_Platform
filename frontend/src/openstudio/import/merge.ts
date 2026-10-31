// Several logs of one campaign connected together: one ordered, de-duplicated event list.
import type { ImportIssue, LogEvent, ParsedLog, Speaker } from '../types';

export interface LogFile { file: string; log: ParsedLog }
export interface MergedLog { events: LogEvent[]; speakers: Speaker[]; issues: ImportIssue[] }

interface Item { e: LogEvent; file: number; index: number; sortTime: number }

function dedupKey(e: LogEvent): string {
  // Exports of the same chat differ in trailing blank lines and line endings; nothing else is forgiven.
  const content = e.content.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return [e.speaker_name, e.time === null ? '' : String(e.time), e.time === null ? e.time_text : '', content].join('\u0000');
}

// Order: when every message has a time, by time (ties keep file order: file after file, line after line);
// otherwise file after file. An unrecognised note without a time (the text before a log's first message) travels
// with the next message of its file. Duplicates that overlapping exports produce (same speaker name, time and
// content) are dropped; a file that itself repeats a line keeps its repeats. seq is renumbered from 1, source.file
// is set on every event, and speakers are merged by key (a role other than "pc" wins over "pc").
export function mergeLogs(parsed: LogFile[]): MergedLog {
  const items: Item[] = [];
  const issues: ImportIssue[] = [];
  parsed.forEach(({ file, log }, fi) => {
    const own: Item[] = log.events.map((ev, index) => ({ e: { ...ev, source: { ...ev.source, file } }, file: fi, index, sortTime: ev.time ?? NaN }));
    // Untimed notes take the time of the next timed event of their file (or the previous one at the end).
    let next = NaN;
    for (let i = own.length - 1; i >= 0; i--) { if (own[i].e.time !== null) next = own[i].e.time as number; else own[i].sortTime = next; }
    let prev = NaN;
    for (const it of own) { if (it.e.time !== null) prev = it.e.time; else if (Number.isNaN(it.sortTime)) it.sortTime = prev; }
    items.push(...own);
    for (const is of log.issues) issues.push({ ...is, file });
  });

  const timed = items.every((it) => it.e.time !== null || it.e.unrecognised) && items.some((it) => it.e.time !== null);
  if (timed) {
    items.sort((a, b) => {
      const ta = Number.isNaN(a.sortTime) ? -Infinity : a.sortTime, tb = Number.isNaN(b.sortTime) ? -Infinity : b.sortTime;
      return ta !== tb ? ta - tb : a.file !== b.file ? a.file - b.file : a.index - b.index;
    });
  }

  const seenInFile = new Map<string, number>(), kept = new Map<string, number>();
  const events: LogEvent[] = [];
  for (const it of items) {
    const key = dedupKey(it.e), fileKey = it.file + '\u0001' + key;
    const n = (seenInFile.get(fileKey) ?? 0) + 1;
    seenInFile.set(fileKey, n);
    if (n <= (kept.get(key) ?? 0)) continue;   // another file already gave this many copies
    kept.set(key, (kept.get(key) ?? 0) + 1);
    events.push(it.e);
  }
  events.forEach((e, i) => { e.seq = i + 1; });

  const counts = new Map<string, number>();
  for (const e of events) if (e.speaker_key) counts.set(e.speaker_key, (counts.get(e.speaker_key) ?? 0) + 1);
  const byKey = new Map<string, Speaker>();
  for (const { log } of parsed) for (const s of log.speakers) {
    const have = byKey.get(s.key);
    if (!have) byKey.set(s.key, { ...s });
    else if (have.role === 'pc' && s.role !== 'pc') have.role = s.role;
  }
  const speakers: Speaker[] = [];
  for (const s of byKey.values()) {
    const n = counts.get(s.key) ?? 0;
    if (n > 0) speakers.push({ ...s, message_count: n });
  }
  return { events, speakers, issues };
}
