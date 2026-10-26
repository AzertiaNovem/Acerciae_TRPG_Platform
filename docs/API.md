# API reference

Base URL `/api`. JSON in/out. Authentication: `Authorization: Bearer <token>` (tokens from `/auth/login`).
Errors: `{ "error": "<code>", "message": "..." }` with 400/401/403/404/409/500.

## Health & LLM
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{status, llm_mode: "mock"|"live", db, ws_connections}` |
| GET | `/llm/status` | mode, model, provider, embeddings flag, note |

## Auth
| POST | `/auth/register` | `{username, password, display_name}` → `{token, user}` |
| POST | `/auth/login` | `{username, password}` → `{token, user}` |
| POST | `/auth/logout` | |
| GET | `/auth/me` | |

## Servers
| GET/POST | `/servers` | list mine / create `{name}` |
| POST | `/servers/{id}/join` | |
| GET/POST | `/servers/{id}/members` | add `{user_id | username, role: admin|member}` (maintainer; only the owner grants `admin` = maintainer) |
| PUT | `/servers/{id}/members/{uid}` | `{role: admin|member}` (owner) |
| DELETE | `/servers/{id}/members/{uid}` | maintainer removes a member (owner removes maintainers; anyone may leave); also drops their channel and chat-window memberships |
| GET/PUT | `/servers/{id}/settings` | members get `{name, language, features{consistency,dice,inspiration}, llm_mode, is_maintainer}`; maintainers also get `llm{api_base, model, reasoning_effort, api_key_set, api_key_hint, default_*}` and `tts{api_base, model, voice, api_key_set, api_key_hint}`. PUT (maintainer) takes `{name?, language?, features?, llm?{api_base, api_key, clear_api_key, model, reasoning_effort}, tts?{…same}}` — keys are sealed (AES-256-GCM) and never returned |
| GET/POST | `/servers/{id}/dice-texts` | dice reply text groups; create `{name, base: en|zh, texts:{key: template}}` (maintainer) |
| PUT/DELETE | `/servers/{id}/dice-texts/{gid}` | (maintainer); deleting resets channels that used it |
| GET | `/dice/texts` | built-in texts `{keys, en, zh}` (template placeholders such as `{name}`, `{attr}`, `{roll}`, `{target}`, `{level}`) |
| GET | `/users/search?q=` | `[{id, username, display_name}]` for the member pickers |
| GET/POST | `/servers/{id}/channels` | create `{name, description?, knowledge_mode: public|isolated, rule_system?}` — creator becomes GM; Main Chat + 6 documents created |

## Channels
| GET/PUT | `/channels/{id}` | details incl. `my_role`, `my_character_ids`; GM may update `name, description, knowledge_mode, ai_enabled, dice_text_group` (`''` = follow server language, `builtin:en`, `builtin:zh`, or a text group id) |
| GET/POST | `/channels/{id}/members` | add `{user_id | username, role: gm|player}` (GM; the user must already be on the server unless the GM is a server maintainer) |
| DELETE | `/channels/{id}/members/{uid}` | (GM) also removes them from every chat window of the channel |
| GET/POST | `/channels/{id}/characters` | create `{name, kind: pc|npc, speaking_style?, sheet?, description?}` (NPC: GM) |
| PUT | `/channels/{id}/characters/{cid}` | owner or GM |
| GET/PUT | `/channels/{id}/characters/{cid}/attributes` | `{attrs, editable}`; PUT `{set?: {name: number}, remove?: [name]}` (owner or GM; NPCs: GM). Names are canonicalised (`侦查`, `spot` → `Spot Hidden`) |
| POST | `/channels/{id}/dice/preview` | `{content, chat_window_id, character_id?}` → `{hint, command}` — the composer's gray hint; never rolls |

## Chat windows & messages
| GET/POST | `/channels/{id}/windows` | create `{name, kind: group|private, members:[{user_id, character_id?}], scene_id?}` (GM) |
| GET/POST | `/channels/{id}/windows/{w}/members` | add `{user_id, character_id?}` (GM) |
| DELETE | `/channels/{id}/windows/{w}/members/{uid}` | (GM) |
| GET | `/channels/{id}/windows/{w}/messages?limit&before_seq` | viewer-filtered |
| POST | `/channels/{id}/windows/{w}/messages` | `{content, kind: ic|ooc|narration|roll, character_id?, visibility: window|gm_only|whisper, whisper_to?[]}`. When dice are enabled, Sealdice commands are evaluated: `.r [N#]<expr> [reason]`, `.rh` (hidden), `.ra`/`.rc [N#] [hard|extreme|困难|极难] [b|p[n]] <skill> [value][±mod] [reason]`, `.rah`, `.sc <ok>/<fail> [SAN]`, `.st <name><value>…` / `.st <name>±<dice>` / `.st show|del|clr`, `.en <skill>`. The message keeps the command as `content`, gets `kind: roll` and `dice: {type, command, text, …}`; hidden rolls are whispered to the roller's character and the window gets a `hidden_notice`. Errors (no character, unknown attribute) return 400 `dice_error` |
| POST | `/channels/{id}/windows/{w}/scene` | `{scene_id}` move window into scene (GM) |
| GET | `/channels/{id}/messages?q=` | search |
| GET | `/channels/{id}/messages/{mid}` | |

## Scenes & events
| GET/POST | `/channels/{id}/scenes` | create `{title, location?, narrative_time?, summary?}` (GM) |
| GET/PUT | `/channels/{id}/scenes/{sid}` | |
| POST | `/channels/{id}/scenes/{sid}/close` | |
| GET | `/channels/{id}/scenes/{sid}/log?limit&after_seq` | viewer-filtered raw log |
| GET | `/channels/{id}/events?q=&scene_id=` or `?ids=a,b,c` | search / fetch by ids (viewer-filtered) |
| GET | `/channels/{id}/events/{eid}` | |

## Documents
| GET | `/channels/{id}/documents` | summaries: `version, entry_count, recent_changes, preview, gm_only` |
| GET | `/channels/{id}/documents/{did}?scene_id&since_version` | entries (viewer-filtered) + `markdown`; `current_scene` filters by scene; `changed_since` per entry |
| GET | `/channels/{id}/documents/{did}/revisions` | |
| GET | `/channels/{id}/documents/{did}/revisions/{v}` | ops + snapshot (players: filtered snapshot) |
| POST | `/channels/{id}/documents/{did}/rollback` | `{version}` (GM) |
| PUT | `/channels/{id}/documents/{did}/entries/{eid}` | GM correction `{summary?, status?, content_md?, data?, visibility?{scope, character_ids}, reason?, expected_version?}` |
| GET | `/channels/{id}/entries/{eid}` · `/related` | entry · related entries |
| GET | `/channels/{id}/proposals?status=needs_gm_review` | (GM) |
| POST | `/channels/{id}/proposals/{pid}/decide` | `{accept: bool}` (GM) — also applies knowledge-sharing suggestions |

## Highlights
| GET | `/channels/{id}/highlights?document_id` | active, scope-filtered |
| POST | `/channels/{id}/highlights/{hid}/dismiss` | |

## Knowledge / shards
| GET | `/channels/{id}/facts?kind&q&scene_id` · `/facts/{fid}` | viewer-filtered facts |
| GET/PUT | `/channels/{id}/facts/{fid}/visibility` | `{scope: gm|public|character, character_ids[]}` (PUT: GM) |
| GET | `/channels/{id}/entities?q` · `/entities/{eid}` | entity graph |
| GET | `/channels/{id}/knowledge/{cid}` | facts a character knows (own character or GM) |
| POST | `/channels/{id}/tools/{tool}` | execute a Tool API call under the caller's identity (`search_scene_history`, `get_entity`, …) |
| GET | `/channels/{id}/shards?id=clue/<uuid>` | shard fetch |

## AI auxiliary features (user-triggered)
Both return 403 `feature_disabled` when a server maintainer turned the feature off. Requests use the server's LLM profile (model, reasoning effort, output language).

| POST | `/channels/{id}/consistency` | `{chat_window_id, character_id?, draft}` → `{score|null, score_label, insufficient_evidence, rationale, conflicts[], evidence[], highlights[], llm_mode}` |
| GET | `/channels/{id}/consistency/history` | my checks |
| POST | `/channels/{id}/inspiration` | `{chat_window_id, character_id?, hint?, variant?}` → `{draft, used_fact_ids, editable: true, auto_sent: false}` |

## AI observer admin
| GET | `/channels/{id}/ai/status` | scheduler status, LLM status, cursors |
| GET | `/channels/{id}/ai/jobs` | (GM) |
| POST | `/channels/{id}/ai/observe-now` · `/consolidate-now` · `/cleanup-highlights` | (GM) run synchronously |

## Modules / GM workspace (GM only)
| GET | `/channels/{id}/modules` · `/modules/{mid}` · `/modules/{mid}/pages/{n}` | |
| POST | `/channels/{id}/modules` | multipart `file` (PDF) + `title`; processed asynchronously (`status: uploaded→extracting→structuring→ready`) |
| POST | `/channels/{id}/modules/text` | `{title, pages:[...] | text}` synchronous import |
| PUT | `/channels/{id}/modules/nodes/{nid}` | `{name?, description?, node_type?, progress?}` |
| GET | `/channels/{id}/modules/hints?status=potential` | potential associations |
| POST | `/channels/{id}/modules/hints/{hid}/decide` | `{decision: accepted|dismissed}` |
| GET | `/channels/{id}/gm/workspace` | modules, scenes vs module, pending hints/proposals, node progress, GM-only facts, recent jobs |

## WebSocket
Connect with `?token=` to `/ws/chat` or `/ws/context`, then send `{"type":"subscribe","channel_id":"..."}`.

Chat stream: `message.posted {message}` (only to users allowed to read it), `window.changed {window}`, `scene.changed {scene}`,
`character.updated {character}` (attribute changes; NPCs to GMs only), `server.settings {server_id, settings}` (public view).

Context stream: `document.updated {document_id, doc_type, version, change_count, entry_ids, gm_only, actor, summary}`,
`highlight.created {highlight}` (scope-filtered), `highlight.expired {highlight_ids}`, `proposal.pending` (GM),
`module.updated` (GM), `ai.job {job}` (GM), `scene.changed`.

Both streams answer `{"type":"ping"}` with `pong`. The upgrade must be the first request on its TCP connection (browsers
always do this).

## Log Studio contracts

All paths in this section start with `/api/channels/{channel_id}/studio` unless stated otherwise. The channel is the campaign. Existing chat, document and mobile contracts are retained. IDs are UUIDs from responses; JSON timestamps in Canonical events are Unix seconds, while database task timestamps are ISO strings. Unknown optional fields must be tolerated by clients.

| Method | Suffix | Contract |
|---|---|---|
| GET/PUT | `/settings` | `{studio_cloud_allowed:boolean,tts_budget_chars:integer}`; PUT requires channel GM. Default cloud processing is off. |
| GET | `/adapters` | Supported adapter names and precise compatibility descriptions. |
| GET/POST | `/projects` | Create `{title,description?,source_kind?:channel\|import\|mixed}`. List counts are audience-filtered. |
| GET/PUT/DELETE | `/projects/{p}` | PUT/DELETE GM. PUT supports title/description/character_map keyed by speaker key. Mapping has character_id/display_name/role/color; omitted identity fields stay unchanged. |
| GET | `/projects/{p}/events?limit=500&after_seq=0&scene_key=` | Ordered visible events. Paginate by last sequence number; do not assume sequence numbers are contiguous after permission filtering. |
| PUT | `/projects/{p}/events/{e}` | GM changes classification/mapping/scene metadata; original content cannot be rewritten. |
| POST | `/projects/{p}/sync` | `{mode:campaign\|scenes\|range\|session,scene_ids?,from_seq?,to_seq?,from?,to?,chat_window_ids?}`. Explicit pull; existing snapshot content stays frozen. |
| GET | `/projects/{p}/scenes` · `/scenes/suggest` | Visible scene summaries / existing scene-boundary suggestions. |
| POST | `/projects/{p}/scenes/split` · `/merge` · `/rename` | GM: `{from_seq,title}`, `{scene_key,into_key}`, `{scene_key,title}` respectively. |
| GET/POST | `/projects/{p}/imports` | POST multipart file + adapter, or JSON `{text,adapter}`. Returns persisted preview, speaker_map, issues and stats; does not commit events. |
| POST | `/projects/{p}/imports/{i}/commit` | GM `{speaker_map:{key:{character_id?,display_name?,role?,color?}}}`. |
| GET | `/imports/{i}/errors` | GM parser diagnostics, including retained unrecognized data. |
| GET/POST | `/projects/{p}/snapshots` | POST `{title?,scope:gm_full\|pl_public\|character,scope_character_id?,selection?:{mode,...}}`. Selection supports campaign, scenes (`scene_keys`), range, session, events (`event_ids`). |
| GET | `/snapshots/{s}?events=false` | Omit `events=false` for frozen ordered events and filtered frozen role map. |
| GET | `/snapshots/{s}/export?format=json\|txt\|html\|sealdice_txt` | Permission-filtered download; native JSON is schemaVersion 1.0. |

A Canonical event includes `event_id`, `campaign_id`, `speaker_id` (alias of stable `speaker_key`), `speaker_display_name`, nullable `speaker_character_id`, `event_type`, original `content`, nullable `timestamp`, `sequence_number`, scene/window IDs, `visibility_scope:public|gm|character`, `audience`, `source_reference`, `metadata`, `raw_text`, optional `dice` and `media`. The complete exchange schema is [LOG_SCHEMA.json](LOG_SCHEMA.json). `metadata.dice_result` is the exact structured chat dice object; `content` retains the original command such as `.ra 侦查 55`. A result is never rerolled during import/export. Hidden rolls keep their secret audience; the public `hidden_notice` is not a result and contains no total or target. Native clients should render `dice.text` for live chat results and preserve the whole `dice` object for structured controls.

### Existing performance and media contracts

Automatic visual-novel template generation is outside this change. Existing manually authored presentations are still supported; publication and TTS reuse them.

| Method | Suffix | Contract |
|---|---|---|
| GET | `/presentations?project_id=` | Audience-filtered list. |
| POST | `/snapshots/{s}/presentations` | `{title?,style_profile_id?,settings?}` creates the existing basic presentation from a snapshot. |
| GET/PUT/DELETE | `/presentations/{p}` | Owner/GM edits; snapshot permissions always checked. |
| PUT | `/pscenes/{scene}` | Title, approved background/BGM IDs, environment, transition, lock. Assets must belong to the channel and match audience. |
| PUT | `/pevents/{event}` | Performance-only fields: hidden, display_kind, segments, voice, tts_text, style_instruction, assets/positions/effects. Canonical text remains immutable. |
| POST | `/presentations/{p}/events/bulk` · `/merge` · `/reorder` | Existing edit operations; all event IDs must belong to the specified presentation. |
| POST | `/pevents/{event}/split` · `/suggestion` | Split uses character ranges; suggestion decision uses `{accept:boolean}`. |
| GET/POST | `/presentations/{p}/progress` | Per-user reading position. |
| GET/POST | `/styles` | Versioned campaign art direction (POST GM). |
| PUT | `/styles/{id}` | GM edits/version bump. |
| GET | `/character-visuals` | NPC profiles are GM-only. |
| PUT | `/character-visuals/{character}` | Owner/GM maintains identity and reference/default assets. |

Media routes are under `/api/channels/{channel_id}/media`, not `/studio/media`. `GET /media` lists metadata; `POST /media/upload` accepts multipart `file` and metadata. `GET /media/{id}/meta`, `PUT /media/{id}`, `DELETE /media/{id}` manage metadata; `POST /media/{id}/versions` uploads a replacement. `GET /media/{id}?v=N` returns bytes after authorization. Browser media URLs may carry `?token=...`; native clients should use `Authorization: Bearer ...` headers. Never copy authenticated media URLs into public pages; use publication file endpoints.

### Voices and generation

| Method | Suffix | Contract |
|---|---|---|
| GET | `/tts/status` · `/tts/available-voices` · `/tts/usage` | Provider/capabilities, configured presets, application character budget and cache usage. |
| GET/POST | `/voices` | POST `{name,character_id?,voice_type:preset\|design\|clone,voice_id?,model_id?,language?,dialect?,style_instruction?,pronunciation_dictionary_id?,synthesis_parameters?,design_prompt?}`. Clone uses multipart reference audio plus consent_metadata JSON. |
| PUT/DELETE | `/voices/{v}` | Creator/GM; edits increment profile version. Player profiles must belong to their own character. |
| GET/POST | `/dictionaries` | Full dictionary contents are GM-only (players receive an empty list). POST GM `{name,entries:[{term,reading,mode:replace\|phoneme,language}]}`. |
| PUT | `/dictionaries/{d}` | GM updates entries and increments version. |
| POST | `/tts/preview` | `{voice_profile_id,text,style_instruction?,model_id?}` → stored audio metadata; owner/GM audition. |
| POST | `/presentations/{p}/tts/estimate` | `{event_ids?,scene_ids?,force?,model_id?}` → lines, chars, cached_lines, lines_to_synthesize, estimated_cost, cost_known, currency_note, within_budget. Show unknown cost honestly. |
| POST | `/presentations/{p}/tts/jobs` | `{scope?:{event_ids?,scene_ids?},force?,retry?,model_id?}`. Estimate scope is flattened; submission scope is nested. |
| GET | `/presentations/{p}/tts/jobs` · `/tts/jobs/{j}` | Persisted state/progress. |
| POST | `/tts/jobs/{j}/cancel` | Owner/GM; pending work cancelled, completed provider charges not reversible. |
| GET | `/tts/audio/{audio}` | Authorized stored audio bytes; repeat playback performs no provider call. |
| GET | `/images/status` | Disabled/mock/http provider state. |
| GET/POST | `/images/jobs` | GM POST `{kind:background\|standee,style_profile_id,character_id?,prompt,snapshot_id?,event_ids?,allow_cloud?,request_id?}`. |
| POST | `/images/jobs/{j}/cancel` | GM cancels pending/running generation. |
| POST | `/presentations/{p}/suggest` | GM `{event_ids:[presentation event IDs],allow_cloud?}` → candidate delivery instructions/reasons. No fact edits. |

See [TTS_PROVIDER.md](TTS_PROVIDER.md) and [ASSETS.md](ASSETS.md) for exact provider contracts, consent, caching, retry semantics and mock limitations.

### PDF and publishing

| Method | Suffix | Contract |
|---|---|---|
| GET/POST | `/pdf/templates` | Built-ins plus saved templates. GM POST `{name,config}` saves a template. |
| POST | `/snapshots/{s}/pdf` | `{config,appendix_document_ids?,retry?}` creates/reuses a frozen render job; `retry:true` requeues failed jobs. |
| GET | `/pdf/jobs` · `/pdf/jobs/{j}` | Permission-filtered job states/errors. |
| GET | `/pdf/jobs/{j}/file` | Completed PDF bytes, with audited access. |
| GET/POST | `/publications` | GM POST `{snapshot_id,title?,kind:styled\|pdf\|vn,visibility:gm\|players\|link,pdf_job_id?,presentation_id?}`. Link token is returned only when created. |
| GET | `/publications/{p}` · `/publications/{p}/files/{asset_or_audio_id\|pdf}` | Authenticated frozen artifact and files. |
| POST | `/publications/{p}/revoke` | GM revokes content and file access. |

Anonymous routes are `GET /api/published/{token}` and `GET /api/published/{token}/files/{asset_or_audio_id|pdf}`. They authorize only the explicitly published frozen content. Viewer URL is `/?publication={token}`. The backend never exposes internal object keys in a publication response. Internal PDF-worker routes use `X-Worker-Token` and per-job leases, described in [PDF_TEMPLATES.md](PDF_TEMPLATES.md).

Context WebSocket notifications include `studio.tts.progress`, `studio.tts.finished`, `studio.pdf.updated`, `studio.asset.generated`. Existing presentation changes arrive as `module.updated` with `payload.kind: "presentation.updated"`. Sensitive task notifications are GM-only; clients must poll authorized job endpoints and refetch after reconnecting. Do not infer permission from receiving an ID.

Server maintainers and channel GMs are different authorities: maintainer status controls encrypted provider credentials, endpoint region, language and feature toggles; GM status controls campaign snapshots, production cloud permission, budgets, asset review and publication. A channel GM is not automatically a server administrator. The backend remains authoritative for all these checks; clients should handle 400 validation, 403 forbidden, 404 unavailable and 429 budget/provider limits without falling back to a broader endpoint.
