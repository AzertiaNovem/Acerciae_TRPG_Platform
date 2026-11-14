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
│  api/Api.cpp + domain routes      ws/WsGateway + ws/Notifier (WS gateway)      │
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
| `scenes/ScenarioService` | Scenes as scenarios, a campaign-wide state: the GM opens the next scenario or enters a prepared one for every window; the previous one closes, is summarized (GM-edited summaries are never overwritten) and becomes read-only; the observer's stage detection only raises a "New scenario?" suggestion bubble (`auto_scenarios`) | SceneManager, EventStore, LlmGateway, Notifier |
| `reminders/ReminderService` | Reminder bubbles for a player group (after its observer batch) and for the GM: the planner quotes chat lines verbatim, every quote is re-verified against readable lines before storage, one combined create/maintain plan with quoted current-batch evidence, version checks and transactional revision history; per-user dismissal, chat-log context around the quotes; maintains the players' per-scenario outlines (`player_scenario_outlines`) | Retrieval, LlmGateway, Notifier |
| `characters/CharacterSpaceService` | The character space: COC7 role card (bounded, mirrored into `sheet.attrs`), bio, asset mode, uploads and generated images attached to avatar / portrait / subtitle slots; GM or actor edits | MediaService, CreativeService, Notifier |
| `script/ScriptKnowledgeService` | The GM's script knowledge built from a structured module (flow, relationships, clues, foreshadowing, background with page citations); per batch: a first model proposes changes with chat quotes, a second reviews, approved ones are applied and all are logged; the pinned board (next per the script, notes); GM edits are final | Retrieval, LlmGateway, ReminderService, Notifier |
| `chat/ChatService` | Servers, channels, windows, characters, messages (each message ⇒ `message.posted` event with its witnessing audience) | Auth, EventStore, SceneManager, DocumentService (core docs on channel creation) |
| `chat/Hypertext`, `chat/HypertextService` | Interactive messages (kind `hypertext`, [HYPERTEXT.md](HYPERTEXT.md)): the card format v1 as pure rules (`Hypertext`: checks, fallback text, state, conditions, interpolation, reply templates, dice policy); posting by channel GMs, each viewer's own state, actions with their claims, limits and replays, closing (`HypertextService`). A card's lines go through `ChatService::postMessage` with a `HypertextOrigin`; maintenance finishes abandoned actions and prunes old ones | Auth, ChatService, EventStore, SceneManager, Notifier |
| `knowledge/KnowledgeService` | Fact–Knower scope derivation (`deriveScope`), entity/relation upsert, viewer queries | Visibility |
| `documents/DocumentService` | `Proposal` → validation → ops → entries/facts/index tables → revision snapshot; GM corrections, rollback, pending proposals | KnowledgeService, Notifier |
| `highlights/HighlightService` | Create (dedup/extend), list by scope, dismiss, expiry sweep | Notifier |
| `retrieval/ContextRetrievalService` | The Tool API (shards, searches, module excerpts, `list_scenarios`, `get_chat_log`, `get_script_knowledge`), rule-based related-history retrieval, prompt snapshots, the hidden knowledge prelude (players: relationships, clues, open threads, story index; GM: the script first, then the records), embeddings | KnowledgeService, EventStore, LlmGateway |
| `llm/` | `ILlmClient` abstraction, OpenAI-compatible client (libcurl), deterministic mock, JSON-schema validator, tool-call loop with repair round | core |
| `observer/ObserverScheduler` | The three schedulers, group cursors, task locks, context building, applying extraction output (proposals, highlights, module hints), then scenario detection, script knowledge changes + board + GM reminders; the player-group observer (`PlayerGroupObserver.cpp`) summarizes each group's readable chat into its own journals and raises its reminders | everything above |
| `consistency/`, `inspiration/` | User-triggered features; both run under the requesting character's scope | Retrieval, LlmGateway, Highlights |
| `modules/ModuleImporter` | PDF/text → pages → chunked structuring → nodes/edges with citations; GM workspace aggregate | LlmGateway, Notifier |
| `ws/` | Two WebSocket endpoints, subscription registry, audience-aware `Notifier` | Auth |
| `api/` | Route table; each handler: parse → authorise → service → JSON | all services |
| `app/Services` | Composition root; swapping the LLM, rule system or storage happens here | – |

The original platform-embedded AI GM/player design was abandoned before implementation. [AI_AGENTS_DESIGN.md](AI_AGENTS_DESIGN.md) is a historical design, not an implementation roadmap.

The implemented [GM Agent](../gm-agent/README.md) runs as an external Node.js client. It signs in with ordinary accounts, reuses the backend HTTP API for reads and actions, and subscribes to WebSocket notifications. Its hosting, model calls, planning, state and co-player orchestration live in `gm-agent/`; it does not invoke C++ services directly or run inside the backend. The platform's own observer and assistance jobs remain separate from this external GM.

The constraint and module-boundary work is implemented; [ENGINEERING_PLAN.md](ENGINEERING_PLAN.md) maps the stages to code, and [CONSTRAINTS.md](CONSTRAINTS.md) is the maintenance registry with regression entry points.

`api/Api.cpp` composes Auth, Channel, Character, Knowledge, Studio and Media route registration plus CORS. `RouteSupport` owns bearer/file-token authentication, request parsing, bounded dispatch, deadlines and error translation. Route groups depend on service facades; policies do not depend on routes.

`ChatService` remains the application facade. `ChannelSettings.cpp`, `CharacterProfiles.cpp`, `WindowService.cpp` and `Messages.cpp` contain cohesive use cases; `ChatQueries` shares message/history projections and server-role lookup. Rule transitions still commit channel settings and card archives together before notifications.

Interactive messages ([HYPERTEXT.md](HYPERTEXT.md)): a channel GM account posts a card (declarative controls and an optional script) through its own route; `HypertextService` stores the public document on the message and the private reply templates beside it. Each app draws the card natively and runs its script on the viewer's device, in QuickJS compiled to WebAssembly with no host functions: a module worker on web and desktop (`frontend/src/hypertext/`), a hidden network-blocked WebView on Android and a WKWebView on iOS, both running the committed bundle `mobile/contracts/hypertext/hypertext-engine.js` built from the same code and WASM bytes. The output is data; the host, then the native side on mobile, then the server validate it. The card logic is ported to Kotlin and Swift and pinned by the shared fixtures in `mobile/contracts/fixtures/`. gm-agent posts roll cards built in code (`gm-agent/src/hypertext.mjs`).

`VnScriptService.cpp` owns jobs and the worker lifecycle. `VnScriptInputs` prepares authorized snapshots; `VnScriptTranscript` builds prompts; `VnScriptMock` and `VnScriptValidation` transform data without I/O; `VnScriptContinuation` handles ranges and continuation; `VnScriptRecovery` decides reusable chunk states and normalizes questions. `VnScriptModel` performs model calls and transactional chunk checkpoints; `VnScriptArt` schedules derived assets. Static facade methods preserve existing callers and unit-test entry points.

`ContentPolicy` contains pure source/audience decisions, while `MediaService` resolves current ownership in channel-scoped queries. Metadata, file reads and offline export share the same delivery decision. Private image origins and private audio cannot redirect to public storage or acquire immutable cache eligibility. Audio cache identities distinguish public and private synthesis.

The external GM's `Table` keeps turn order and shared runtime state. `gm-agent/src/table/` receives that context explicitly and separates scheduling, recovery, context construction, window movement, platform actions, art, planning, social messages and co-player actions. These modules never import the facade or open backend database connections. The injected HTTP client, model clients, clock and persistence remain replaceable in fixtures; the co-player module reads its own authorized context.

On Web/desktop, `AuthPhase` and `ConnectionPhase` describe independent session and socket lifecycles. Auth operations invalidate older attempts and serialize credential writes. `openstudio/projects.ts` composes the project store with `SaveQueue` (revisioned serial writes) and `ProjectLeases` (views/tasks); task orchestration remains in `tasks.ts`. Native clients keep native storage and test the shared session-error contract.

Replacing the model: implement `ILlmClient` and construct it in `Services::build` (or extend `LlmGateway`'s constructor
to switch on `LLM_PROVIDER`). Prompts, schemas and tools are untouched.

Prompt caching: providers reuse the part of a prompt that repeats an earlier one byte for byte, from the start (tools,
then the system prompt, then the messages), at a fraction of the price. Prompts are therefore laid out stable-first:
fixed system prompts, then the knowledge index, then the per-call context; the visual-novel planner sends the assets
every part of a job shares as their own message before the part's lines. The knowledge index goes out as two messages
(`knowledgeMessages`): first what rarely changes (the script's titles and bodies, then the story index, which has its
own 3,500-character share of the 9,000-character index so it cannot crowd out the records), then what play changes (the
script's statuses grouped as `active: …; done: …`, relationships, clues, open threads). Rows that feed a prompt are
read in a fixed order (`ORDER BY`), and the observer's context JSON, written with sorted keys, keeps its stable keys
(channel, characters, chat window) ahead of the changing ones. OpenAI-compatible endpoints cache on their own; OpenAI's
own API (`https://api.openai.com`) is also sent `prompt_cache_key`, a hash of the channel and task, so requests that
share a prefix meet in one cache (other gateways are not sent it: some reject unknown fields).
For Anthropic, `LlmRequest::cache` marks where the reusable prefix ends: `prefix` marks the system prompt (which covers
the tools) and any message flagged `cacheBreakpoint` (the stable knowledge index, the VN assets); `conversation` also marks the
newest message, so each tool-call or schema-repair round reads the round before it. Tasks that repeat within minutes opt
in (GM and player-group observers, stage detection, script-knowledge updates and reviews, reminders, consistency, inspiration, module and
script-knowledge builds, VN parts); calls that rarely repeat stay `off`, since a cache write costs more than plain input.
Usage records keep counting the whole prompt (`prompt_tokens`), so budgets are unchanged; `cache_read_tokens` and
`cache_write_tokens` show the cached share (server settings show it under "Tokens used").

Extending rule systems: `channels.rule_system` is carried into the consistency prompt (`rule_hints`); character sheets are
free-form JSONB (`characters.sheet`) so BRP variants need no schema change.

Multiple instances: schedulers coordinate through PostgreSQL (`ai_jobs` partial unique index as the task lock,
`ai_processing_cursors` as progress); HTTP is stateless (token lookup). WebSocket fan-out is per instance.

Addresses in the web and desktop client (`frontend/src/lib/route.ts`, `hooks/useRouteSync.ts`): every place the user
opens has its own path, kept in the address bar as they move: `/servers/{server}/channels/{channel}/windows/{window}`
for a chat window, `…/characters/{id}/{card|look|background|items}` for a character's space, `…/gm/{overview|module|
script|scenes|knowledge|settings}` for the GM workspace, `…/studio/{log|vn|pdf|voice|assets|published}` for the Log
Studio, `/servers/{server}/watch/{channel}` for a channel read without membership, `/servers/{server}` for a server with
no channel open and `/admin` for the admin panel. Moving somewhere adds a history entry, so Back and Forward walk the
places in order; a server or channel switch writes the address once it is done, so its steps never become entries of
their own, and a place the app leaves on its own (the open window or channel was deleted) replaces the entry. Opening an
address (a reload, a shared link, signing in from one) goes straight there; whatever this account may not open (another
server, a GM page for a player, a deleted window) falls back to the remembered place, with a notice when it came from
a link. The page title names the place. The tab of the GM workspace and of the character space lives in the
navigation store for this; the Studio's view in its own store. Invitation (`/?invite=`) and publication
(`/?publication=`) links stay at the root. Any host must serve `index.html` for unknown paths: the bundled nginx
(`try_files … /index.html`), Cloudflare Pages (no `404.html`, so it serves the app), the Vite dev server and the desktop
shell all do.

Chat history in the web client (`frontend/src/store/chat.ts`, `lib/chatHistory.ts`): each window's lines are kept for
the visit and on the device (IndexedDB, per account and server, at most 1,500 lines per window and 150 windows, removed
on sign-out, discarded unread when the viewer's role or player group changed). Lines pushed on the chat stream are
shown at once in every window of the subscribed channel, but a push is never taken as proof that nothing was missed:
only the server's answer to a check counts. A check asks only for the lines after the last one checked (`after_seq`),
from just before the recent ones kept so recalls reach it; a gap of more than 1,000 lines starts again from the newest
page. The open window is checked every 30 s while the stream is subscribed (to catch a push lost on a connection that
stayed up), every 5 s while it is not, and at once when the stream subscribes again; not while the page is hidden.
Opening a window shows what is kept straight away and checks it only when its last check is that old, so switching
back and forth sends nothing new. Scrolling up pages back until the window's first line.

## Data model (PostgreSQL)

Migrations live in `backend/migrations/` and are applied in order at startup.

* **Identity & structure**: `users`, `auth_tokens`, `servers`, `server_members`, `channels` (`knowledge_mode`,
  `current_scene_id`, `rule_system`), `channel_members` (`gm|player`), `characters` (`pc|npc`, `speaking_style`, `sheet`),
  `chat_windows`, `chat_window_members` (user + character), `chat_window_scenes`.
* **Truth**: `scenes`, `messages` (`visibility: window|gm_only|whisper`, `whisper_to`, FTS + trigram indexes),
  `events` (channel-wide `seq`, `kind`, `payload`, `visibility`, `audience uuid[]` = characters who witnessed it).
* **Interactive messages**: `messages.hypertext` (the public card), `messages.via_*` (the card and the person a line
  came from), `hypertext_cards` (the private reply templates, closing), `hypertext_interactions` (one row per action:
  replays, limits, claims), `hypertext_states` (each viewer's own state).
* **Memory (shards)**: `knowledge_facts` (kind, summary, data, **status**, scene, `source_event_ids`, version, FTS),
  `knowledge_visibility` (fact × scope × character — the Fact–Knower mapping), `entities`, `fact_entities`,
  `entity_relations`, `clues`, `narrative_threads` (typed index tables), optional `fact_embeddings` (pgvector).
* **World record** (per partition, on `entities`): `status` (`active|inactive|missing|dead|destroyed|unknown`), `state` (one short
  line of what is true now), `location_entity_id` (same partition), `state_version`, `state_updated_at`, `state_source_event_ids`,
  `state_by` (`ai|gm`); `entity_state_history` keeps every applied change (version, status, state, location, sources, actor). Written
  only by the observer's `entity_state` op and accepted GM reviews; GM declarations arrive as `gm.declared` events
  (`gm_only`, no chat message).
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
* **Reminders**: `reminders` (group or GM, kind, title, why, `citations[{event_id, …, quotes[]}]`, `script_refs`, dedupe key,
  status, version, review evidence, expiry), `reminder_revisions` (before/after state and evidence), `reminder_dismissals` (per user), `player_scenario_outlines` (the players' hidden story index).
* **Script knowledge (GM)**: `script_knowledge` (kind `flow|relationship|clue|foreshadowing|background`, body, data,
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
| Reminders | the GM's own | their group's; opening one re-runs the chat-log filter |
| World record (`/world`) | the GM's partition | their group's partition; entities their facts mention or whose state cites chat they can still read |
| Script knowledge, board, changes | all | forbidden (403); never in a player prelude or tool list |
| Interactive messages | every card; their own state only; reply templates through no route | a card when they may read its message (spectators: without its script); their own state only; templates never |

The same `ChannelAccess` is passed into the Tool API, so the model working for a player cannot retrieve more than the
player could. The observer runs with a system/GM-scope identity for *reading*, but everything it *writes* gets its scope
derived from the cited events (see DATA_FLOW).

## Epistemic status

| status | meaning | who may set |
|---|---|---|
| `attempted` | a character tried something; outcome not adjudicated | AI (player sources), GM |
| `confirmed` | the GM declared it / it happened in the world | AI only with a GM- or system-authored source (GM narration or a `gm.declared` event); GM |
| `npc_claim` | an NPC asserted it | AI, GM |
| `hypothesis` | a player theory | AI, GM |
| `ai_inferred` | the AI's own inference (always traceable) | AI |
| `gm_secret` | GM-only truth | GM (AI proposals are forced to GM scope; a fact citing a secret `gm.declared` event is always `gm_secret`) |
| `resolved` / `retracted` | closed thread / withdrawn record | AI (non-confirmed), GM |

## Schedulers

| Loop | Default cadence | Work | Lock |
|---|---|---|---|
| observe | 5 s | per (channel, window, scene) group with `seq > cursor`: build context, LLM + tools, validate & commit (documents, then `entity_state` world changes), highlights, hints; then stage detection (a suggestion bubble for the GM), script knowledge propose → review → apply, board refresh, GM reminders; advance cursor | in-process set + `ai_jobs(channel, kind, group_key) WHERE status='running'` |
| observe (player groups) | same tick | per player group with readable events after its cursor: the group's journals and world record from readable chat only, its scenario outlines, its reminder bubbles | `player:<group>:<version>` group key |
| consolidate | 60 s | per channel when new events exist since its own cursor: thread resolution, duplicate relationships, timeline notes | same |
| cleanup | 30 s | delete expired highlights, push `highlight.expired` | – |

Idempotency: the cursor only advances after a successful commit; a crashed `running` job is marked failed at restart; the
same `seq` range is never re-read by the same group. Explicit `POST /ai/observe-now` waits for an in-flight cycle rather
than racing it.
