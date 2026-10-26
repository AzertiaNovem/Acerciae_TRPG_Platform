// Shared API types (mirrors backend JSON shapes).
export interface User { id: string; username: string; display_name: string }
export interface Server { id: string; name: string; owner_id: string; my_role: string }
export interface Channel {
  id: string; server_id: string; name: string; description: string; rule_system: string;
  knowledge_mode: 'public' | 'isolated'; current_scene_id: string | null; current_scene_title?: string | null;
  ai_enabled: boolean; my_role: 'gm' | 'player'; my_character_ids: string[];
  dice_text_group: string;   // '' = follow server language | 'builtin:en' | 'builtin:zh' | text group id
}
export interface WindowMember { user_id: string; character_id: string | null; display_name: string; character_name: string | null }
export interface ChatWindow {
  id: string; channel_id: string; name: string; kind: 'main' | 'group' | 'private'; active_scene_id: string | null;
  scene_title?: string | null; members: WindowMember[] | null; last_seq: number | null;
}
export interface Character { id: string; channel_id: string; user_id: string | null; name: string; kind: 'pc' | 'npc'; speaking_style: string; sheet: Record<string, unknown>; player_name?: string | null }
export interface Message {
  id: string; channel_id: string; chat_window_id: string; scene_id: string | null; author_id: string; author_role: 'gm' | 'player';
  character_id: string | null; character_name: string | null; author_name: string; kind: 'ic' | 'ooc' | 'narration' | 'roll' | 'system';
  content: string; visibility: 'window' | 'gm_only' | 'whisper'; whisper_to: string[]; seq: number; created_at: string;
  dice?: DiceResult | null;
}
export interface DiceResult { type: string; command: string; text: string; hidden?: boolean; [k: string]: unknown }
export interface Scene { id: string; title: string; location: string; narrative_time: string; status: 'active' | 'closed'; summary: string; off_module: boolean; sequence: number; event_count?: number; windows?: { chat_window_id: string; name: string }[] | null }
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
export interface UserLite { id: string; username: string; display_name: string }
export interface ServerMember extends UserLite { role: 'owner' | 'admin' | 'member'; joined_at: string }
export interface ChannelMember extends UserLite { role: 'gm' | 'player'; characters: { id: string; name: string }[] | null }
export type Feature = 'consistency' | 'dice' | 'inspiration';
export interface ServerSettings {
  server_id: string; name: string; language: string; features: Record<Feature, boolean>; llm_mode: 'live' | 'mock'; is_maintainer?: boolean;
  llm?: { api_base: string; model: string; reasoning_effort: string; api_key_set: boolean; api_key_hint: string; default_api_base: string; default_model: string; default_key_configured: boolean };
  tts?: { api_base: string; model: string; voice: string; api_key_set: boolean; api_key_hint: string };
  languages?: string[];
}
export interface DiceTextGroup { id: string; name: string; base: 'en' | 'zh'; texts: Record<string, string>; updated_at: string; created_by_name?: string | null }
export interface BuiltinDiceTexts { keys: string[]; en: Record<string, string>; zh: Record<string, string> }
export interface CharacterAttributes { character_id: string; name: string; kind: 'pc' | 'npc'; attrs: Record<string, number>; editable: boolean }
