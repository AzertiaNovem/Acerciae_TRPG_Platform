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
