// A composed script laid over the project's log as the in-app player's Presentation. Ports of the server's
// PresentationService: create() (default kinds, hidden chatter, speaker placements), applyScript() (scenes, wording,
// stages, unplaced lines), resolveStage() (a placement shows the pose for its subtitle, else the main portrait) and
// the view get() returns (display text, character images). Asset ids are asset paths, every asset_version is 1.
import type { CharacterPlacement, Presentation, PresentationEvent, PresentationScene } from '../../types';
import type { CharacterSheet, LogEvent, Project, VnScript } from '../types';
import { charactersByName, characterOfSpeaker, orderedEvents, standeeFor, subtitlesOf } from './inputs';
import { trim, utf8Length, utf8Prefix, words } from './text';

type DisplayKind = PresentationEvent['display_kind'];
const KINDS: readonly DisplayKind[] = ['dialogue', 'narration', 'action', 'ooc', 'dice', 'scene_change', 'system', 'media'];
const ENVIRONMENTS = ['none', 'rain', 'fog', 'dim', 'warm', 'cold'];
const EFFECTS = ['none', 'shake', 'flash', 'zoom'];
const POSITIONS = ['left', 'center', 'right'];

// ---- template -------------------------------------------------------------------------------------
const HEX = /^#[0-9a-fA-F]{6}$/;
/**
 * The server's validateVnTemplate, lenient: values that would be rejected are dropped instead of failing, so only
 * enumerated names, bounded numbers and #RRGGBB colours are kept. base defaults to "adv".
 */
export function sanitizeTemplate(input: unknown): Record<string, unknown> {
  const t = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  out.base = typeof t.base === 'string' && ['adv', 'nvl', 'dossier', 'cinematic'].includes(t.base) ? t.base : 'adv';
  const choice = (key: string, values: string[]) => { if (typeof t[key] === 'string' && values.includes(t[key] as string)) out[key] = t[key]; };
  choice('font', ['sans', 'serif', 'mono']);
  choice('name_style', ['tag', 'inline', 'hidden']);
  choice('color_grade', ['none', 'sepia', 'mono', 'cold', 'warm']);
  choice('dice_style', ['burst', 'stamp', 'inline', 'hide']);
  choice('scene_card', ['fade', 'caption', 'none']);
  choice('portrait_framing', ['upper', 'full']);
  for (const [key, low, high] of [['text_scale', 0.8, 1.5], ['box_opacity', 0, 1]] as const) {
    const v = t[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high) out[key] = Math.round(v * 100) / 100;
  }
  for (const key of ['letterbox', 'dim_inactive']) if (typeof t[key] === 'boolean') out[key] = t[key];
  if (typeof t.accent_color === 'string' && HEX.test(t.accent_color)) out.accent_color = t.accent_color;
  if (t.character_colors && typeof t.character_colors === 'object' && !Array.isArray(t.character_colors)) {
    const cc: Record<string, string> = {};
    let count = 0;
    for (const [k, v] of Object.entries(t.character_colors as Record<string, unknown>)) {
      if (count >= 200) break;
      if (utf8Length(k) <= 64 && typeof v === 'string' && HEX.test(v)) { cc[k] = v; count++; }
    }
    out.character_colors = cc;
  }
  return out;
}

// ---- defaults of a fresh presentation (PresentationService::create) --------------------------------
export function defaultKind(type: string): DisplayKind {
  switch (type) {
    case 'narration': return 'narration';
    case 'dice_roll': return 'dice';
    case 'ooc': return 'ooc';
    case 'action': return 'action';
    case 'scene_change': return 'scene_change';
    case 'media': return 'media';
    case 'system': return 'system';
    default: return 'dialogue';
  }
}
const hiddenByDefault = (e: LogEvent) => e.type === 'ooc' || e.type === 'system' || !!e.unrecognised;

/** How long a line stays without a voice (create()'s estimate). */
export function estimatedDuration(content: string): number {
  return Math.min(20000, 1200 + words(content).length * 320 + utf8Length(content) * 20);
}

/** Each line's speaker placement before a script is applied: speakers join the stage of their canonical scene (max 3). */
function defaultPlacements(events: LogEvent[], characterOf: (e: LogEvent) => string): Map<number, CharacterPlacement[]> {
  const out = new Map<number, CharacterPlacement[]>();
  let curScene: string | null = null;
  let onStage: string[] = [];
  const two = ['left', 'right'];
  const three = ['left', 'center', 'right'];
  for (const e of events) {
    if (e.scene_title !== curScene) { curScene = e.scene_title; onStage = []; }
    const kind = defaultKind(e.type);
    const cid = characterOf(e);
    const placement: CharacterPlacement[] = [];
    if (cid && (kind === 'dialogue' || kind === 'action')) {
      if (!onStage.includes(cid)) { if (onStage.length >= 3) onStage.shift(); onStage.push(cid); }
      onStage.forEach((c, i) => placement.push({ character_id: c, position: onStage.length === 1 ? 'center' : onStage.length === 2 ? two[i] : three[i], active: c === cid, expression: 'default' }));
    }
    out.set(e.seq, placement);
  }
  return out;
}

// ---- toPresentation -------------------------------------------------------------------------------
/** Character names keyed by character id (ids are names here), for VNPlayer's characterNames prop. */
export function characterNames(project: Project): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of project.characters ?? []) if (c.name) out[c.name] = c.name;
  return out;
}

/** Each character's images by subtitle: "default" (the main portrait) first, then its poses (character_images). */
export function characterImages(project: Project): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of charactersByName(project).values()) {
    const list = [...(c.portrait ? ['default'] : []), ...subtitlesOf(c)];
    if (list.length) out[c.name] = list;
  }
  return out;
}

function placementOf(c: { character: string; position: string; expression: string }, known: Map<string, CharacterSheet>): CharacterPlacement | null {
  if (!known.has(c.character)) return null;
  const expr = utf8Prefix(trim(c.expression ?? ''), 32);
  return { character_id: c.character, position: POSITIONS.includes(c.position) ? c.position : 'center', expression: expr || 'default' };
}

/** The presentation VNPlayer renders for this script (give it assetUrl(path) to turn asset paths into URLs). */
export function toPresentation(project: Project, script: VnScript, template: object): Presentation {
  const known = charactersByName(project);
  const speakerChar = characterOfSpeaker(project);
  const characterOf = (e: LogEvent) => speakerChar.get(e.speaker_key) ?? '';
  const events = orderedEvents(project);
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const defaults = defaultPlacements(events, characterOf);
  const now = project.updated_at || project.created_at || '';
  const scenes: PresentationScene[] = [];
  const out: PresentationEvent[] = [];
  const placed = new Set<number>();

  const scene = (title: string, key: string, background: string | null, environment: string): PresentationScene => {
    const s: PresentationScene = {
      id: `scene-${scenes.length + 1}`, presentation_id: project.id, position: scenes.length, title: utf8Prefix(title, 200), canonical_scene_key: utf8Prefix(key, 64),
      background_asset_id: background, background_asset_version: background ? 1 : null, bgm_asset_id: null,
      environment: { effect: ENVIRONMENTS.includes(environment) ? environment : 'none' }, transition_in: 'fade', locked: false,
    };
    scenes.push(s);
    return s;
  };
  const event = (e: LogEvent, sceneId: string, fields: Partial<PresentationEvent>): PresentationEvent => {
    const cid = characterOf(e);
    const speakerId = fields.speaker_character_id ?? (cid || null);
    const scriptText = fields.script_text ?? null;
    const ev: PresentationEvent = {
      id: `e${e.seq}`, scene_id: sceneId, position: out.length, canonical_event_id: String(e.seq), merged_event_ids: [], segment_index: 0, segment_text: null,
      display_kind: fields.display_kind ?? defaultKind(e.type), hidden: fields.hidden ?? hiddenByDefault(e), speaker_character_id: speakerId, speaker_name_override: null,
      tts_text: null, script_text: scriptText, character_asset_ids: fields.character_asset_ids ?? defaults.get(e.seq) ?? [], expression_ids: {}, dialogue_style: {},
      voice_profile_id: null, audio_asset_id: null, style_instruction: fields.style_instruction ?? '', transition: fields.transition ?? 'none', effect: fields.effect ?? 'none',
      estimated_duration_ms: estimatedDuration(e.content ?? ''), actual_audio_duration_ms: null,
      content: e.content ?? '', display_text: scriptText || (e.content ?? ''), event_type: e.type, speaker_display_name: e.speaker_name ?? '', speaker_role: e.role,
      dice: e.dice ?? null, media: e.media ?? null, sequence_number: e.seq,
      audio_duration_ms: null, word_timestamps: null, audio_is_mock: null, audio_mime: null, character_name: speakerId && known.has(speakerId) ? speakerId : null,
    };
    out.push(ev);
    return ev;
  };

  for (const s of script.scenes ?? []) {
    const sc = scene(s.title ?? '', s.key ?? '', s.background || null, s.environment ?? 'none');
    let first = true;
    for (const l of s.lines ?? []) {
      const e = bySeq.get(l.seq);
      if (!e || placed.has(l.seq)) continue;
      placed.add(l.seq);
      let kind = (l.display_kind ?? defaultKind(e.type)) as DisplayKind;
      if (!KINDS.includes(kind)) kind = defaultKind(e.type);
      const speakerId = l.speaker && known.has(l.speaker) ? l.speaker : '';
      const speaker = speakerId || characterOf(e);
      let stage: CharacterPlacement[] | undefined;
      if (Array.isArray(l.stage)) {
        stage = [];
        for (const c of l.stage) {
          const x = placementOf(c, known);
          if (!x) continue;
          x.active = c.character === speaker;
          stage.push(x);
        }
      }
      if (kind === 'narration' || kind === 'scene_change') stage = [];
      const effect = l.effect && EFFECTS.includes(l.effect) ? l.effect : 'none';
      const wording = utf8Prefix(l.text ?? '', 4000);
      event(e, sc.id, {
        display_kind: kind, hidden: !!l.hidden, speaker_character_id: speakerId || undefined, character_asset_ids: stage, effect,
        style_instruction: utf8Prefix(l.delivery ?? '', 400), transition: first ? 'fade' : kind === 'scene_change' ? 'fade' : 'none', script_text: wording || null,
      });
      first = false;
    }
  }
  // Anything the script did not mention keeps its place after the script, in a final scene.
  const rest = events.filter((e) => !placed.has(e.seq));
  if (rest.length) {
    const sc = scene('Unplaced lines', 'unplaced', null, 'none');
    for (const e of rest) event(e, sc.id, { transition: defaultKind(e.type) === 'scene_change' ? 'fade' : 'none' });
  }
  // Each placement shows its character's image for its subtitle (resolveStage).
  for (const ev of out) {
    for (const p of ev.character_asset_ids) {
      const img = standeeFor(known.get(p.character_id), p.expression);
      if (img) { p.asset_id = img; p.asset_version = 1; } else { p.asset_id = null; delete p.asset_version; }
    }
  }
  const tpl = sanitizeTemplate(template);
  return {
    id: project.id, project_id: project.id, snapshot_id: '', title: project.title ?? '',
    settings: { template: tpl, animations_enabled: true, typewriter_cps: 28, aspect: '16:9', generated: { provider: script.provider ?? '' } },
    style_profile_id: null, version: 1, created_by: '', created_at: project.created_at ?? now, updated_at: now,
    snapshot_scope: 'gm_full', line_count: out.filter((e) => !e.hidden).length, voiced_count: 0,
    scenes, events: out, can_edit: true,
    character_visuals: [...known.values()].map((c) => ({
      character_id: c.name, name: c.name, default_asset_id: c.portrait || null,
      expressions: Object.fromEntries(Object.entries(c.poses ?? {}).filter(([, v]) => typeof v === 'string' && !!v)), color: '',
    })),
    character_images: characterImages(project),
  };
}

