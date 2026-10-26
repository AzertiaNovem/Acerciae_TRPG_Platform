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
| GET/POST | `/servers/{id}/members` | add `{username, role: admin|member}` (admin) |
| GET/POST | `/servers/{id}/channels` | create `{name, description?, knowledge_mode: public|isolated, rule_system?}` — creator becomes GM; Main Chat + 6 documents created |

## Channels
| GET/PUT | `/channels/{id}` | details incl. `my_role`, `my_character_ids`; GM may update `name, description, knowledge_mode, ai_enabled` |
| GET/POST | `/channels/{id}/members` | add `{username, role: gm|player}` (GM) |
| GET/POST | `/channels/{id}/characters` | create `{name, kind: pc|npc, speaking_style?, sheet?, description?}` (NPC: GM) |
| PUT | `/channels/{id}/characters/{cid}` | owner or GM |

## Chat windows & messages
| GET/POST | `/channels/{id}/windows` | create `{name, kind: group|private, members:[{user_id, character_id?}], scene_id?}` (GM) |
| GET/POST | `/channels/{id}/windows/{w}/members` | add `{user_id, character_id?}` (GM) |
| DELETE | `/channels/{id}/windows/{w}/members/{uid}` | (GM) |
| GET | `/channels/{id}/windows/{w}/messages?limit&before_seq` | viewer-filtered |
| POST | `/channels/{id}/windows/{w}/messages` | `{content, kind: ic|ooc|narration|roll, character_id?, visibility: window|gm_only|whisper, whisper_to?[]}` |
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

Chat stream: `message.posted {message}` (only to users allowed to read it), `window.changed {window}`, `scene.changed {scene}`.

Context stream: `document.updated {document_id, doc_type, version, change_count, entry_ids, gm_only, actor, summary}`,
`highlight.created {highlight}` (scope-filtered), `highlight.expired {highlight_ids}`, `proposal.pending` (GM),
`module.updated` (GM), `ai.job {job}` (GM), `scene.changed`.

Both streams answer `{"type":"ping"}` with `pong`. The upgrade must be the first request on its TCP connection (browsers
always do this).
