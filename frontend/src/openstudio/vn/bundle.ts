// A standalone visual novel: index.html (the self-contained player), script.json (its data) and the images and voice
// lines it plays. Ports of the server's PublicationService::bundlePlan (the data shape) and renderStandaloneVn.
import type { Project, VnScript } from '../types';
import { PLAYER_TEMPLATE } from './playerTemplate';
import { toPresentation } from './presentation';
import { utf8Prefix } from './text';

export interface StandaloneStage { name: string; position: string; active: boolean; image: string | null }
export interface StandaloneEvent {
  id: string; scene_id: string | null; kind: string; text: string; speaker: string; stage: StandaloneStage[];
  dice?: { total: number | null; outcome: string }; audio?: string; audio_ms?: number;
}
export interface StandaloneScene { id: string; title: string; background: string | null }
/** script.json: {title, template, scenes[{id,title,background}], events[{id,scene_id,kind,text,speaker,stage,dice,audio,audio_ms}]}. */
export interface StandaloneData { title: string; template: Record<string, unknown>; scenes: StandaloneScene[]; events: StandaloneEvent[] }

/** Voice lines by LogEvent.seq: a project audio path and its length in milliseconds. */
export type BundleAudio = Record<number, { path: string; ms: number }>;

/** One file of the bundle: inline content, or a project asset (path relative to the project folder) to copy. */
export interface BundleFile { path: string; content?: string; asset?: string }

const REMOTE = /^(https?:\/\/|data:image\/)/i;
// Characters that could leave a CSS url("…") or an attribute; a remote URL holding one is not used.
const UNSAFE_URL = /["'()\\<>\s]/;

/** A project-relative path that stays inside the project folder. */
function isProjectPath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes(':') || p.includes('\0')) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '');
}

function safeName(path: string, fallback: string): string {
  const base = path.split('/').pop() ?? '';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return clean || fallback;
}

class FileTable {
  files: BundleFile[] = [];
  private bySource = new Map<string, string>();
  private used = new Set<string>();
  /** The bundle path for a project asset, or the URL itself for a remote image; null when unusable. */
  add(dir: 'assets' | 'audio', source: string | null | undefined): string | null {
    if (!source) return null;
    if (REMOTE.test(source)) return dir === 'assets' && !UNSAFE_URL.test(source) ? source : null;
    if (!isProjectPath(source)) return null;
    const known = this.bySource.get(source);
    if (known) return known;
    const name = safeName(source, dir === 'assets' ? 'image' : 'voice');
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let path = `${dir}/${name}`;
    for (let k = 2; this.used.has(path); k++) path = `${dir}/${stem}-${k}${ext}`;
    this.used.add(path);
    this.bySource.set(source, path);
    this.files.push({ path, asset: source });
    return path;
  }
}

function plan(project: Project, script: VnScript, template: object, audio?: BundleAudio): { data: StandaloneData; files: BundleFile[] } {
  const p = toPresentation(project, script, template);
  const table = new FileTable();
  const data: StandaloneData = {
    title: p.title,
    template: (p.settings.template ?? {}) as Record<string, unknown>,
    scenes: (p.scenes ?? []).map((sc) => ({ id: sc.id, title: sc.title, background: table.add('assets', sc.background_asset_id) })),
    events: [],
  };
  for (const e of p.events ?? []) {
    if (e.hidden) continue;
    const x: StandaloneEvent = {
      id: e.id, scene_id: e.scene_id, kind: e.display_kind, text: e.display_text,
      speaker: e.speaker_name_override ?? e.character_name ?? e.speaker_display_name,
      stage: e.character_asset_ids.map((pl) => ({
        name: pl.character_id, position: pl.position, active: !!pl.active || pl.character_id === e.speaker_character_id,
        image: table.add('assets', pl.asset_id),
      })),
    };
    if (e.dice && e.dice.total !== null && e.dice.total !== undefined) x.dice = { total: e.dice.total, outcome: e.dice.outcome };
    const voice = audio?.[e.sequence_number];
    if (voice) {
      const path = table.add('audio', voice.path);
      if (path) {
        x.audio = path;
        if (typeof voice.ms === 'number' && Number.isFinite(voice.ms)) x.audio_ms = Math.round(voice.ms);
      }
    }
    data.events.push(x);
  }
  return { data, files: table.files };
}

/** The bundle's script.json data, with image and audio paths relative to the bundle (assets/…, audio/…). */
export function standaloneData(project: Project, script: VnScript, template: object, audio?: BundleAudio): StandaloneData {
  return plan(project, script, template, audio).data;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const replaceAll = (s: string, from: string, to: string) => s.split(from).join(to);

/**
 * The data as it sits inside <script type="application/json">: every "<", ">" and "&" (and the JavaScript line
 * separators) is written as a \u escape, so no log text can close the script element or open a comment in it.
 */
export function embedJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** index.html of a bundle: the self-contained player with the data embedded (port of renderStandaloneVn). */
export function standaloneHtml(data: StandaloneData): string {
  const tpl = (data.template ?? {}) as Record<string, unknown>;
  let accent = typeof tpl.accent === 'string' ? tpl.accent : typeof tpl.accent_color === 'string' ? tpl.accent_color : '#c9a35c';
  // Only a CSS colour literal may reach the stylesheet.
  if (!accent || accent.length > 24 || !/^[A-Za-z0-9#(),.% ]+$/.test(accent)) accent = '#c9a35c';
  let html = replaceAll(PLAYER_TEMPLATE, '__VN_TITLE__', escapeHtml(String(data.title ?? '')));
  html = replaceAll(html, '__VN_ACCENT__', accent);
  return replaceAll(html, '__VN_DATA__', embedJson(data));
}

/** A folder or archive name for the bundle: letters, digits and non-ASCII characters of the title. */
export function bundleFolderName(title: string): string {
  let base = '';
  for (const ch of title ?? '') base += /[A-Za-z0-9]/.test(ch) || ch.codePointAt(0)! >= 0x80 ? ch : '_';
  base = utf8Prefix(base, 40);
  return base || 'visual-novel';
}

/** Every file of the bundle: index.html and script.json inline, then each image and voice line to copy from the project. */
export function bundleFiles(project: Project, script: VnScript, template: object, audio?: BundleAudio): BundleFile[] {
  const { data, files } = plan(project, script, template, audio);
  return [
    { path: 'index.html', content: standaloneHtml(data) },
    { path: 'script.json', content: JSON.stringify(data, null, 2) },
    ...files,
  ];
}
