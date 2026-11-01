// The native "acerciae-log" 2.0 file (what the server exports from now on), and the few things it carries that
// types.ts has no field for. Those ride along as optional extra properties on the shared objects, so a 2.0 file
// read and written back keeps them.
import type { CharacterSheet, EventType, LogEvent, SpeakerRole } from '../types';

export type Visibility = 'public' | 'gm' | 'private';

// A LogEvent that may say who may read it ("public" when absent). Set by the native importers.
export interface LogEventWithVisibility extends LogEvent { visibility?: Visibility }
// A CharacterSheet with the native file's bio and speaking style. Set by the 2.0 importer.
export interface CharacterSheetWithBio extends CharacterSheet { bio?: string; speaking_style?: string }

export interface NativeV2Dice { expression: string; total: number | null; outcome: string; check_name: string; text: string }
export interface NativeV2Message {
  time: string | null;            // ISO 8601 UTC, e.g. "2026-10-02T21:41:06Z"
  time_text: string;
  window: string | null;
  scenario: number | null;        // NativeV2Scenario.sequence
  speaker: string;
  character: string | null;
  player: string | null;          // username
  role: SpeakerRole;
  type: EventType;
  content: string;
  dice: NativeV2Dice | null;
  visibility: Visibility;
}
export interface NativeV2Player { username: string; display_name: string; role: 'gm' | 'player'; avatar_url?: string | null }
export interface NativeV2Character {
  name: string; kind: 'pc' | 'npc'; player: string | null; bio: string; speaking_style: string; appearance_prompt: string;
  role_card: Record<string, unknown> | null; avatar_url: string | null; portrait_url: string | null; poses: Record<string, string>;
}
export interface NativeV2Window { name: string; kind: string }
export interface NativeV2Scenario { sequence: number; title: string; location: string; narrative_time: string; summary: string; status: string }
export interface NativeLogV2 {
  format: 'acerciae-log';
  schemaVersion: '2.0';
  generator: string;
  exported_at: string;
  campaign: { name: string; era: string; description: string; viewer: string | null };
  players: NativeV2Player[];
  characters: NativeV2Character[];
  windows: NativeV2Window[];
  scenarios: NativeV2Scenario[];
  messages: NativeV2Message[];
}
