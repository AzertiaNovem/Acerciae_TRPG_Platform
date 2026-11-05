import type { CharacterSheet, LocalVoiceConfig, LogEvent, Project, VnAssetNeed, VnLine } from './types';

export interface HybridAsset { key: string; id: string; version: number; mime: string; hash: string }
interface HybridVoice extends LocalVoiceConfig { id: string; character_id: string | null }
interface HybridEvent {
  id: string; scene_id: string | null; hidden: boolean; display_kind: string; content: string; display_text: string;
  tts_text?: string | null; speaker_character_id: string | null; speaker_name_override?: string | null;
  speaker_display_name: string; speaker_role: string; character_name?: string | null; dice: LogEvent['dice'];
  style_instruction: string; effect: string; voice_profile_id: string | null;
  stage: { character_id: string; expression: string; position: 'left' | 'center' | 'right'; image: string | null }[];
}
export interface HybridManifest {
  format: 'acerciae-hybrid-vn-1'; era: string; assets: HybridAsset[];
  presentation: { id: string; title: string; snapshot_scope: string; template: Record<string, unknown> | null;
    scenes: { id: string; title: string; canonical_scene_key: string; background_brief: string | null; background: string | null; environment: { effect?: string } }[];
    events: HybridEvent[] };
  characters: { id: string; name: string; kind: string; appearance_prompt: string | null; portrait: string | null }[];
  voices: HybridVoice[]; cast: Record<string, string>;
  asset_needs: { kind: 'standee'; character_id: string; subtitle: string; brief: string }[];
}

// The server has already edited and staged the story. Preserve its display units (including merged/split lines)
// instead of running the local script writer again. Asset references become local paths, never API tokens or URLs.
export function hybridProject(manifest: HybridManifest, id: string, paths: Map<string, string>, now = new Date().toISOString()): Project {
  if (manifest.format !== 'acerciae-hybrid-vn-1') throw new Error('Unsupported hybrid VN format');
  const p = manifest.presentation;
  const image = (key: string | null): string | null => {
    if (!key) return null;
    const path = paths.get(key);
    if (!path) throw new Error('An existing image has not been downloaded');
    return path;
  };
  const voices = new Map(manifest.voices.map((v) => [v.id, v]));
  const config = (v?: HybridVoice): LocalVoiceConfig | undefined => v ? {
    voice_id: v.voice_id, provider: v.provider, language: v.language, style_instruction: v.style_instruction,
    dialect: v.dialect, voice_type: v.voice_type, synthesis_parameters: { ...v.synthesis_parameters },
  } : undefined;
  const names = new Map<string, string>(), used = new Set<string>();
  for (const c of manifest.characters) {
    let name = c.name || 'Character'; let n = 2;
    while (used.has(name)) name = `${c.name || 'Character'} (${n++})`;
    names.set(c.id, name); used.add(name);
  }
  const characters: CharacterSheet[] = manifest.characters.map((c) => {
    const chosen = manifest.cast[c.id];
    const voice = chosen !== undefined ? voices.get(chosen) : manifest.voices.find((v) => v.character_id === c.id);
    return { name: names.get(c.id)!, speakers: [names.get(c.id)!], kind: c.kind === 'npc' ? 'npc' : c.kind === 'gm' ? 'gm' : 'pc',
      player: '', appearance: c.appearance_prompt || c.name, role_card: null, avatar: null, portrait: image(c.portrait), poses: {},
      voice: voice?.voice_id ?? '', voice_config: config(voice) };
  });
  const byName = new Map(characters.map((c) => [c.name, c]));
  const narrator = manifest.cast.narrator !== undefined ? voices.get(manifest.cast.narrator) : manifest.voices.find((v) => !v.character_id);
  const events: LogEvent[] = [], lineOf = new Map<string, VnLine>();
  const sceneNames = new Map(p.scenes.map((s) => [s.id, s.title]));
  const linesByScene = new Map<string, VnLine[]>();
  const counts = new Map<string, number>();
  for (const e of p.events) {
    const seq = events.length + 1;
    const name = names.get(e.speaker_character_id ?? '') || e.speaker_name_override || e.speaker_display_name || 'Narrator';
    const type = e.display_kind === 'dice' ? 'dice_roll' : ['dialogue', 'action', 'narration', 'ooc', 'scene_change', 'system', 'media'].includes(e.display_kind) ? e.display_kind as LogEvent['type'] : 'narration';
    const role = ['gm', 'pc', 'npc', 'dice', 'system', 'hidden'].includes(e.speaker_role) ? e.speaker_role as LogEvent['role'] : 'gm';
    events.push({ seq, type, content: e.content || e.display_text, speaker_key: name, speaker_name: name, role,
      time: null, time_text: '', scene_title: sceneNames.get(e.scene_id ?? '') ?? '', window: '', dice: e.dice,
      media: null, raw: '', unrecognised: false, source: { file: p.title, adapter: 'hybrid_vn', line: seq } });
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const stage: NonNullable<VnLine['stage']> = [];
    for (const s of e.stage) {
      const character = names.get(s.character_id); if (!character) continue;
      const expression = s.expression || 'default';
      const path = image(s.image);
      if (path) byName.get(character)!.poses[expression] = path;
      stage.push({ character, expression, position: s.position });
    }
    lineOf.set(e.id, { seq, hidden: e.hidden, display_kind: e.display_kind, text: e.display_text,
      tts_text: e.tts_text || undefined, delivery: e.style_instruction, effect: e.effect, speaker: name, stage,
      voice_config: config(voices.get(e.voice_profile_id ?? '')) });
    const group = linesByScene.get(e.scene_id ?? '') ?? []; group.push(lineOf.get(e.id)!); linesByScene.set(e.scene_id ?? '', group);
  }
  const scenes = p.scenes.map((s) => ({ key: s.id, title: s.title, summary: '', background_brief: s.background_brief || s.title,
    background: image(s.background), environment: s.environment?.effect ?? 'none',
    lines: linesByScene.get(s.id) ?? [] }));
  const seated = new Set(scenes.flatMap((s) => s.lines.map((l) => l.seq)));
  const unseated = [...lineOf.values()].filter((l) => !seated.has(l.seq));
  if (unseated.length) scenes.push({ key: 'unplaced', title: 'Unplaced lines', summary: '', background_brief: '', background: null, environment: 'none', lines: unseated });
  const needs: VnAssetNeed[] = scenes.filter((s) => !s.background && s.lines.some((l) => !l.hidden)).map((s) => ({ kind: 'background', scene_key: s.key, name: s.title, brief: s.background_brief }));
  const seen = new Set<string>();
  for (const s of scenes) for (const l of s.lines) if (!l.hidden) for (const stage of l.stage ?? []) {
    const c = byName.get(stage.character)!;
    if (Object.keys(c.poses).some((k) => k.toLowerCase() === stage.expression.toLowerCase())) continue;
    const key = c.name + '\n' + stage.expression.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    const sourceId = manifest.characters.find((x) => names.get(x.id) === c.name)?.id;
    const direction = manifest.asset_needs.find((n) => n.character_id === sourceId && n.subtitle.toLowerCase() === stage.expression.toLowerCase());
    needs.push({ kind: 'standee', character: c.name, subtitle: stage.expression, brief: direction?.brief || `${c.appearance}, ${stage.expression}` });
  }
  const template = structuredClone(p.template ?? {});
  if (template.character_colors && typeof template.character_colors === 'object')
    template.character_colors = Object.fromEntries(Object.entries(template.character_colors).flatMap(([cid, color]) => names.has(cid) ? [[names.get(cid)!, color]] : []));
  const shown = [...lineOf.values()].filter((l) => !l.hidden).length;
  return { id, title: p.title, created_at: now, updated_at: now, background: { title: p.title, era: manifest.era || '', setting: '', summary: '' },
    sources: [{ file: p.title, adapter: 'native_json', events: events.length, imported_at: now }], events, characters, issues: [],
    speakers: [...new Map(events.map((e) => [e.speaker_key, { key: e.speaker_key, name: e.speaker_name, role: e.role, message_count: counts.get(e.speaker_key) ?? 0 }])).values()],
    hybrid: { presentation_id: p.id, imported_at: now, scope: p.snapshot_scope },
    vn: { script: { scenes, asset_needs: needs, notes: [], provider: 'server', stats: { scenes: scenes.length, shown, hidden: events.length - shown } },
      template, audio: {}, narrator_voice: narrator?.voice_id ?? '', narrator_voice_config: config(narrator), language: 'auto', instructions: '', composed_at: now } };
}
