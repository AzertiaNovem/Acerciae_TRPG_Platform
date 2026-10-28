# API reference

Base URL `/api`. JSON in/out. Authentication: `Authorization: Bearer <token>` (tokens from `/auth/login`).
Errors: `{ "error": "<code>", "message": "..." }` with 400/401/403/404/409/500.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{status, db, ws_connections}` |

AI is configured per server (see `/servers/{id}/settings` below); there is no platform-wide model, key or status route.
Each channel's AI status is `GET /channels/{id}/ai/status`.

## Auth

User objects now include `ui_language`, `avatar_data`, `avatar_version` and `languages`. See [personal settings](USER_SETTINGS.md) for validation, image limits and native client integration.

| Method | Path | Notes |
|---|---|---|
| PUT | `/auth/me` | Atomic partial update of the current user's `{username?,display_name?,ui_language?,avatar_data?}`. Empty avatar removes it; duplicate username returns 409. |
| GET | `/users/{user_id}/avatar` | Raster image bytes, authenticated owner/shared-server members only. |
| POST | `/auth/register` | `{username, password, display_name}` → `{token, user}` |
| POST | `/auth/login` | `{username, password}` → `{token, user}` |
| POST | `/auth/logout` | |
| GET | `/auth/me` | |

## Servers
| GET/POST | `/servers` | list mine / create `{name}` |
| POST | `/servers/{id}/join` | `{invite_code?}` — follows the server's join policy: `open` servers take anyone, `invite` servers need a valid code (410 `invite_invalid` when expired, used up or revoked), `closed` servers refuse (403). A guest who joins becomes a member. |
| GET | `/server-directory?q=` | open servers the caller is not a member of: `[{id, name, member_count}]` |
| GET/POST | `/servers/{id}/invites` | maintainers list / create `{max_uses (0 = unlimited), expires_in_hours (0 = never, default 168)}` → `{id, code, max_uses, uses, expires_at, revoked_at, active}`; refused while the server is closed; at most 50 active |
| DELETE | `/servers/{id}/invites/{invite_id}` | maintainer revokes an invite |
| GET | `/invites/{code}` | `{server_id, name, member_count, valid, already_member}` |
| POST | `/invites/{code}/accept` | joins the invite's server |
| GET | `/servers/{id}/spectate` | channels whose Main Chat the caller may read without being invited (empty unless the server allows spectators; never for guests) |
| GET | `/channels/{id}/spectate?limit&before_seq` | `{channel, window, messages}` — the Main Chat's lines visible to the whole window only (no whispers, no Keeper-only lines, no character art); live lines arrive on the chat socket after `{type:"subscribe", channel_id, spectate:true}` as `spectate.message` |
| GET/POST | `/servers/{id}/members` | add `{user_id | username, role: admin|member}` (maintainer; only the owner grants `admin` = maintainer) |
| PUT | `/servers/{id}/members/{uid}` | `{role: admin|member}` (owner) |
| DELETE | `/servers/{id}/members/{uid}` | maintainer removes a member (owner removes maintainers; anyone may leave); also drops their channel and chat-window memberships |
| GET/PUT | `/servers/{id}/settings` | members get `{name, language, features{consistency,dice,inspiration,log_studio,coc7_points}, policy{join_policy: open|invite|closed, channel_creation: members|maintainers, guest_invites, main_chat_spectators}, llm_mode, images_enabled, is_maintainer}`; PUT (maintainer) accepts the same `policy` object; maintainers also get `llm{provider: mock|openai_compatible|anthropic, api_base, model, reasoning_effort, embedding_model, api_key_set, api_key_hint}`, `image{provider: disabled|mock|gpt_image, api_base, model, size, quality, api_key_set, api_key_hint}`, `tts{provider: disabled|mock|qwen, api_base, model, voice, api_key_set, api_key_hint}`, `ai_policy{token_budget, image_budget, period: month|total, max_concurrent, period_start, tokens_used, images_used, running}` and `private_endpoints_allowed`. PUT (maintainer) takes the same objects plus `api_key` / `clear_api_key` per provider and `ai_policy{token_budget, image_budget, period, max_concurrent, reset_usage}`. A live provider needs its own key; keys are sealed (AES-256-GCM) and never returned. Endpoints must be https on a public address unless the deployment sets `AI_ALLOW_PRIVATE_ENDPOINTS`. Budgets of 0 mean no limit; a spent budget answers AI requests with 429 `ai_budget_exhausted`, and a server already running `max_concurrent` AI tasks makes new ones wait (503 `ai_busy` after two minutes). |
| GET/POST | `/servers/{id}/dice-texts` | dice reply text groups; create `{name, base: en|zh, texts:{key: template}}` (maintainer) |
| PUT/DELETE | `/servers/{id}/dice-texts/{gid}` | (maintainer); deleting resets channels that used it |
| GET | `/dice/texts` | built-in texts `{keys, en, zh}` (template placeholders such as `{name}`, `{attr}`, `{roll}`, `{target}`, `{level}`) |
| GET | `/users/search?q=` | `[{id, username, display_name}]` for the member pickers |
| GET/POST | `/servers/{id}/channels` | create `{name, description?, knowledge_mode: public|isolated, rule_system?}` — creator becomes GM; Main Chat + 6 documents created |

## Channels
| GET/PUT | `/channels/{id}` | details incl. `my_role`, `my_character_ids`, `player_group_id`, `player_group_version`, `player_group_name`; GM may update `name, description, knowledge_mode, ai_enabled, dice_text_group` (`''` = follow server language, `builtin:en`, `builtin:zh`, or a text group id) |
| GET/POST | `/channels/{id}/members` | add `{user_id | username, role: gm|player}` (GM; the user must already be on the server unless the GM is a server maintainer) |
| DELETE | `/channels/{id}/members/{uid}` | (GM) also removes them from every chat window of the channel |
| GET/POST | `/channels/{id}/characters` | create `{name, kind: pc|npc, speaking_style?, sheet?, description?}` (NPC: GM) |
| PUT | `/channels/{id}/characters/{cid}` | owner or GM |
| GET/PUT | `/channels/{id}/characters/{cid}/attributes` | `{attrs, editable}`; PUT `{set?: {name: number}, remove?: [name]}` (owner or GM; NPCs: GM). Names are canonicalised (`侦查`, `spot` → `Spot Hidden`) |
| POST | `/channels/{id}/dice/preview` | `{content, chat_window_id, character_id?}` → `{hint, command}` — the composer's gray hint; never rolls |

## Character space
| GET | `/channels/{id}/characters/{cid}/space` | `{character (with role_card, bio, asset_mode, appearance_prompt, editable), avatar, portrait, subtitles[{subtitle, id, version, …}], jobs[], era, narrative_time, attrs, generation_available}`. Players read any PC's space; NPC spaces are 404 for players. |
| GET | `/api/coc7/rules` | COC7 point-buy reference (any member): `{skills[{name, base}], families[{name, base}], careers[{id, name, credit, points, formula, fixed, choices, free, description}], hobby_formula}`. See [COC7_POINT_BUY.md](COC7_POINT_BUY.md). With the server feature `coc7_points` on, `PUT …/card` recomputes skill totals from `role_card.career` and `role_card.skill_points` and answers `400 points_rule` when a limit is broken; the space carries `points {enabled, career_budget, career_spent, hobby_budget, hobby_spent, characteristics_total, luck, allowed, violations, warnings}`. |
| PUT | `/channels/{id}/characters/{cid}/card` | `{name?, speaking_style?, bio?, role_card?}` (Keeper or the character's actor). The COC7 card: `basic {player, occupation, age, sex, residence, birthplace}`, `characteristics {STR…LUK}`, `derived {hp, hp_max, mp, mp_max, san, san_max, mov, build, db}`, `skills {name: value}`, `background {personal_description, ideology, significant_people, meaningful_locations, treasured_possessions, traits, injuries, phobias, arcane, encounters}`, `items [{name, note, qty}]`, `wealth {cash, assets, spending_level}`. Characteristics, HP/MP/SAN/MOV and skills are mirrored into `sheet.attrs`, which the dice read. |
| PUT | `/channels/{id}/characters/{cid}/appearance` | `{asset_mode: uploaded|generated, appearance_prompt}` |
| POST | `/channels/{id}/characters/{cid}/assets` | multipart `slot` (`avatar`, `portrait`, `subtitle`) + `subtitle` (IDLE, SAY, FIGHT, …) + `file`: an approved image asset of the character, attached to the slot |
| POST | `/channels/{id}/characters/{cid}/assets/generate` | generated mode only: `{slots: [portrait, avatar], subtitles: [...], allow_cloud}` queues one image job per target; the prompt is the appearance prompt plus the channel's `era`, the current scenario's moment and the slot's framing; results are approved and attached when the job completes |
| DELETE | `/channels/{id}/characters/{cid}/assets/{aid}` | detaches and deletes the image |

Chat messages carry `character_avatar_asset_id` and `character_avatar_version`; `PUT /channels/{id}` accepts `era`.

## Chat windows & messages
| GET/POST | `/channels/{id}/windows` | create `{name, kind: group|private, members:[{user_id, character_id?}]}` (GM); a new window joins the campaign's current scenario |
| GET/POST | `/channels/{id}/windows/{w}/members` | add `{user_id, character_id?}` (GM) |
| DELETE | `/channels/{id}/windows/{w}/members/{uid}` | (GM) |
| GET | `/channels/{id}/windows/{w}/messages?limit&before_seq` | viewer-filtered |
| POST | `/channels/{id}/windows/{w}/messages` | `{content, kind: ic|ooc|narration|roll, character_id?, visibility: window|gm_only|whisper, whisper_to?[], reference_ids?: UUID[0..5]}`. When dice are enabled, Sealdice commands are evaluated: `.r [N#]<expr> [reason]`, `.rh` (hidden), `.ra`/`.rc [N#] [hard|extreme|困难|极难] [b|p[n]] <skill> [value][±mod] [reason]`, `.rah`, `.sc <ok>/<fail> [SAN]`, `.st <name><value>…` / `.st <name>±<dice>` / `.st show|del|clr`, `.en <skill>`. The message keeps the command as `content`, gets `kind: roll` and `dice: {type, command, text, …}`; hidden rolls are whispered to the roller's character and the window gets a `hidden_notice`. Errors (no character, unknown attribute) return 400 `dice_error` |
| POST | `/channels/{id}/windows/{w}/scene` | deprecated alias of `/scenarios/enter` (`{scene_id}`); scenarios are campaign-wide, the window is ignored |
| GET | `/channels/{id}/messages?q=` | search |
| GET | `/channels/{id}/messages/{mid}` | |

## Scenes & events
| GET/POST | `/channels/{id}/scenes` | Scenarios (stages of the story; a campaign-wide state, one current scenario for every window; POST prepares one without entering it). GM rows carry `summary`, `key_points`, `summary_status: none|pending|ready|gm_edited`, `auto_detected`, `stage_reason`, `boundary_event_id`; players get neutral `Scene N` labels. POST `{title, location?, narrative_time?, summary?}` (GM) |
| GET/PUT | `/channels/{id}/scenes/{sid}` | PUT (GM): a changed `summary` is marked `gm_edited` and is never overwritten by the model |
| POST | `/channels/{id}/scenes/{sid}/close` | |
| POST | `/channels/{id}/scenes/{sid}/summarize` | (GM) write or rewrite the AI summary of a scenario from its chat log |
| POST | `/channels/{id}/scenarios/advance` | (GM) `{title?, location?, narrative_time?}` opens the next scenario for the whole campaign: every window moves there, the current scenario closes and is summarized, and it can only be consulted from then on. Returns `{scene, previous, windows}`. |
| POST | `/channels/{id}/scenarios/enter` | (GM) `{scene_id}` enters a prepared (never closed) scenario the same way; 409 for a closed one |
| PUT | `/channels/{id}/scenario-settings` | (GM) `{auto_scenarios: bool}` |
| GET | `/channels/{id}/scenes/{sid}/log?limit&after_seq` | viewer-filtered raw log |
| GET | `/channels/{id}/events?q=&scene_id=` or `?ids=a,b,c` | search / fetch by ids (viewer-filtered) |
| GET | `/channels/{id}/events/{eid}` | |

## Documents
| GET | `/channels/{id}/documents` | summaries: `version, entry_count, recent_changes, preview, gm_only` |
| GET | `/channels/{id}/documents/{did}?scene_id&since_version` | entries (viewer-filtered) + `markdown`; `current_scene` filters by scene; `changed_since` per entry |
| GET | `/channels/{id}/documents/{did}/revisions` | |
| GET | `/channels/{id}/documents/{did}/revisions/{v}` | ops + snapshot (same memory partition) |
| POST | `/channels/{id}/documents/{did}/rollback` | `{version}` (GM) |
| PUT | `/channels/{id}/documents/{did}/entries/{eid}` | KP correction `{summary?, status?, content_md?, data?, reason?, expected_version?}` (KP partition only; cannot widen visibility) |
| GET | `/channels/{id}/entries/{eid}` · `/related` | entry · related entries |
| GET | `/channels/{id}/proposals?status=needs_gm_review` | (GM) |
| POST | `/channels/{id}/proposals/{pid}/decide` | `{accept: bool}` (GM) — KP memory proposals only; legacy sharing is retired |

## Reminder bubbles
| GET | `/channels/{id}/reminders` | active reminders for the caller (players: their group's; GM: the Keeper's), minus the ones they dismissed. `{id, kind: forgotten|needed|plan|note, title, why, citations[{event_id, message_id, chat_window_id, scene_id, seq, quotes[]}], scene_id, priority, llm_mode, created_at, expires_at}`. Each quote is a verbatim substring of a line the group can read; a reminder is never stored without a verified quote. Pushed as `reminder.created` on `/ws/context` to the group (or GMs). |
| POST | `/channels/{id}/reminders/{rid}/dismiss` | per-user dismissal |
| GET | `/channels/{id}/reminders/{rid}/context?limit` | the chat log around the first quoted line, viewer-filtered on every call (`events[]` with `cited` and `quotes` on the quoted lines, `anchor_event_id`); 404 for another group |

The group observer raises reminders after each batch of its chat: it reads the group's hidden knowledge index (relationships, clues, open threads, and the story index of per-scenario outlines in `player_scenario_outlines`), the current scenario, the end of the previous one and the newest lines, may fetch more with `get_chat_log`, and proposes at most three "forgotten" or "needed" reminders with quotes. The knowledge index is prepended to player-facing model requests (observer, reminders, consistency, inspiration) and is never shown to players.

## Keeper script knowledge and the pinned board (GM only)
| GET | `/channels/{id}/script-knowledge?kind` | the Keeper's knowledge built from the module: `{id, module_id, kind: flow|relationship|clue|foreshadowing|background, title, body, data, citations[{page, excerpt}], node_ids[], position, status: pending|active|done|skipped, status_event_ids[], origin: script|play|gm, gm_edited, llm_mode}`. `flow` entries are the script's stages in order (`data.location, prerequisites[], keeper_actions[], leads_to[], twists[]`). |
| PUT | `/channels/{id}/script-knowledge/{kid}` | `{title?, body?, status?}` Keeper edit: marks `gm_edited`; the entry is never changed automatically again |
| POST | `/channels/{id}/script-knowledge/rebuild` | `{module_id?}` rebuilds the script-origin entries of a module (Keeper-edited and play-origin entries survive) |
| GET | `/channels/{id}/script-knowledge/changes?limit` | every automatic change proposed from play with the reviewer's verdict: `{op: add|update|status, proposal, evidence[{event_id, text}], verdict: approved|rejected, reviewer_reason, applied, title, kind, status}` |
| GET | `/channels/{id}/kp/board` | the two pinned cards: `next {has_script, current, next, pending_clues[], pending_foreshadowing[], stages_done, stages_total, summary}` and `notes {open_threads[], timeline[], recent_changes[], stages_done[]}`. Pushed as `kp.board` on `/ws/context` to GMs. |

The script knowledge is built when a module finishes structuring (and on rebuild): the flow of the script, NPC and
investigator relationships, clues, foreshadowing and background, each citing module pages. It is prepended to every
Keeper-facing model request before anything else (`KEEPER KNOWLEDGE INDEX`), and the Keeper's tools include
`get_script_knowledge {kind, query}`. After each processed batch of the Keeper's observer a first model proposes
changes from the newest lines (a stage reached, a clue revealed, a twist paid off, a fact the narration established)
with verbatim chat quotes as evidence; a second model reviews each proposal against the quoted lines and the module
citations, and only approved changes are applied. Reaching a later stage closes the running one. Players' knowledge
never passes a reviewer. Keeper reminders may carry `script_refs[{knowledge_id, kind, title, page, excerpt}]` next to
their chat citations; nothing of this is reachable by a player group (403).

## Highlights
| GET | `/channels/{id}/highlights?document_id` | active, scope-filtered |
| POST | `/channels/{id}/highlights/{hid}/dismiss` | |

## Knowledge / shards
| GET | `/channels/{id}/facts?kind&q&scene_id` · `/facts/{fid}` | viewer-filtered facts |
| GET/PUT | `/channels/{id}/facts/{fid}/visibility` | GET returns `scope: gm|player_group` and group identity; PUT returns 409 (direct KP sharing retired) |
| GET | `/channels/{id}/entities?q` · `/entities/{eid}` | entity graph |
| GET | `/channels/{id}/knowledge/{cid}` | facts a character knows (own character or GM) |
| POST | `/channels/{id}/tools/{tool}` | execute a Tool API call under the caller's identity (`search_scene_history`, `get_entity`, `list_scenarios`, `get_chat_log {scene_id?, chat_window_id?, from?, to?, after_seq?, around_event_id?, limit?}` for verbatim lines by scenario, time or around one event, …) |
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
`module.updated` (GM), `ai.job {job}` (GM), `scene.changed`, `reminder.created {reminder}` (its group, or GMs),
`kp.board {board}` (GM), `script.changed {payload}` (GM).

Both streams answer `{"type":"ping"}` with `pong`. The upgrade must be the first request on its TCP connection (browsers
always do this).

## The campaign log (Log Studio)
| GET | `/channels/{id}/studio/log` | the channel's one campaign log, synced from the chat on every call: `{project (event_count, speakers, snapshots, scenes), synced_added, windows[{id, name, kind, line_count, last_at}], scenarios[], last_event_at}`. Viewer-filtered. Nothing is ever imported. |
| GET | `/channels/{id}/studio/log/export?format=json|txt|html|sealdice|zip&chat_window_id=` | viewer-filtered download of the whole campaign (or one window). `json` is the lossless Acerciae format (`schemaVersion 1.0`, `meta {campaign, era, windows, scenarios, characters, character_map}`, every event with its dice, media, metadata and source references). `sealdice` needs `chat_window_id` and returns story-painter's `{version: 105, items[{nickname, IMUserId, time, message, isDice, commandId?, commandInfo?, role}]}` for that window. `zip` bundles the JSON, the text and one SealDice JSON per window. |

Snapshots (`POST /projects/{p}/snapshots` with `selection.mode=campaign`) still freeze the log for PDFs and visual
novels; the UI creates them implicitly. The import, adapter and scene-surgery endpoints are gone.

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

Presentations can be authored by hand or built by a visual-novel script job (below). `settings.template` holds the look template; see [VISUAL_NOVEL.md](VISUAL_NOVEL.md).

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
| GET | `/vn-scripts/status` | `{mock, model, cloud_allowed, images, max_lines, note}`. |
| GET · POST | `/vn-scripts` | Any member. GET lists the caller's jobs (all jobs for the Keeper). POST `{scope?: gm_full\|pl_public\|character, scope_character_id?, title?, template?, instructions?, allow_cloud?, generate_art?}` freezes the campaign log in that scope (players: `pl_public` or their own character) and queues a script job; `{snapshot_id}` plans an existing snapshot instead. `allow_cloud:true` and the campaign cloud policy are required unless the LLM is in mock mode. Template values are validated (400 on bad values). |
| GET | `/vn-scripts/{j}` | The job's author or the Keeper. Job with `status`, `progress {chunks_total, chunks_done, lines}`, validated `script` ([VN_SCRIPT_SCHEMA.json](VN_SCRIPT_SCHEMA.json)) including `generation {backgrounds[], portraits[]}` (queued image jobs) and the draft `presentation_id`. Progress also arrives as `studio.vnscript.progress` WebSocket events. |
| POST | `/vn-scripts/{j}/cancel` | The job's author or the Keeper; pending or running jobs. |
| POST | `/presentations/{p}/cast` | Author or Keeper. `{cast: {narrator: voiceId, <character_id>: voiceId}}` sets the voice of narration/dice/system/scene lines and of each character's dialogue and actions; stored as `settings.cast`. Unknown voices are 400. |
| GET | `/presentations/{p}/bundle.zip` | Anyone who can read the presentation. ZIP with `index.html` (offline player), `script.json`, `assets/*` and `audio/*`. |
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


## Independent player groups and chat references

All paths below are under `/api`. A channel player belongs to one group; KP identities cannot be assigned to groups.
`knowledge_mode=public` allocates new players to the first group; `isolated` creates a separate group for each new player.
Changing the mode does not move existing members.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/channels/{id}/player-groups` | KP: all groups; player: own group. Rows include `id`, `name`, `version`, `members` (`user_id`, `display_name`). |
| POST | `/channels/{id}/player-groups` | KP only, `{name}` (1–100 characters); creates an empty group. |
| PUT | `/channels/{id}/player-groups/{gid}` | KP only, `{name}`; renames a group. |
| PUT | `/channels/{id}/player-groups/{gid}/members/{uid}` | KP only, empty body; moves a channel player to the target group. Returns groups. |

Moving a player invalidates both affected groups' derived memory and increments their versions. Window membership changes
also invalidate affected groups. Raw chat and KP memory remain unchanged. Empty groups remain available for reuse.
`knowledge.reset` on the context WebSocket tells clients to discard cached documents, highlights, chat and pending drafts,
then refetch. Clients should reconcile group versions after reconnect (the web client also polls every ten seconds).
A group member can read a window witnessed by another member, but only direct window participants may post there.

Documents/facts/entities/revisions/highlights/shards/tools use the caller's memory partition. KP document endpoints return
only KP documents; player endpoints return only that group's five journals. `scene_id=all` retrieves all current-scene
entries for workshop browsing. Player scene titles are neutral sequence labels; private KP scene metadata is omitted.
The old fact-visibility write endpoint and sharing proposals cannot expose KP memory to players.

Posting a message accepts optional `reference_ids`, with at most five original message UUIDs from the same channel.
The server validates access before storing and again in the posting transaction. Message responses contain only the IDs,
never an embedded source excerpt. Fetch each reference with `GET /channels/{id}/messages/{mid}`; 404 means unavailable
for the current reader. A reference link grants no additional access. A quote may point at a message from another readable
window; the original `chat_window_id` is returned for navigation. Chat-origin event payloads retain `reference_message_ids`.

PDFs with memory appendices are private exports bound to KP or the originating player group and version. They cannot be
published as share links or requested with `pl_public` scope. Group changes invalidate access to old player memory exports.
Legacy PDFs containing shared-memory appendices become KP-only, and their old publication links are revoked by migration.
