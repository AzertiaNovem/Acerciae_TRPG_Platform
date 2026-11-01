// A new project from imported logs.
import type { Background, CharacterSheet, Project, Speaker } from '../types';
import { mergeLogs, type LogFile } from './merge';

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
