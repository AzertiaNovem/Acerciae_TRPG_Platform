// Exports from a project: the native acerciae-log 2.0 file, a SealDice text log, and plain text.
import type { CharacterSheet, LogEvent, Project } from '../types';
import type { CharacterSheetWithBio, LogEventWithVisibility, NativeLogV2, NativeV2Message, NativeV2Player, Visibility } from './nativeTypes';
import { formatUtc, isoUtc } from './util';

// Only links travel in a native file; a project-relative asset path means nothing outside the project.
function link(v: string | null | undefined): string | null {
  return v && /^(https?:|data:)/i.test(v) ? v : null;
}

function withoutTrailingNewlines(s: string): string {
  return s.replace(/(\r?\n)+$/, '');
}

function visibilityOf(e: LogEvent): Visibility {
  return (e as LogEventWithVisibility).visibility ?? (e.type === 'secret' || e.role === 'hidden' ? 'gm' : 'public');
}

export function toNativeV2(project: Project, options: { generator?: string; exportedAt?: string } = {}): NativeLogV2 {
  const cast = project.characters.filter((c) => c.kind !== 'gm');
  const characterOf = new Map<string, CharacterSheet>();
  for (const c of cast) for (const k of c.speakers) if (!characterOf.has(k)) characterOf.set(k, c);

  const windows: string[] = [], scenarios: string[] = [];
  for (const e of project.events) {
    if (e.window && !windows.includes(e.window)) windows.push(e.window);
    if (e.scene_title && !scenarios.includes(e.scene_title)) scenarios.push(e.scene_title);
  }

  const messages: NativeV2Message[] = project.events.map((e) => {
    const c = characterOf.get(e.speaker_key);
    return {
      time: e.time === null ? null : isoUtc(e.time),
      time_text: e.time_text,
      window: e.window || null,
      scenario: e.scene_title ? scenarios.indexOf(e.scene_title) + 1 : null,
      speaker: e.speaker_name,
      character: c ? c.name : null,
      player: e.player || c?.player || null,
      role: e.role,
      type: e.type,
      content: e.content,
      dice: e.dice ? { expression: e.dice.expression, total: e.dice.total, outcome: e.dice.outcome, check_name: e.dice.check_name, text: e.dice.raw } : null,
      visibility: visibilityOf(e),
    };
  });

  // Players: every username the project names; the Keeper is whoever wrote a gm line or holds a gm sheet.
  const players: NativeV2Player[] = [];
  const addPlayer = (username: string, gm: boolean) => {
    if (!username) return;
    const p = players.find((x) => x.username === username);
    if (!p) players.push({ username, display_name: username, role: gm ? 'gm' : 'player' });
    else if (gm) p.role = 'gm';
  };
  for (const m of messages) if (m.player) addPlayer(m.player, m.role === 'gm');
  for (const c of project.characters) addPlayer(c.player, c.kind === 'gm');

  const bg = project.background;
  return {
    format: 'acerciae-log',
    schemaVersion: '2.0',
    generator: options.generator ?? 'open-log-studio',
    exported_at: options.exportedAt ?? new Date().toISOString(),
    campaign: { name: bg.title || project.title, era: bg.era, description: [bg.setting, bg.summary].filter(Boolean).join('\n\n'), viewer: 'gm' },
    players,
    characters: cast.map((c) => {
      const x = c as CharacterSheetWithBio;
      const poses: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.poses)) { const u = link(v); if (u) poses[k] = u; }
      return {
        name: c.name, kind: c.kind === 'npc' ? 'npc' : 'pc', player: c.player || null, bio: x.bio ?? '', speaking_style: x.speaking_style ?? '',
        appearance_prompt: c.appearance, role_card: c.role_card, avatar_url: link(c.avatar), portrait_url: link(c.portrait), poses,
      };
    }),
    windows: windows.map((name, i) => ({ name, kind: i === 0 ? 'main' : 'group' })),
    scenarios: scenarios.map((title, i) => ({ sequence: i + 1, title, location: '', narrative_time: '', summary: '', status: '' })),
    messages,
  };
}

// SealDice text log ("Nick(n) 2026/10/02 21:41:06", message, blank line), readable by SealDice / story-painter and
// by this importer. n is a per-speaker number (1, 2, …) so "Nick" and "Nick#2" stay apart; no platform ids exist
// to write. Characters that would break the header line are replaced with their full-width forms.
const CLOCK = /^(\d{4}\/\d{1,2}\/\d{1,2} )?\d{1,2}:\d{1,2}:\d{2}$/;
export function toSealDiceText(project: Project): string {
  const ids = new Map<string, number>();
  let out = '';
  project.events.forEach((e, i) => {
    if (i === 0 && e.unrecognised && !e.speaker_name) { out += withoutTrailingNewlines(e.content) + '\n\n'; return; }
    if (!ids.has(e.speaker_key)) ids.set(e.speaker_key, ids.size + 1);
    const name = e.speaker_name.replace(/\(/g, '（').replace(/\)/g, '）').replace(/</g, '＜').replace(/>/g, '＞').replace(/[\r\n]+/g, ' ').trim() || 'system';
    const ts = e.time !== null ? formatUtc(e.time) : CLOCK.test(e.time_text) ? e.time_text : '00:00:00';
    out += `${name}(${ids.get(e.speaker_key)}) ${ts}\n${withoutTrailingNewlines(e.content)}\n\n`;
  });
  return out;
}

// Plain text, as the server's toPlainText: "2026/10/02 21:41:06 <Nick>: message"; scene changes as "=== title ===".
export function toPlainText(project: Project): string {
  let out = '';
  for (const e of project.events) {
    const content = withoutTrailingNewlines(e.content);
    if (e.type === 'scene_change') { out += `\n=== ${content} ===\n\n`; continue; }
    const ts = e.time !== null ? formatUtc(e.time) : e.time_text;
    out += (ts ? ts + ' ' : '') + (e.speaker_name ? `<${e.speaker_name}>: ` : '') + content + '\n';
  }
  return out;
}
