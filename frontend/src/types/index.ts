// Shared API types (mirrors backend JSON shapes).
export interface User { id: string; username: string; display_name: string; ui_language: string; avatar_data: string; avatar_version: number; languages?: string[] }
export interface Server { id: string; name: string; owner_id: string; my_role: string }
export interface Channel {
  id: string; server_id: string; name: string; description: string; rule_system: string;
  player_group_id?: string; player_group_name?: string; player_group_version?: number;
  knowledge_mode: 'public' | 'isolated'; current_scene_id: string | null; current_scene_title?: string | null; era?: string; studio_visible?: boolean;
  ai_enabled: boolean; auto_scenarios?: boolean; my_role: 'gm' | 'player'; my_character_ids: string[];
  dice_text_group: string;   // '' = follow server language | 'builtin:en' | 'builtin:zh' | text group id
}
export interface WindowMember { user_id: string; character_id: string | null; display_name: string; character_name: string | null }
export interface ChatWindow {
  id: string; channel_id: string; name: string; kind: 'main' | 'group' | 'private'; active_scene_id: string | null;
  scene_title?: string | null; members: WindowMember[] | null; last_seq: number | null;
}
export interface Character { id: string; channel_id: string; user_id: string | null; name: string; kind: 'pc' | 'npc'; speaking_style: string; sheet: Record<string, unknown>; player_name?: string | null; avatar_asset_id?: string | null; portrait_asset_id?: string | null; asset_mode?: 'uploaded' | 'generated'; appearance_prompt?: string; bio?: string; role_card?: RoleCard; editable?: boolean }
// The COC7-styled role card. Numbers are mirrored into sheet.attrs for the dice.
export interface RoleCard {
  basic: { player: string; occupation: string; age: string; sex: string; residence: string; birthplace: string };
  characteristics: Partial<Record<'STR' | 'CON' | 'SIZ' | 'DEX' | 'APP' | 'INT' | 'POW' | 'EDU' | 'LUK', number>>;
  derived: { hp?: number; hp_max?: number; mp?: number; mp_max?: number; san?: number; san_max?: number; mov?: number; build?: number; db: string };
  skills: Record<string, number>;
  background: Record<'personal_description' | 'ideology' | 'significant_people' | 'meaningful_locations' | 'treasured_possessions' | 'traits' | 'injuries' | 'phobias' | 'arcane' | 'encounters', string>;
  items: { name: string; note: string; qty: number }[];
  wealth: { cash: string; assets: string; spending_level: string };
  // Point-buy mode (server feature coc7_points): the career with its option picks and free specialties, and the
  // career / hobby / growth points per skill. Totals in `skills` are recomputed from these by the server.
  career?: { name: string; choices: string[][]; specialties: string[] };
  skill_points?: Record<string, SkillPoints>;
}
export interface SkillPoints { career: number; hobby: number; growth: number; base?: number }
export interface PointsReport { enabled: boolean; career?: string | null; career_budget?: number; career_spent?: number; hobby_budget?: number; hobby_spent?: number; characteristics_total?: number; luck?: number; allowed?: string[]; violations?: { code: string; message: string; skill?: string }[]; warnings?: { code: string; message: string }[] }
export interface Coc7Option { skill: string; label: string; any?: boolean; spec?: string }
export interface Coc7Career { id: number; name: string; credit: [number, number] | null; points: { attrs: string[]; mult: number }[]; formula: string; fixed: Coc7Option[]; choices: { pick: number; from: Coc7Option[] }[]; free: number; description: string }
export interface Coc7Rules { skills: { name: string; base: number | 'DEX/2' | 'EDU' }[]; families: { name: string; base: number }[]; careers: Coc7Career[]; hobby_formula: string }
export interface CharacterAssetRef { id: string; version: number; mime: string; width: number | null; height: number | null; source_type: string; approval_status: string; subtitle?: string }
export interface CharacterSpace { character: Character & { role_card: RoleCard; editable: boolean }; avatar: CharacterAssetRef | null; portrait: CharacterAssetRef | null; subtitles: CharacterAssetRef[]; jobs: { id: string; kind: string; status: string; error: string | null; attach: { slot: string; subtitle: string } | null; created_at: string; finished_at: string | null }[]; era: string; narrative_time: string | null; attrs: Record<string, number>; generation_available: boolean; points: PointsReport }
export interface PlayerGroup { id: string; channel_id: string; name: string; version: number; members: {user_id: string; display_name: string}[] }
export interface Message {
  reference_ids?: string[];
  id: string; channel_id: string; chat_window_id: string; scene_id: string | null; author_id: string; author_role: 'gm' | 'player';
  character_id: string | null; character_name: string | null; character_avatar_asset_id?: string | null; character_avatar_version?: number | null; author_name: string; author_avatar_version?: number; kind: 'ic' | 'ooc' | 'narration' | 'roll' | 'system';
  content: string; visibility: 'window' | 'gm_only' | 'whisper'; whisper_to: string[]; seq: number; created_at: string;
  dice?: DiceResult | null;
}
export interface DiceResult { type: string; command: string; text: string; hidden?: boolean; [k: string]: unknown }
export interface Scene { id: string; title: string; location: string; narrative_time: string; status: 'active' | 'closed'; summary: string; off_module: boolean; sequence: number; event_count?: number; windows?: { chat_window_id: string; name: string }[] | null; auto_detected?: boolean; stage_reason?: string; summary_status?: 'none' | 'pending' | 'ready' | 'gm_edited'; summary_llm_mode?: string; key_points?: string[]; created_at?: string; closed_at?: string | null }
export type DocType = 'current_scene' | 'clue_journal' | 'relationships' | 'open_threads' | 'timeline' | 'module_progress';
export interface DocumentSummary { id: string; doc_type: DocType; title: string; version: number; gm_only: boolean; updated_at: string; entry_count: number; recent_changes: number; preview: string | null }
export interface DocEntry {
  id: string; document_id: string; fact_id: string; section: string; position: number; content_md: string; created_version: number; updated_version: number;
  kind: string; summary: string; status: string; data: Record<string, any>; scene_id: string | null; scene_title: string | null; source_event_ids: string[];
  created_by: string; entities: { id: string; name: string; kind: string; role: string }[] | null; visibility?: { scope: string; character_id: string | null }[] | null; changed_since?: boolean;
}
export interface DocumentFull extends DocumentSummary { entries: DocEntry[]; markdown: string; scene?: { title: string; location: string; narrative_time: string } | null; scene_id?: string; changed_since_count: number }
export interface Highlight {
  id: string; channel_id: string; document_id: string; target_entry_id: string | null; text_range: { start: number; end: number } | null; reason: string;
  kind: 'association' | 'consistency' | 'potential_association' | 'correction'; source_event_ids: string[]; priority: number; visibility_scope: string;
  created_at: string; expires_at: string; doc_type?: DocType;
}
export interface Revision { id: string; version: number; actor: string; actor_name: string | null; summary: string; source_event_ids: string[]; created_at: string; op_count: number }
export interface ReminderCitation { event_id: string; message_id: string | null; chat_window_id: string | null; scene_id: string | null; seq: number; quotes: string[] }
// A reminder bubble: a short AI note anchored to verbatim quotes from chat lines the reader can see.
export interface ReminderScriptRef { knowledge_id: string; kind: ScriptKind; title: string; page?: number; excerpt?: string }
export interface Reminder { id: string; kind: 'forgotten' | 'needed' | 'plan' | 'note'; title: string; why: string; citations: ReminderCitation[]; script_refs?: ReminderScriptRef[]; scene_id: string | null; priority: number; player_group_id: string | null; llm_mode: string; created_at: string; expires_at: string }
// The Keeper's script knowledge, built from the module and moved by reviewed changes during play.
export type ScriptKind = 'flow' | 'relationship' | 'clue' | 'foreshadowing' | 'background';
export type ScriptStatus = 'pending' | 'active' | 'done' | 'skipped';
export interface ScriptKnowledge { id: string; module_id: string | null; kind: ScriptKind; title: string; body: string; data: Record<string, any>; citations: { page: number; excerpt: string }[]; node_ids: string[]; position: number; status: ScriptStatus; status_event_ids: string[]; origin: 'script' | 'play' | 'gm'; gm_edited: boolean; llm_mode: string; created_at: string; updated_at: string }
export interface ScriptChange { id: string; knowledge_id: string | null; op: 'add' | 'update' | 'status'; proposal: Record<string, any>; evidence: { event_id: string; text: string }[]; source_event_ids: string[]; verdict: 'approved' | 'rejected'; reviewer_reason: string; applied: boolean; llm_mode: string; created_at: string; title: string | null; kind: ScriptKind | null; status: ScriptStatus | null }
export interface KpStageBrief { id: string; title: string; status: ScriptStatus; position: number; body: string; data: Record<string, any>; citation?: { page: number; excerpt: string } }
export interface KpBoard {
  next: { has_script: boolean; current: KpStageBrief | null | Record<string, never>; next: KpStageBrief | null | Record<string, never>; pending_clues: { id: string; title: string }[]; pending_foreshadowing: { id: string; title: string }[]; stages_done: number; stages_total: number; summary: string; updated_at?: string; llm_mode?: string } | null;
  notes: { open_threads: { fact_id: string; summary: string; status: string }[]; timeline: { id: string; sequence: number; title: string; location: string; narrative_time: string; status: string }[]; recent_changes: { id: string; op: string; verdict: string; reviewer_reason: string; applied: boolean; created_at: string; title: string | null; kind: string | null; status: string | null }[]; stages_done: { id: string; title: string }[]; updated_at?: string } | null;
}
export interface ReminderContextEvent { event_id: string; seq: number; scene_id: string | null; chat_window_id: string | null; window_name: string | null; message_id: string | null; actor_role: string; character_id: string | null; character_name: string | null; author_name: string | null; kind: string; content: string; created_at: string; anchor?: boolean; cited?: boolean; quotes?: string[] }
export interface EventRow { id: string; kind: string; seq: number; scene_id: string | null; chat_window_id: string | null; message_id: string | null; character_id: string | null; character_name: string | null; scene_title: string | null; created_at: string; payload: { content?: string; [k: string]: unknown } }
export interface ConsistencyConflict { description: string; severity?: string; evidence_fact_ids: string[]; quote?: string }
export interface ConsistencyEvidence { fact_id: string; entry_id: string | null; document_id: string | null; document_type: DocType | null; summary: string; status: string; scene_title: string | null; source_event_ids: string[]; role: 'conflict' | 'support' | 'recommended' }
export interface ConsistencyResult { id: string; score: number | null; score_label: string; insufficient_evidence: boolean; rationale: string; conflicts: ConsistencyConflict[]; evidence: ConsistencyEvidence[]; highlights: Highlight[]; llm_mode: string }
export interface InspirationResult { id: string; draft: string; used_fact_ids: string[]; notes?: string; llm_mode: string; editable: boolean; auto_sent: boolean }
export interface ModuleNode { id: string; module_id: string; node_type: string; name: string; description: string; data: Record<string, unknown>; citations: { page: number; excerpt: string }[]; gm_edited: boolean; progress: string; pending_hints?: number }
export interface ModuleEdge { id: string; from_node_id: string; to_node_id: string; relation: string; from_name: string; to_name: string }
export interface ModuleInfo { id: string; title: string; file_name: string; page_count: number; status: string; error: string | null; llm_mode: string; created_at: string; node_count?: number; edge_count?: number; nodes?: ModuleNode[]; edges?: ModuleEdge[] }
export interface ModuleHint { id: string; node_id: string | null; node_name: string | null; node_type: string | null; reason: string; source_event_ids: string[]; status: string; created_at: string }
export interface Proposal { id: string; document_id: string | null; doc_type: DocType | null; ops: any[]; rejection_reason: string | null; source_event_ids: string[]; status: string; created_at: string }
export interface AiJob { id: string; kind: string; group_key: string; status: string; event_count: number; llm_calls: number; llm_mode: string; error: string | null; started_at: string; finished_at: string | null; result?: any }

// ---- Log Studio ----
export type LogEventType = 'dialogue' | 'action' | 'narration' | 'dice_roll' | 'system' | 'ooc' | 'scene_change' | 'media' | 'secret';
export interface LogEvent {
  event_id: string; sequence_number: number; event_type: LogEventType; content: string;
  speaker_key: string; speaker_display_name: string; speaker_character_id: string | null; speaker_role: 'gm' | 'pc' | 'npc' | 'dice' | 'system' | 'hidden';
  timestamp: number | null; time_text: string; scene_key: string; scene_title: string; scene_id: string | null; chat_window_id: string | null;
  visibility_scope: 'public' | 'gm' | 'character'; audience: string[]; source_kind: 'channel_event' | 'import'; source_reference: Record<string, any>;
  dice: { expression: string; rolls: number[]; total: number | null; check_name: string; outcome: string; raw: string } | null;
  media: { kind: string; file?: string; url?: string; cq?: string }[] | null; metadata: Record<string, any>; raw_text: string | null; unrecognised: boolean;
}
export interface LogProject { id: string; channel_id: string; title: string; description: string; source_kind: string; character_map: Record<string, { character_id?: string | null; display_name?: string; role?: string; color?: string }>; version: number; created_at: string; updated_at: string; event_count?: number; snapshot_count?: number; presentation_count?: number; published_count?: number; snapshots?: LogSnapshot[]; imports?: LogImport[]; speakers?: { speaker_key: string; display_name: string; role: string; character_id: string | null; n: number }[]; scenes?: SceneSummary[] }
export interface CampaignLog { project: LogProject; synced_added: number; windows: { id: string; name: string; kind: string; line_count: number; last_at: string | null }[]; scenarios: { id: string; sequence: number; title: string; status: string; summary: string; line_count: number }[]; last_event_at: string | null }
export interface SceneSummary { scene_key: string; scene_title: string; scene_id: string | null; from_seq: number; to_seq: number; n: number }
export interface LogSnapshot { id: string; project_id: string; version: number; title: string; selection: Record<string, any>; scope: 'gm_full' | 'pl_public' | 'character'; scope_character_id: string | null; schema_version: string; event_count: number; created_at: string; presentation_count?: number; visible_event_count?: number; events?: LogEvent[]; project_title?: string; character_map?: LogProject['character_map'] }
export interface LogImport { id: string; adapter: string; file_name: string; encoding: string; status: string; stats: Record<string, any>; created_at: string; committed_at: string | null; issue_count?: number; speaker_map?: Record<string, SpeakerMapEntry>; speakers?: Record<string, SpeakerMapEntry>; preview?: LogEvent[]; issues?: { line_no: number; raw: string; reason: string; severity: string }[]; start_text?: string }
export interface SpeakerMapEntry { display_name: string; role: string; im_user_id?: string; message_count?: number; character_id: string | null; suggested?: boolean; drop?: boolean }

export interface MediaAsset { id: string; channel_id: string; asset_type: string; source_type: string; name: string; mime: string; bytes: number; width: number | null; height: number | null; duration_ms: number | null; character_id: string | null; expression: string; outfit: string; generation_provider: string | null; generation_model: string | null; prompt: string | null; approval_status: 'candidate' | 'approved' | 'rejected'; visibility_scope: 'channel' | 'gm'; version: number; tags: string[]; created_at: string; license_metadata: Record<string, unknown>; style_profile_id?: string | null }
export interface CharacterPlacement { character_id: string; asset_id?: string | null; asset_version?: number; position: 'left' | 'center' | 'right' | string; active?: boolean; expression?: string; scale?: number; flip?: boolean }
export interface PresentationScene { id: string; presentation_id: string; position: number; title: string; canonical_scene_key: string; background_asset_id: string | null; background_asset_version: number | null; bgm_asset_id: string | null; environment: Record<string, any>; transition_in: string; locked: boolean }
export interface PresentationEvent {
  id: string; scene_id: string | null; position: number; canonical_event_id: string; merged_event_ids: string[]; segment_index: number; segment_text: string | null;
  display_kind: 'dialogue' | 'narration' | 'action' | 'ooc' | 'dice' | 'scene_change' | 'system' | 'media'; hidden: boolean; speaker_character_id: string | null; speaker_name_override: string | null;
  tts_text: string | null; character_asset_ids: CharacterPlacement[]; expression_ids: Record<string, string>; dialogue_style: Record<string, any>; voice_profile_id: string | null; audio_asset_id: string | null;
  style_instruction: string; transition: string; effect: string; estimated_duration_ms: number; actual_audio_duration_ms: number | null; ai_suggestion?: Record<string, any> | null;
  content: string; display_text: string; event_type: LogEventType; speaker_display_name: string; speaker_role: string; dice: LogEvent['dice']; media: LogEvent['media']; sequence_number: number;
  audio_duration_ms: number | null; word_timestamps: { word: string; start_ms: number; end_ms: number }[] | null; audio_is_mock: boolean | null; audio_mime: string | null; character_name: string | null;
}
export interface Presentation { id: string; project_id: string; snapshot_id: string; title: string; settings: Record<string, any>; style_profile_id: string | null; version: number; created_by: string; created_at: string; updated_at: string; snapshot_scope?: string; snapshot_version?: number; line_count?: number; voiced_count?: number; scenes?: PresentationScene[]; events?: PresentationEvent[]; can_edit?: boolean; character_visuals?: { character_id: string; name: string; default_asset_id: string | null; expressions: Record<string, string>; color: string }[] }

export interface VnScriptJob { id: string; snapshot_id: string; project_id: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; provider: string; model: string; progress: { chunks_total?: number; chunks_done?: number; lines?: number }; presentation_id: string | null; error: string | null; created_at: string; updated_at: string; title?: string; snapshot_scope?: string; snapshot_version?: number; stats?: { scenes: number; shown: number; hidden: number } | null; script?: { scenes: { key: string; title: string; summary: string; background_brief: string; background_asset_id: string | null; lines: { event_id: string; hidden: boolean; exclusion_reason?: string }[] }[]; asset_needs: { kind: string; brief: string; scene_key: string; character_id: string | null; subtitle?: string; name?: string }[]; notes: string[]; provider: string; blocks?: number; generation?: VnGeneration } | null; generation?: VnGeneration | null }
export interface VnGeneration { enabled: boolean; backgrounds: { name: string; scene_key: string; job_id: string }[]; portraits: { character_id: string; subtitle: string; job_id: string }[] }
export interface VoiceProfile { id: string; channel_id: string; character_id: string | null; character_name?: string | null; name: string; provider: string; model_id: string; voice_id: string; voice_type: 'preset' | 'design' | 'clone'; language: string; dialect: string; style_instruction: string; pronunciation_dictionary_id: string | null; synthesis_parameters: Record<string, any>; consent_metadata: Record<string, any> | null; design_prompt: string | null; version: number; created_at: string; cached_lines?: number }
export interface PronunciationDictionary { id: string; name: string; entries: { term: string; reading: string; mode: 'replace' | 'phoneme'; language: string }[]; version: number }
export interface TtsJob { id: string; presentation_id: string | null; kind: string; scope: Record<string, any>; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; total: number; done: number; failed: number; cached: number; estimated_chars: number; estimated_cost: number; provider: string; error: string | null; result: Record<string, any>; created_at: string; finished_at: string | null }
export interface UserLite { id: string; username: string; display_name: string }
export interface ServerMember extends UserLite { role: 'owner' | 'admin' | 'member'; joined_at: string }
export interface ChannelMember extends UserLite { role: 'gm' | 'player'; characters: { id: string; name: string }[] | null }
export type Feature = 'consistency' | 'dice' | 'inspiration' | 'log_studio' | 'coc7_points';
export interface AiPolicyUsage { token_budget: number; image_budget: number; period: 'month' | 'total'; max_concurrent: number; period_start: string | null; tokens_used: number; images_used: number; running: number }
export interface ServerSettings {
  server_id: string; name: string; language: string; features: Record<Feature, boolean>; llm_mode: 'live' | 'mock'; images_enabled?: boolean; is_maintainer?: boolean;
  llm?: { provider: 'mock' | 'openai_compatible' | 'anthropic'; api_base: string; model: string; reasoning_effort: string; embedding_model: string; api_key_set: boolean; api_key_hint: string };
  tts?: { provider: 'disabled' | 'mock' | 'qwen'; api_base: string; model: string; voice: string; api_key_set: boolean; api_key_hint: string };
  image?: { provider: 'disabled' | 'mock' | 'gpt_image'; api_base: string; model: string; size: string; quality: string; api_key_set: boolean; api_key_hint: string };
  ai_policy?: AiPolicyUsage; private_endpoints_allowed?: boolean;
  languages?: string[];
}
export interface DiceTextGroup { id: string; name: string; base: 'en' | 'zh'; texts: Record<string, string>; updated_at: string; created_by_name?: string | null }
export interface BuiltinDiceTexts { keys: string[]; en: Record<string, string>; zh: Record<string, string> }
export interface CharacterAttributes { character_id: string; name: string; kind: 'pc' | 'npc'; attrs: Record<string, number>; editable: boolean }
