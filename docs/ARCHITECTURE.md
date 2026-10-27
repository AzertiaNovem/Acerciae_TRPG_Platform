# Architecture

```
┌───────────────────────────── React + TS (Vite) ─────────────────────────────┐
│ ServerSidebar │ ChannelSidebar │ ChatWindow (MessageList, MessageComposer,    │
│               │                │ ConsistencyResultPanel, InspirationDraftPanel)│
│               │                │ ContextBubbleDock → ContextDocumentViewer,   │
│               │                │   ReminderViewer, KpBoardViewer (pinned)     │
│               │                │ GMWorkspace (ModuleImportPanel, Script-      │
│               │                │   KnowledgePanel, SceneManager = scenarios)  │
│  stores: auth · nav · chat · documents · highlights · reminders · kp · ui     │
└────────────┬──────────────────────────────────────┬─────────────────────────┘
   REST /api/*                              WS /ws/chat   WS /ws/context
┌────────────┴──────────────────────────────────────┴─────────────────────────┐
│                         C++20 backend (Drogon)                              │
│  api/Api.cpp (HTTP layer)      ws/WsGateway + ws/Notifier (WS gateway)      │
│  auth/AuthService              knowledge/Visibility (SQL scope filters)     │
│  chat/ChatService  events/EventStore  scenes/SceneManager + ScenarioService  │
│  reminders/ReminderService      script/ScriptKnowledgeService (+ reviewer)  │
│  knowledge/KnowledgeService (fact–knower, entities, relations)              │
│  documents/DocumentService (proposal validation, ops, revisions, rollback)  │
│  highlights/HighlightService   retrieval/ContextRetrievalService (Tool API)  │
│  llm/LlmGateway ─ OpenAiCompatClient | MockLlmClient ─ SchemaValidator       │
│  observer/ObserverScheduler (observe · consolidate · cleanup loops)         │
│  consistency/ConsistencyService   inspiration/InspirationService            │
│  modules/ModuleImporter (poppler → structuring → graph)   seed/DemoSeed     │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │ libpqxx pool
                      PostgreSQL 16 (FTS, pg_trgm, optional pgvector)
```

## Module boundaries

| Module | Responsibility | Depends on |
|---|---|---|
| `core/` | Config (env), `Db` connection pool + JSON-row queries + migrations, errors, crypto (PBKDF2, HMAC), text utils | – |
| `auth/` | Users, opaque tokens (HMAC-hashed at rest), `ChannelAccess` (role, knowledge mode, controlled characters), membership checks | core |
| `knowledge/Visibility` | Builds the SQL predicates that restrict facts / messages / events / highlights to what a viewer may know | auth |
| `events/EventStore` | Append-only event log with channel-wide `seq`; viewer-filtered search | core, Visibility |
| `scenes/SceneManager` | Scenes, window↔scene links, channel current scene, scene logs | EventStore, Notifier |
| `scenes/ScenarioService` | Scenes as scenarios, a campaign-wide state: the Keeper opens the next scenario or enters a prepared one for every window; the previous one closes, is summarized (GM-edited summaries are never overwritten) and becomes read-only; the observer's stage detection only raises a "New scenario?" suggestion bubble (`auto_scenarios`) | SceneManager, EventStore, LlmGateway, Notifier |
| `reminders/ReminderService` | Reminder bubbles for a player group (after its observer batch) and for the Keeper: the planner quotes chat lines verbatim, every quote is re-verified against readable lines before storage, per-user dismissal, chat-log context around the quotes; maintains the players' per-scenario outlines (`player_scenario_outlines`) | Retrieval, LlmGateway, Notifier |
| `characters/CharacterSpaceService` | The character space: COC7 role card (bounded, mirrored into `sheet.attrs`), bio, asset mode, uploads and generated images attached to avatar / portrait / subtitle slots; Keeper or actor edits | MediaService, CreativeService, Notifier |
| `script/ScriptKnowledgeService` | The Keeper's script knowledge built from a structured module (flow, relationships, clues, foreshadowing, background with page citations); per batch: a first model proposes changes with chat quotes, a second reviews, approved ones are applied and all are logged; the pinned board (next per the script, notes); Keeper edits are final | Retrieval, LlmGateway, ReminderService, Notifier |
| `chat/ChatService` | Servers, channels, windows, characters, messages (each message ⇒ `message.posted` event with its witnessing audience) | Auth, EventStore, SceneManager, DocumentService (core docs on channel creation) |
| `knowledge/KnowledgeService` | Fact–Knower scope derivation (`deriveScope`), entity/relation upsert, viewer queries | Visibility |
| `documents/DocumentService` | `Proposal` → validation → ops → entries/facts/index tables → revision snapshot; GM corrections, rollback, pending proposals | KnowledgeService, Notifier |
| `highlights/HighlightService` | Create (dedup/extend), list by scope, dismiss, expiry sweep | Notifier |
| `retrieval/ContextRetrievalService` | The Tool API (shards, searches, module excerpts, `list_scenarios`, `get_chat_log`, `get_script_knowledge`), rule-based related-history retrieval, prompt snapshots, the hidden knowledge prelude (players: relationships, clues, open threads, story index; Keeper: the script first, then the records), embeddings | KnowledgeService, EventStore, LlmGateway |
| `llm/` | `ILlmClient` abstraction, OpenAI-compatible client (libcurl), deterministic mock, JSON-schema validator, tool-call loop with repair round | core |
| `observer/ObserverScheduler` | The three schedulers, group cursors, task locks, context building, applying extraction output (proposals, highlights, module hints), then scenario detection, script knowledge changes + board + Keeper reminders; the player-group observer (`PlayerGroupObserver.cpp`) summarizes each group's readable chat into its own journals and raises its reminders | everything above |
| `consistency/`, `inspiration/` | User-triggered features; both run under the requesting character's scope | Retrieval, LlmGateway, Highlights |
| `modules/ModuleImporter` | PDF/text → pages → chunked structuring → nodes/edges with citations; GM workspace aggregate | LlmGateway, Notifier |
| `ws/` | Two WebSocket endpoints, subscription registry, audience-aware `Notifier` | Auth |
| `api/` | Route table; each handler: parse → authorise → service → JSON | all services |
| `app/Services` | Composition root; swapping the LLM, rule system or storage happens here | – |

Replacing the model: implement `ILlmClient` and construct it in `Services::build` (or extend `LlmGateway`'s constructor
to switch on `LLM_PROVIDER`). Prompts, schemas and tools are untouched.

Extending rule systems: `channels.rule_system` is carried into the consistency prompt (`rule_hints`); character sheets are
free-form JSONB (`characters.sheet`) so BRP variants need no schema change.

Multiple instances: schedulers coordinate through PostgreSQL (`ai_jobs` partial unique index as the task lock,
`ai_processing_cursors` as progress); HTTP is stateless (token lookup). WebSocket fan-out is per instance.

## Data model (PostgreSQL)

Migrations live in `backend/migrations/` and are applied in order at startup.

* **Identity & structure**: `users`, `auth_tokens`, `servers`, `server_members`, `channels` (`knowledge_mode`,
  `current_scene_id`, `rule_system`), `channel_members` (`gm|player`), `characters` (`pc|npc`, `speaking_style`, `sheet`),
  `chat_windows`, `chat_window_members` (user + character), `chat_window_scenes`.
* **Truth**: `scenes`, `messages` (`visibility: window|gm_only|whisper`, `whisper_to`, FTS + trigram indexes),
  `events` (channel-wide `seq`, `kind`, `payload`, `visibility`, `audience uuid[]` = characters who witnessed it).
* **Memory (shards)**: `knowledge_facts` (kind, summary, data, **status**, scene, `source_event_ids`, version, FTS),
  `knowledge_visibility` (fact × scope × character — the Fact–Knower mapping), `entities`, `fact_entities`,
  `entity_relations`, `clues`, `narrative_threads` (typed index tables), optional `fact_embeddings` (pgvector).
* **Views**: `documents` (one per `doc_type` per channel, `version`, `gm_only`), `document_entries` (stable entry id ⇄ fact,
  `content_md`, created/updated version, soft `removed`), `document_revisions` (ops + full snapshot per version),
  `document_proposals` (every proposal with its decision: committed / rejected / needs_gm_review).
* **Attention**: `highlights` (document, entry, optional text range, reason, kind, sources, priority, scope, expiry).
* **AI bookkeeping**: `ai_jobs` (lock + audit), `ai_processing_cursors` (per channel/kind/group), `consistency_checks`,
  `inspiration_drafts`.
* **Module layer**: `modules`, `module_pages` (FTS), `module_nodes` (type, citations, progress), `module_edges`, `module_hints`.
* **Characters**: `characters` carry `avatar_asset_id`, `portrait_asset_id`, `asset_mode`, `appearance_prompt`, `bio`, `role_card`; `channels.era`; per-subtitle images in `character_visual_profiles.expressions`.
* **Scenarios**: `scenes` carry `auto_detected`, `stage_reason`, `boundary_event_id`, `summary_status` (`none|pending|ready|gm_edited`),
  `key_points`, `summary_source_event_ids`; `channels.auto_scenarios`.
* **Reminders**: `reminders` (group or Keeper, kind, title, why, `citations[{event_id, …, quotes[]}]`, `script_refs`, dedupe key,
  expiry), `reminder_dismissals` (per user), `player_scenario_outlines` (the players' hidden story index).
* **Script knowledge (Keeper)**: `script_knowledge` (kind `flow|relationship|clue|foreshadowing|background`, body, data,
  page citations, node ids, flow position, status `pending|active|done|skipped`, origin `script|play|gm`, `gm_edited`),
  `script_knowledge_changes` (proposal, verified evidence, reviewer verdict and reason, applied), `kp_board` (`next`, `notes`).

Foreign keys cascade from channel downwards, so server/channel isolation holds at the storage level; every query is also
scoped by `channel_id`.

## Permission model

`ChannelAccess` = {channel, user, isGm, knowledgeMode, controlled character ids}. `Visibility` turns it into SQL:

| Object | GM | Player |
|---|---|---|
| Messages | all | member of the window ∧ (`window` visibility ∨ whisper addressed to one of their characters) |
| Events | all | `public` ∨ (not `gm_only` ∧ audience ∩ their characters ≠ ∅) |
| Facts | all | `knowledge_visibility` has `public` or `character` row for one of their characters |
| Highlights | gm/public/character + own | public ∨ their characters' ∨ their own user-scoped |
| Documents | all | not `gm_only`; entries filtered as facts |
| Module layer, proposals, jobs | all | forbidden |
| Reminders | the Keeper's own | their group's; opening one re-runs the chat-log filter |
| Script knowledge, board, changes | all | forbidden (403); never in a player prelude or tool list |

The same `ChannelAccess` is passed into the Tool API, so the model working for a player cannot retrieve more than the
player could. The observer runs with a system/GM-scope identity for *reading*, but everything it *writes* gets its scope
derived from the cited events (see DATA_FLOW).

## Epistemic status

| status | meaning | who may set |
|---|---|---|
| `attempted` | a character tried something; outcome not adjudicated | AI (player sources), GM |
| `confirmed` | the GM declared it / it happened in the world | AI only with a GM- or system-authored source; GM |
| `npc_claim` | an NPC asserted it | AI, GM |
| `hypothesis` | a player theory | AI, GM |
| `ai_inferred` | the AI's own inference (always traceable) | AI |
| `gm_secret` | GM-only truth | GM (AI proposals are forced to GM scope) |
| `resolved` / `retracted` | closed thread / withdrawn record | AI (non-confirmed), GM |

## Schedulers

| Loop | Default cadence | Work | Lock |
|---|---|---|---|
| observe | 5 s | per (channel, window, scene) group with `seq > cursor`: build context, LLM + tools, validate & commit, highlights, hints; then stage detection (a suggestion bubble for the Keeper), script knowledge propose → review → apply, board refresh, Keeper reminders; advance cursor | in-process set + `ai_jobs(channel, kind, group_key) WHERE status='running'` |
| observe (player groups) | same tick | per player group with readable events after its cursor: the group's journals from readable chat only, its scenario outlines, its reminder bubbles | `player:<group>:<version>` group key |
| consolidate | 60 s | per channel when new events exist since its own cursor: thread resolution, duplicate relationships, timeline notes | same |
| cleanup | 30 s | delete expired highlights, push `highlight.expired` | – |

Idempotency: the cursor only advances after a successful commit; a crashed `running` job is marked failed at restart; the
same `seq` range is never re-read by the same group. Explicit `POST /ai/observe-now` waits for an in-flight cycle rather
than racing it.
