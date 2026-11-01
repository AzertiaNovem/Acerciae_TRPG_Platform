// What Open Log Studio does with the AI services: paint character art and visual-novel backgrounds, voice lines.
// Every result is stored in the project's assets; the caller saves the project afterwards.
import type { CharacterSheet, Project, StudioVn } from './types';
import { generateImage, synthesize } from './providers/providers';
import type { AiSettings } from './providers/settings';
import { readAsset, writeAsset } from './storage';

export type ArtSlot = { kind: 'portrait' } | { kind: 'avatar' } | { kind: 'pose'; subtitle: string };

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

// Paints one image of a character and files it in the slot (a pose uses the main portrait as its reference).
export async function paintCharacter(project: Project, c: CharacterSheet, slot: ArtSlot, ai: AiSettings['image']): Promise<string> {
  const kind = slot.kind === 'pose' ? 'standee' : slot.kind;
  const bytes = await generateImage(ai, { kind, prompt: characterPrompt(project, c, slot), reference: slot.kind === 'pose' ? await referenceOf(project, c.portrait) : undefined });
  const path = await writeAsset(project.id, bytes, 'png');
  if (slot.kind === 'portrait') c.portrait = path;
  else if (slot.kind === 'avatar') c.avatar = path;
  else c.poses = { ...c.poses, [slot.subtitle]: path };
  return path;
}

// The art a composed script asks for: scene backgrounds and missing poses of characters with an appearance.
export async function paintNeeds(project: Project, vn: StudioVn, ai: AiSettings['image'], onProgress: (done: number, total: number, failed: string[]) => void, signal?: AbortSignal): Promise<string[]> {
  const failed: string[] = [];
  const needs = vn.script.asset_needs.filter((n) => n.kind === 'background'
    ? vn.script.scenes.some((s) => s.key === n.scene_key && !s.background)
    : !!project.characters.find((c) => c.name === n.character && c.appearance && !Object.keys(c.poses).some((k) => k.toLowerCase() === (n.subtitle ?? '').toLowerCase())));
  let done = 0;
  onProgress(0, needs.length, failed);
  for (const n of needs) {
    if (signal?.aborted) break;
    try {
      if (n.kind === 'background') {
        const prompt = `Visual-novel background, no people, no text: ${n.brief}${project.background.era ? '. Period: ' + project.background.era : ''}${project.background.setting ? '. Setting: ' + project.background.setting : ''}`;
        const path = await writeAsset(project.id, await generateImage(ai, { kind: 'background', prompt }), 'png');
        for (const s of vn.script.scenes) if (s.key === n.scene_key && !s.background) s.background = path;
      } else {
        const c = project.characters.find((x) => x.name === n.character)!;
        await paintCharacter(project, c, { kind: 'pose', subtitle: n.subtitle || 'IDLE' }, ai);
      }
    } catch (e: any) { failed.push(`${n.kind === 'background' ? n.brief : `${n.character} ${n.subtitle}`}: ${e?.message ?? e}`); }
    onProgress(++done, needs.length, failed);
  }
  return failed;
}

const VOICED = new Set(['dialogue', 'narration', 'action']);
// Voices every shown line that has none yet: a character's own voice, the narrator's for narration.
export async function voiceLines(project: Project, vn: StudioVn, ai: AiSettings['tts'], onProgress: (done: number, total: number, failed: string[]) => void, signal?: AbortSignal): Promise<string[]> {
  const failed: string[] = [];
  const bySeq = new Map(project.events.map((e) => [e.seq, e]));
  const charOf = (speaker?: string) => project.characters.find((c) => c.name === speaker || c.speakers.includes(speaker ?? ''));
  const jobs: { seq: number; text: string; voice: string; delivery: string }[] = [];
  for (const scene of vn.script.scenes) for (const l of scene.lines) {
    if (l.hidden || vn.audio[l.seq]) continue;
    const e = bySeq.get(l.seq); if (!e) continue;
    const kind = l.display_kind ?? e.type;
    if (!VOICED.has(kind)) continue;
    const ch = kind === 'narration' ? undefined : charOf(l.speaker ?? e.speaker_key);
    const voice = ch?.voice || (kind === 'narration' || e.role === 'gm' ? vn.narrator_voice : '');
    const text = (l.text || e.content).trim();
    if (voice && text) jobs.push({ seq: l.seq, text, voice, delivery: l.delivery ?? '' });
  }
  let done = 0;
  onProgress(0, jobs.length, failed);
  for (const j of jobs) {
    if (signal?.aborted) break;
    try {
      const s = await synthesize(ai, j.text, j.voice, j.delivery);
      vn.audio[j.seq] = { path: await writeAsset(project.id, s.bytes, s.ext), ms: s.ms };
    } catch (e: any) { failed.push(`#${j.seq}: ${e?.message ?? e}`); }
    onProgress(++done, jobs.length, failed);
  }
  return failed;
}
