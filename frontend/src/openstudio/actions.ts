// What Open Log Studio does with the AI services: paint character art and visual-novel backgrounds, voice lines.
// Each piece of work is one request that makes one file in the project's assets, and returns where it is; applying it
// to the project is a separate, small change (apply*), made on the latest copy, so tasks running side by side never
// overwrite each other's results. The task manager (tasks.ts) runs them.
import type { CharacterSheet, LocalVoiceConfig, Project, VnAssetNeed } from './types';
import { generateImage, synthesize } from './providers/providers';
import type { AiSettings } from './providers/settings';
import { readAsset, writeAsset } from './storage';

export type ArtSlot = { kind: 'portrait' } | { kind: 'avatar' } | { kind: 'pose'; subtitle: string };

export function slotName(slot: ArtSlot): string { return slot.kind === 'pose' ? slot.subtitle : slot.kind; }

// The server's framing text for each slot, with the project's era and setting.
export function characterPrompt(project: Project, c: CharacterSheet, slot: ArtSlot): string {
  let p = (c.appearance || c.name).trim();
  if (project.background.era) p += '. Period: ' + project.background.era;
  if (project.background.setting) p += '. Setting: ' + project.background.setting;
  if (slot.kind === 'avatar') p += '. Framing: head-and-shoulders avatar, square, centred face, plain background.';
  else if (slot.kind === 'portrait') p += '. Framing: main character portrait, waist-up, neutral expression, consistent identity.';
  else p += `. Framing: full-body visual-novel standee isolated on a transparent background with a real alpha channel, expression/pose: ${slot.subtitle || 'IDLE'}. Keep the same face, hair and attire as the main portrait. Keep the entire silhouette, hands and feet inside the frame. No scenery, solid backdrop, checkerboard pattern or ground shadow.`;
  return p.slice(0, 5000);
}

async function referenceOf(project: Project, path: string | null): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  if (!path || /^https?:/i.test(path)) return undefined;
  const bytes = await readAsset(project.id, path);
  const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp';
  return { bytes, mime };
}

// ---- character art ----------------------------------------------------------------------------------
/** Paints one image of a character (a pose uses the main portrait as its identity reference); returns its path. */
export async function makeCharacterArt(project: Project, c: CharacterSheet, slot: ArtSlot, ai: AiSettings['image'], signal?: AbortSignal, direction = ''): Promise<string> {
  const kind = slot.kind === 'pose' ? 'standee' : slot.kind;
  const reference = slot.kind === 'pose' ? await referenceOf(project, c.portrait) : undefined;
  const bytes = await generateImage(ai, { kind, prompt: characterPrompt(project, c, slot) + (direction ? '\nPose direction: ' + direction.slice(0, 2000) : ''), reference, signal });
  return writeAsset(project.id, bytes, 'png');
}
/** Files a character image in its slot (the character is found by name; nothing happens when it is gone). */
export function applyCharacterArt(d: Project, name: string, slot: ArtSlot, path: string) {
  const c = d.characters.find((x) => x.name === name);
  if (!c) return;
  if (slot.kind === 'portrait') c.portrait = path;
  else if (slot.kind === 'avatar') c.avatar = path;
  else c.poses = { ...c.poses, [slot.subtitle]: path };
}

// ---- what a composed script asks for ------------------------------------------------------------------
/** The art a composed script still asks for: scene backgrounds not painted yet, and missing poses of characters with an appearance. */
export function openNeeds(project: Project): VnAssetNeed[] {
  const vn = project.vn;
  if (!vn) return [];
  return vn.script.asset_needs.filter((n) => n.kind === 'background'
    ? vn.script.scenes.some((s) => s.key === n.scene_key && !s.background)
    : !!project.characters.find((c) => c.name === n.character && (c.appearance || c.portrait) && !Object.keys(c.poses).some((k) => k.toLowerCase() === (n.subtitle ?? '').toLowerCase())));
}
export function needLabel(n: VnAssetNeed): string { return n.kind === 'background' ? n.name || n.brief.slice(0, 60) : `${n.character} ${n.subtitle || 'IDLE'}`; }

export async function makeBackground(project: Project, n: VnAssetNeed, ai: AiSettings['image'], signal?: AbortSignal): Promise<string> {
  const prompt = `Visual-novel background, no people, no text: ${n.brief}${project.background.era ? '. Period: ' + project.background.era : ''}${project.background.setting ? '. Setting: ' + project.background.setting : ''}`;
  return writeAsset(project.id, await generateImage(ai, { kind: 'background', prompt, signal }), 'png');
}
/** Puts a painted background on its scene, unless the scene has one by now. */
export function applyBackground(d: Project, sceneKey: string | undefined, path: string) {
  for (const s of d.vn?.script.scenes ?? []) if (s.key === sceneKey && !s.background) s.background = path;
}

// ---- voice lines --------------------------------------------------------------------------------------
export interface VoiceJob { seq: number; text: string; voice: string; delivery: string; config?: LocalVoiceConfig }
const VOICED = new Set(['dialogue', 'narration', 'action', 'dice']);
/** Every shown line without a voice yet: a character's own voice, the narrator's for narration and the GM. */
export function voiceJobs(project: Project): VoiceJob[] {
  const vn = project.vn;
  if (!vn) return [];
  const bySeq = new Map(project.events.map((e) => [e.seq, e]));
  const charOf = (speaker?: string) => project.characters.find((c) => c.name === speaker || c.speakers.includes(speaker ?? ''));
  const jobs: VoiceJob[] = [];
  for (const scene of vn.script.scenes) for (const l of scene.lines) {
    if (l.hidden || vn.audio[l.seq]) continue;
    const e = bySeq.get(l.seq); if (!e) continue;
    const kind = l.display_kind ?? e.type;
    if (!VOICED.has(kind)) continue;
    const ch = kind === 'narration' || kind === 'dice' ? undefined : charOf(l.speaker ?? e.speaker_key);
    const fallback = ch?.voice || (kind === 'narration' || kind === 'dice' || e.role === 'gm' ? vn.narrator_voice : '');
    const saved = ch?.voice ? ch.voice_config : vn.narrator_voice_config;
    const config = l.voice_config ?? (saved?.voice_id === fallback ? saved : undefined);
    const voice = config?.voice_id ?? fallback;
    const text = (l.tts_text || l.text || e.content).trim();
    const delivery = [config?.style_instruction, config?.dialect ? `Dialect: ${config.dialect}` : '', l.delivery].filter(Boolean).join('; ');
    if (voice && text) jobs.push({ seq: l.seq, text, voice, delivery, ...(config ? { config } : {}) });
  }
  return jobs;
}
export async function makeVoice(project: Project, j: VoiceJob, ai: AiSettings['tts'], signal?: AbortSignal): Promise<{ path: string; ms: number }> {
  if (j.config && j.config.provider !== ai.provider) throw new Error('This server voice uses a different provider. Choose a voice from the local service in the dubbing cast.');
  const settings = j.config?.language ? { ...ai, language: j.config.language } : ai;
  const s = await synthesize(settings, j.text, j.voice, j.delivery, signal, j.config?.synthesis_parameters);
  return { path: await writeAsset(project.id, s.bytes, s.ext), ms: s.ms };
}
/** Stores a voice line for a line of the script. */
export function applyVoice(d: Project, seq: number, v: { path: string; ms: number }) {
  if (d.vn && d.vn.script.scenes.some((s) => s.lines.some((l) => l.seq === seq))) d.vn.audio[seq] = v;
}

// A local casting change overrides imported per-line profiles and invalidates only the affected recordings.
export function setLocalVoice(d: Project, character: string | null, voice: string) {
  if (!d.vn) return;
  if (character === null) { d.vn.narrator_voice = voice; delete d.vn.narrator_voice_config; }
  else { const c = d.characters.find((x) => x.name === character); if (c) { c.voice = voice; delete c.voice_config; } }
  const bySeq = new Map(d.events.map((e) => [e.seq, e]));
  for (const s of d.vn.script.scenes) for (const l of s.lines) {
    const e = bySeq.get(l.seq); if (!e) continue;
    const kind = l.display_kind ?? e.type;
    const speaker = kind === 'narration' || kind === 'dice' ? null : d.characters.find((c) => c.name === l.speaker || c.speakers.includes(l.speaker ?? e.speaker_key))?.name ?? null;
    if (speaker === character) { delete l.voice_config; delete d.vn.audio[l.seq]; }
  }
}
