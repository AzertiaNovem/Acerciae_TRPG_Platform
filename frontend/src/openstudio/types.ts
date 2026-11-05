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
  voice_config?: LocalVoiceConfig;
}

export interface LocalVoiceConfig {
  voice_id: string; provider: string; language: string; style_instruction: string; dialect?: string;
  voice_type?: string; synthesis_parameters: Record<string, number | boolean>;
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
  vn_draft?: VnDraft;             // a script being written whose editor asked the user something (see vn/compose.ts)
  pdf?: Record<string, unknown>;  // the print settings last used (a partial PdfConfig)
  hybrid?: { presentation_id: string; imported_at: string; scope: string };
}

// A project's visual novel: the composed script, its look, its voice lines and how it was asked for.
export interface StudioVn {
  script: VnScript;
  template: Record<string, unknown>;
  audio: Record<number, { path: string; ms: number }>;   // LogEvent.seq → voice line
  narrator_voice: string;
  narrator_voice_config?: LocalVoiceConfig;
  language: string;
  instructions: string;
  composed_at: string;
}

// The visual-novel script (same shape as the server's normalized script).
export interface VnStage { character: string; position: 'left' | 'center' | 'right'; expression: string }   // character = CharacterSheet.name
export interface VnLine { seq: number; hidden: boolean; exclusion_reason?: string; display_kind?: string; text?: string; delivery?: string; effect?: string; speaker?: string; stage?: VnStage[]; tts_text?: string; voice_config?: LocalVoiceConfig }
export interface VnScene { key: string; title: string; summary: string; background_brief: string; background: string | null; environment: string; lines: VnLine[] }
export interface VnAssetNeed { kind: 'background' | 'standee'; brief: string; scene_key?: string; character?: string; subtitle?: string; name?: string }
export interface VnScript { scenes: VnScene[]; asset_needs: VnAssetNeed[]; notes: string[]; provider: string; stats: { scenes: number; shown: number; hidden: number } }

// A script part whose editor asked the players or the Keeper something: the question box the user answers.
export interface VnQuestion { id: string; question: string; refs: string[]; options: string[] }
export interface VnPendingPart {
  index: number;                  // the part in VnDraft.parts
  first_line: number; last_line: number;   // 1-based line numbers of the part (L<n> in the questions' refs)
  user: string;                   // the part's prompt as it was sent, so the resumed conversation is the same one
  questions: VnQuestion[];
  rounds: number;                 // how often this part asked (a part asks twice at most)
  draft: unknown;                 // the editor's best answer for the part meanwhile (the flat script)
  turn: LlmTurn | null;           // the model's turn to replay when the part is resumed (null: plain text only)
  answers: Record<string, string> | null;   // the user's answers once given
  skip: boolean;                  // the user chose to keep the draft instead
}
// A script being written: finished parts and the parts waiting for answers. Resuming it (vn/compose.ts resumeDraft)
// redoes only the pending parts; the others are kept as they are.
export interface VnDraft {
  mode: 'compose' | 'continue';
  language: string;
  instructions: string;
  events: number;                 // how many lines the project had: a changed log invalidates the draft
  from_seq: number;               // continue: the last line of the novel the draft continues
  parts: [number, number][];
  flats: unknown[];               // one per part; null while the part is pending
  notes: string[];
  pending: VnPendingPart[];
  created_at: string;
}

// An LLM call, injected so the composer runs without knowing the provider (and in tests with a fixture). A call may
// replay the model's own earlier turn followed by the user's answers (`replay`), and may return the turn as the
// provider gave it so it can be replayed later; a plain string answer is accepted too.
export interface LlmTurn {
  provider: string;               // 'anthropic' | 'openai' | …: the turn is replayable only through the same provider
  model: string;
  text: string;                   // the turn's text (the JSON answer)
  blocks: unknown[];              // the turn as returned: Anthropic content blocks (thinking blocks with their signature), or nothing
}
export interface LlmRequest { system: string; user: string; json: boolean; max_tokens?: number; signal?: AbortSignal; replay?: { turn: LlmTurn; followUp: string } }
export interface LlmAnswer { text: string; turn?: LlmTurn }
export type LlmCall = (req: LlmRequest) => Promise<string | LlmAnswer>;
