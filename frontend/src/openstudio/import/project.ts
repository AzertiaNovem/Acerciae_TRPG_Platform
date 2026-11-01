// A new project from imported logs.
import type { Background, CharacterSheet, Project, Speaker } from '../types';
import { dedupKey, mergeLogs, type LogFile } from './merge';

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for runtimes without crypto.randomUUID (an RFC 4122 v4 shape).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function sheetFor(s: Speaker, name: string): CharacterSheet {
  return {
    name, speakers: [s.key], kind: s.role === 'gm' ? 'gm' : s.role === 'npc' ? 'npc' : 'pc', player: '', appearance: '',
    role_card: null, avatar: null, portrait: null, poses: {}, voice: '',
  };
}

// Characters: the native files' characters (first file wins for a name; their speakers are merged), then one sheet
// for every gm/pc/npc speaker that no native character covers (named after the speaker; its key when that name is
// taken). Dice bots, system and hidden speakers get no sheet. A background field left empty is filled from the first
// native file's campaign (title ← name, era ← era, setting ← description).
export function buildProject(input: { title: string; background: Background; files: LogFile[] }): Project {
  const merged = mergeLogs(input.files);
  const now = new Date().toISOString();
  const characters: CharacterSheet[] = [];
  const byName = new Map<string, CharacterSheet>();
  for (const { log } of input.files) for (const c of log.characters ?? []) {
    const have = byName.get(c.name);
    if (have) { for (const k of c.speakers) if (!have.speakers.includes(k)) have.speakers.push(k); continue; }
    const sheet = { ...c, speakers: [...c.speakers], poses: { ...c.poses } };
    byName.set(c.name, sheet); characters.push(sheet);
  }
  const covered = new Set(characters.flatMap((c) => c.speakers));
  for (const s of merged.speakers) {
    if (covered.has(s.key) || !(s.role === 'gm' || s.role === 'pc' || s.role === 'npc')) continue;
    const sheet = sheetFor(s, byName.has(s.name) ? s.key : s.name);
    byName.set(sheet.name, sheet); characters.push(sheet);
  }

  const background: Background = { ...input.background };
  const campaign = input.files.map((f) => f.log.campaign).find((c) => c !== undefined);
  if (campaign) {
    if (!background.title) background.title = campaign.name;
    if (!background.era) background.era = campaign.era;
    if (!background.setting) background.setting = campaign.description;
  }

  return {
    id: newId(),
    title: input.title || background.title,
    created_at: now,
    updated_at: now,
    background,
    sources: input.files.map(({ file, log }) => ({ file, adapter: log.adapter, events: log.events.length, imported_at: now })),
    events: merged.events,
    speakers: merged.speakers,
    characters,
    issues: merged.issues,
  };
}

export interface AppendReport {
  added: number;        // new lines, numbered after the project's last line
  duplicates: number;   // lines the project already had (overlapping exports)
  earlier: number;      // added lines whose time is before the project's last line: they still go at the end
  characters: number;   // character sheets added for new speakers
}

// A supplement log: more of the same campaign, added after what the project already has. Unlike a re-merge, the
// project's lines keep their numbers (a composed visual novel, its voice lines and its edits refer to them), so the
// new lines are ordered among themselves (mergeLogs) and numbered after the last line. Lines the project already has
// (same speaker name, time and content, as many copies as it holds) are dropped. New speakers get a sheet, and native
// characters of the new files add their speakers to a sheet of the same name or come in as new sheets.
export function appendLogs(project: Project, files: LogFile[]): AppendReport {
  const merged = mergeLogs(files);
  const have = new Map<string, number>();
  for (const e of project.events) { const k = dedupKey(e); have.set(k, (have.get(k) ?? 0) + 1); }
  let last = 0;
  let lastTime: number | null = null;
  for (const e of project.events) {
    if (e.seq > last) last = e.seq;
    if (typeof e.time === 'number' && (lastTime === null || e.time > lastTime)) lastTime = e.time;
  }
  const report: AppendReport = { added: 0, duplicates: 0, earlier: 0, characters: 0 };
  for (const e of merged.events) {
    const k = dedupKey(e);
    const n = have.get(k) ?? 0;
    if (n > 0) { have.set(k, n - 1); report.duplicates++; continue; }
    e.seq = ++last;
    if (lastTime !== null && typeof e.time === 'number' && e.time < lastTime) report.earlier++;
    project.events.push(e);
    report.added++;
  }
  // Speakers: merged by key (a role other than "pc" wins), counted again over the whole project.
  const byKey = new Map(project.speakers.map((s) => [s.key, { ...s }]));
  for (const s of merged.speakers) {
    const cur = byKey.get(s.key);
    if (!cur) byKey.set(s.key, { ...s });
    else if (cur.role === 'pc' && s.role !== 'pc') cur.role = s.role;
  }
  const counts = new Map<string, number>();
  for (const e of project.events) if (e.speaker_key) counts.set(e.speaker_key, (counts.get(e.speaker_key) ?? 0) + 1);
  project.speakers = [...byKey.values()].filter((s) => (counts.get(s.key) ?? 0) > 0).map((s) => ({ ...s, message_count: counts.get(s.key)! }));
  const byName = new Map(project.characters.map((c) => [c.name, c]));
  for (const { log } of files) for (const c of log.characters ?? []) {
    const cur = byName.get(c.name);
    if (cur) { for (const k of c.speakers) if (!cur.speakers.includes(k)) cur.speakers.push(k); continue; }
    const sheet = { ...c, speakers: [...c.speakers], poses: { ...c.poses } };
    byName.set(c.name, sheet); project.characters.push(sheet); report.characters++;
  }
  const covered = new Set(project.characters.flatMap((c) => c.speakers));
  for (const s of project.speakers) {
    if (covered.has(s.key) || !(s.role === 'gm' || s.role === 'pc' || s.role === 'npc')) continue;
    const sheet = sheetFor(s, byName.has(s.name) ? s.key : s.name);
    byName.set(sheet.name, sheet); project.characters.push(sheet); covered.add(s.key); report.characters++;
  }
  project.issues = [...project.issues, ...merged.issues];
  const now = new Date().toISOString();
  for (const { file, log } of files) project.sources.push({ file, adapter: log.adapter, events: log.events.length, imported_at: now });
  return report;
}
