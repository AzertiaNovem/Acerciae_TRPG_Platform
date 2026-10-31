// Open Log Studio (desktop app): the Log Studio running locally, without an account or the server. These are the
// shapes every part of it shares: what the importers produce, what a project stores, what the composer and the
// renderers read. Times are Unix seconds (UTC). Asset references are paths relative to the project folder
// (e.g. "assets/3f2a….png"); the UI turns them into URLs.

export type EventType = 'dialogue' | 'action' | 'narration' | 'dice_roll' | 'system' | 'ooc' | 'scene_change' | 'media' | 'secret';
export type SpeakerRole = 'gm' | 'pc' | 'npc' | 'dice' | 'system' | 'hidden';

export interface DiceInfo { expression: string; rolls: number[]; total: number | null; check_name: string; outcome: string; raw: string }
export interface MediaRef { kind: 'image' | 'audio' | 'other'; file?: string; url?: string }

export interface LogEvent {
  seq: number;                    // 1-based order in the project
  type: EventType;
  content: string;                // the original text, never rewritten
  speaker_key: string;            // stable key of the speaker within the project (see Speaker)
  speaker_name: string;           // name as written in the log
  role: SpeakerRole;
  time: number | null;            // Unix seconds, null when the log gives no date
  time_text: string;              // the time as written when it could not be parsed (e.g. "21:41:06")
  scene_title: string;            // scenario/scene title when the source has one, else ""
  window: string;                 // chat window / channel name when the source has one, else ""
  dice: DiceInfo | null;
  media: MediaRef[] | null;
  raw: string;                    // the source lines this event came from
  unrecognised: boolean;          // kept verbatim but not understood (e.g. text before the first message)
  source: { file: string; adapter: string; line: number };
  player?: string;                // the player's id/username when the source names one (never a platform id)
}

export interface Speaker {
  key: string;                    // e.g. "Sylvan" or "Sylvan#2" when two speakers share a name; platform ids are dropped
  name: string;
  role: SpeakerRole;
  message_count: number;
}

export interface ImportIssue { file: string; line: number; raw: string; reason: string; severity: 'warning' | 'error' }

export interface ParsedLog {
  adapter: 'native_json' | 'sealdice_json' | 'sealdice_text' | 'rendered_log' | 'qq_export';
  format_version: string;
  events: LogEvent[];
  speakers: Speaker[];
  issues: ImportIssue[];
  // What a native (acerciae-log 2.0) file says beyond the messages; empty for other formats.
  campaign?: { name: string; era: string; description: string };
  characters?: CharacterSheet[];
}

// What the user adds to a plain log: the setting, and each character's look and art.
export interface Background { title: string; era: string; setting: string; summary: string }
export interface CharacterSheet {
  name: string;                   // as it should appear (may differ from the log's speaker name)
  speakers: string[];             // Speaker.key values that are this character
  kind: 'pc' | 'npc' | 'gm';
  player: string;                 // who plays them ("" when unknown)
  appearance: string;             // appearance prompt for image generation
  role_card: Record<string, unknown> | null;
  avatar: string | null;          // asset path, or an http(s) URL from a native export
  portrait: string | null;        // main portrait / default standee
  poses: Record<string, string>;  // subtitle (SAY, IDLE, ANGRY, …) → asset path or URL
  voice: string;                  // TTS voice id for this character ("" = none)
}

export interface ProjectSource { file: string; adapter: ParsedLog['adapter']; events: number; imported_at: string }

export interface Project {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  background: Background;
  sources: ProjectSource[];
  events: LogEvent[];
  speakers: Speaker[];
  characters: CharacterSheet[];
  issues: ImportIssue[];
  vn?: StudioVn;                  // the visual novel made from this project, when there is one
  pdf?: Record<string, unknown>;  // the print settings last used (a partial PdfConfig)
}

// A project's visual novel: the composed script, its look, its voice lines and how it was asked for.
export interface StudioVn {
  script: VnScript;
  template: Record<string, unknown>;
  audio: Record<number, { path: string; ms: number }>;   // LogEvent.seq → voice line
  narrator_voice: string;
  language: string;
  instructions: string;
  composed_at: string;
}

// The visual-novel script (same shape as the server's normalized script).
export interface VnStage { character: string; position: 'left' | 'center' | 'right'; expression: string }   // character = CharacterSheet.name
export interface VnLine { seq: number; hidden: boolean; exclusion_reason?: string; display_kind?: string; text?: string; delivery?: string; effect?: string; speaker?: string; stage?: VnStage[] }
export interface VnScene { key: string; title: string; summary: string; background_brief: string; background: string | null; environment: string; lines: VnLine[] }
export interface VnAssetNeed { kind: 'background' | 'standee'; brief: string; scene_key?: string; character?: string; subtitle?: string; name?: string }
export interface VnScript { scenes: VnScene[]; asset_needs: VnAssetNeed[]; notes: string[]; provider: string; stats: { scenes: number; shown: number; hidden: number } }

// An LLM call, injected so the composer runs without knowing the provider (and in tests with a fixture).
export type LlmCall = (req: { system: string; user: string; json: boolean; max_tokens?: number }) => Promise<string>;
