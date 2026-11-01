// What a planner may see and reference, built from one project (port of VnScriptService::inputs).
// Server ids map to local keys: a line is LogEvent.seq, a character is CharacterSheet.name, an asset is its path.
import type { CharacterSheet, DiceInfo, EventType, LogEvent, Project, SpeakerRole } from '../types';
import { lower, trim } from './text';

/** An existing background the planner may reuse (the desktop app's background library). */
export interface BackgroundAsset { name: string; path: string; tags?: string[] }

/** A log line as the planner reads it. */
export interface PlanLine {
  seq: number;
  type: EventType;
  content: string;
  window: string;              // chat window id: "" only for scene markers (see windowOf)
  sceneKey: string;            // the canonical scene (the log's scene title)
  sceneTitle: string;
  speakerName: string;         // the label's name: the character's name when the speaker is one, else as written
  role: SpeakerRole;
  character: string;           // CharacterSheet.name of the speaker, "" when none
  time: number | null;
  timeText: string;
  dice: DiceInfo | null;
  unrecognised: boolean;
  visibility: string;          // "secret" for GM-only lines, else "public": folded lines must share it
  location: string;            // the scene's location when known ("" locally)
}

export type AssetMode = 'uploaded' | 'generated';

/** One cast entry, as the transcript lists it: [{ref:"C1", name, kind, asset_mode, subtitles, appearance_prompt}]. */
export interface CastEntry {
  ref: string;
  name: string;                // CharacterSheet.name, the character's id here
  kind: CharacterSheet['kind'];
  asset_mode: AssetMode;
  subtitles: string[];         // pose names with an image, "default" excluded
  appearance_prompt: string;
  default_image: string | null; // the main portrait
}

export interface AssetEntry { ref: string; path: string; type: 'background'; name: string; tags: string[] }

export interface ScriptInputs {
  events: PlanLine[];          // line ref "L<n>" = events[n-1]
  windowNames: Record<string, string>;
  cast: CastEntry[];
  assets: AssetEntry[];
  era: string;
}

/** Window id for lines that carry no chat window of their own (logs from a single channel). */
export const MAIN_WINDOW = '\u0001main';

/**
 * A character's art mode. Without a server flag, a character with an appearance prompt is "generated" (the model may
 * ask for new poses); one without is "uploaded" (only the poses it already has may be used).
 */
export function assetModeOf(c: CharacterSheet): AssetMode {
  return trim(c.appearance ?? '') ? 'generated' : 'uploaded';
}

/** Pose names that have an image, deduplicated case-insensitively, ordered like the server's map (by lowercase name). */
export function subtitlesOf(c: CharacterSheet): string[] {
  const byKey = new Map<string, string>();
  for (const [k, v] of Object.entries(c.poses ?? {})) {
    const name = trim(k);
    const key = lower(name);
    if (!name || key === 'default' || typeof v !== 'string' || !v) continue;
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, name]) => name);
}

/** The image for a character and subtitle: its pose (case-insensitive), else the main portrait (resolveStage). */
export function standeeFor(c: CharacterSheet | undefined, expression: string | undefined): string | null {
  if (!c) return null;
  const key = lower(trim(expression ?? ''));
  if (key && key !== 'default') {
    for (const [k, v] of Object.entries(c.poses ?? {})) if (lower(trim(k)) === key && typeof v === 'string' && v) return v;
  }
  return c.portrait || null;
}

/** Characters by name (first sheet wins when two share a name). */
export function charactersByName(project: Project): Map<string, CharacterSheet> {
  const m = new Map<string, CharacterSheet>();
  for (const c of project.characters ?? []) if (c.name && !m.has(c.name)) m.set(c.name, c);
  return m;
}

/** Speaker key → character name (first sheet that lists the key). */
export function characterOfSpeaker(project: Project): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of project.characters ?? []) {
    if (!c.name) continue;
    for (const k of c.speakers ?? []) if (!m.has(k)) m.set(k, c.name);
  }
  return m;
}

export function orderedEvents(project: Project): LogEvent[] {
  return [...(project.events ?? [])].sort((a, b) => a.seq - b.seq);
}

function windowOf(e: LogEvent): string {
  if (e.window) return e.window;
  return e.type === 'scene_change' ? '' : MAIN_WINDOW;   // a scene marker without a window opens what follows it
}

export function planLines(project: Project): PlanLine[] {
  const who = characterOfSpeaker(project);
  return orderedEvents(project).map((e) => {
    const character = who.get(e.speaker_key) ?? '';
    return {
      seq: e.seq,
      type: e.type,
      content: e.content ?? '',
      window: windowOf(e),
      sceneKey: e.scene_title ?? '',
      sceneTitle: e.scene_title ?? '',
      speakerName: character || e.speaker_name || '',
      role: e.role,
      character,
      time: typeof e.time === 'number' && Number.isFinite(e.time) ? e.time : null,
      timeText: e.time_text ?? '',
      dice: e.dice ?? null,
      unrecognised: !!e.unrecognised,
      visibility: e.type === 'secret' ? 'secret' : 'public',
      location: '',
    };
  });
}

export function buildInputs(project: Project, backgrounds: BackgroundAsset[] = []): ScriptInputs {
  const events = planLines(project);
  const windowNames: Record<string, string> = {};
  const speakers = new Set<string>();
  let corpus = '';
  for (const e of events) {
    if (e.window) windowNames[e.window] = e.window === MAIN_WINDOW ? 'Main' : e.window;
    if (e.character) speakers.add(e.character);
    if (corpus.length < 2_000_000) corpus += e.content + '\n';
  }
  // Cast: characters who speak in the log, or whose full name appears in it.
  const cast: CastEntry[] = [];
  const seen = new Set<string>();
  for (const c of project.characters ?? []) {
    if (!c.name || seen.has(c.name)) continue;
    if (!speakers.has(c.name) && !corpus.includes(c.name)) continue;
    seen.add(c.name);
    cast.push({
      ref: `C${cast.length + 1}`,
      name: c.name,
      kind: c.kind,
      asset_mode: assetModeOf(c),
      subtitles: subtitlesOf(c),
      appearance_prompt: c.appearance ?? '',
      default_image: c.portrait || null,
    });
  }
  const assets: AssetEntry[] = [];
  const paths = new Set<string>();
  for (const b of backgrounds) {
    if (!b || !b.path || !b.name || paths.has(b.path)) continue;
    paths.add(b.path);
    assets.push({ ref: `B${assets.length + 1}`, path: b.path, type: 'background', name: b.name, tags: (b.tags ?? []).filter((t) => typeof t === 'string') });
  }
  return { events, windowNames, cast, assets, era: project.background?.era ?? '' };
}
