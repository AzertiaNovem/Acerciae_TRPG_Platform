# Architecture

```
┌───────────────────────────── React + TS (Vite) ─────────────────────────────┐
│ ServerSidebar │ ChannelSidebar │ ChatWindow (MessageList, MessageComposer,    │
│               │                │ ConsistencyResultPanel, InspirationDraftPanel)│
│               │                │ ContextBubbleDock → ContextDocumentViewer    │
│               │                │ GMWorkspace (ModuleImportPanel, SceneManager)│
│  stores: auth · nav · chat · documents · highlights · ui   (zustand)          │
└────────────┬──────────────────────────────────────┬─────────────────────────┘
   REST /api/*                              WS /ws/chat   WS /ws/context
┌────────────┴──────────────────────────────────────┴─────────────────────────┐
│                         C++20 backend (Drogon)                              │
│  api/Api.cpp (HTTP layer)      ws/WsGateway + ws/Notifier (WS gateway)      │
│  auth/AuthService              knowledge/Visibility (SQL scope filters)     │
│  chat/ChatService  events/EventStore  scenes/SceneManager                    │
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
| `chat/ChatService` | Servers, channels, windows, characters, messages (each message ⇒ `message.posted` event with its witnessing audience) | Auth, EventStore, SceneManager, DocumentService (core docs on channel creation) |
| `knowledge/KnowledgeService` | Fact–Knower scope derivation (`deriveScope`), entity/relation upsert, viewer queries | Visibility |
| `documents/DocumentService` | `Proposal` → validation → ops → entries/facts/index tables → revision snapshot; GM corrections, rollback, pending proposals | KnowledgeService, Notifier |
| `highlights/HighlightService` | Create (dedup/extend), list by scope, dismiss, expiry sweep | Notifier |
| `retrieval/ContextRetrievalService` | The Tool API (shards, searches, module excerpts), rule-based related-history retrieval, prompt snapshots, embeddings | KnowledgeService, EventStore, LlmGateway |
| `llm/` | `ILlmClient` abstraction, OpenAI-compatible client (libcurl), deterministic mock, JSON-schema validator, tool-call loop with repair round | core |
| `observer/ObserverScheduler` | The three schedulers, group cursors, task locks, context building, applying extraction output (proposals, highlights, module hints, knowledge suggestions) | everything above |
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
| observe | 5 s | per (channel, window, scene) group with `seq > cursor`: build context, LLM + tools, validate & commit, highlights, hints, suggestions, advance cursor | in-process set + `ai_jobs(channel, kind, group_key) WHERE status='running'` |
| consolidate | 60 s | per channel when new events exist since its own cursor: thread resolution, duplicate relationships, timeline notes | same |
| cleanup | 30 s | delete expired highlights, push `highlight.expired` | – |

Idempotency: the cursor only advances after a successful commit; a crashed `running` job is marked failed at restart; the
same `seq` range is never re-read by the same group. Explicit `POST /ai/observe-now` waits for an in-flight cycle rather
than racing it.
