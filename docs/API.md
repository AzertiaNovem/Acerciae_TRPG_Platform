# API reference

Base URL `/api`. JSON in/out. Authentication: `Authorization: Bearer <token>` (tokens from `/auth/login`); the
session token is accepted only in that header. Files a browser loads by itself — media, avatars, TTS audio, exports,
PDFs, bundles — and the WebSocket also accept `?token=<file token>`: a short-lived (≤ 6 h) signed token from
`POST /auth/file-token`, bound to the session (logging out revokes it). When a public media bucket is configured, such
file-token requests for AI-generated art, voice clips and avatars are answered with a `302` to the object's public URL
(after the usual permission check); requests with an Authorization header always get the bytes.
Errors: `{ "error": "<code>", "message": "..." }` with 400/401/403/404/409/410/429/500. A 500 carries only a generic
message with a reference id; details go to the server log. Logins are throttled (5 failures per account and 30 per
client address in 15 minutes, then 429 `too_many_attempts`), as are registrations per client address.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{status, db, ws_connections}` |

AI is configured per server (see `/servers/{id}/settings` below); there is no platform-wide model, key or status route.
Each channel's AI status is `GET /channels/{id}/ai/status`.

## Auth

User objects now include `ui_language`, `avatar_data` (empty once the avatar is a media object), `has_avatar`, `avatar_version` and `languages`. See [personal settings](USER_SETTINGS.md) for validation, image limits and native client integration.

| Method | Path | Notes |
|---|---|---|
| PUT | `/auth/me` | Atomic partial update of the current user's `{username?,display_name?,ui_language?,avatar_data?,atmosphere_enabled?,dice_display?}` (`dice_display`: `separate`, the default, shows a roll's result as its own message from the dice; `inline` shows it under the command). A data URI replaces the avatar, `""` removes it, an absent `avatar_data` keeps it; duplicate username returns 409. |
| GET | `/users/{user_id}/avatar` | Raster image bytes, authenticated owner/shared-server members only. With `?token=` (browsers) an avatar in the public media bucket is answered with a `302` to its public URL. |
| POST | `/auth/register` | `{username, password, display_name}` → `{token, user}` |
| POST | `/auth/login` | `{username, password}` → `{token, user}`; a suspended account answers `403 account_suspended` with the reason in the message |
| POST | `/auth/logout` | ends the session and closes its WebSockets |
| POST | `/auth/file-token` | `{token, expires_at}` for `?token=` on file URLs and the WebSocket |
| GET | `/auth/me` | includes `is_admin` (a platform administrator, see [ADMIN.md](ADMIN.md)) and `avatar_hash` (SHA-256 of the avatar bytes, null without one; see [ASSETS.md](ASSETS.md), "On the device") |

## Platform administration

Administrators of the deployment (`PLATFORM_ADMINS`, or granted `is_admin`) inspect accounts, servers, storage,
database and AI use and suspend servers or accounts under `/api/admin/*`; others answer `403 admin_required`. Routes,
fields and the effects of a suspension are in [ADMIN.md](ADMIN.md).

Pictures carry their **content hash** wherever they are referenced: `content_hash` on media rows, `hash` on the character
space's avatar, portrait and poses, `avatar_asset_hash` (with `avatar_asset_version`) on `/channels/{id}/characters`,
`character_avatar_hash` and `author_avatar_hash` on messages, `background_asset_hash` on visual-novel scenes and
`asset_hash` on their placements, `hashes {variant: hash}` on `/channels/{id}/atmosphere`. Null until an object stored
before hashes existed has been served once. Versioned media, versioned avatars, atmosphere images and voice clips are
delivered with `Cache-Control: private, max-age=31536000, immutable`.

## Servers
| GET/POST | `/servers` | list mine `[{id, name, owner_id, created_at, my_role, suspended, suspended_reason}]` (a server the platform administrators suspended stays listed, marked, with the reason; everything inside it answers `403 server_suspended`) / create `{name}` |
| POST | `/servers/{id}/join` | `{invite_code?}` — follows the server's join policy: `open` servers take anyone, `invite` servers need a valid code (410 `invite_invalid` when expired, used up or revoked), `closed` servers refuse (403). A guest who joins becomes a member. |
| GET | `/server-directory?q=` | open servers the caller is not a member of: `[{id, name, member_count}]` |
| GET/POST | `/servers/{id}/invites` | maintainers list / create `{max_uses (0 = unlimited), expires_in_hours (0 = never, default 168)}` → `{id, code, max_uses, uses, expires_at, revoked_at, active}`; refused while the server is closed; at most 50 active |
| DELETE | `/servers/{id}/invites/{invite_id}` | maintainer revokes an invite |
| GET | `/invites/{code}` | `{server_id, name, member_count, valid, already_member}` |
| POST | `/invites/{code}/accept` | joins the invite's server |
| GET | `/servers/{id}/spectate` | channels whose Main Chat the caller may read without being invited (empty unless the server allows spectators; never for guests) |
| GET | `/channels/{id}/spectate?limit&before_seq` | `{channel, window, messages}` — the Main Chat's lines visible to the whole window only (no whispers, no GM-only lines, no character art); live lines arrive on the chat socket after `{type:"subscribe", channel_id, spectate:true}` as `spectate.message` |
| GET/POST | `/servers/{id}/members` | add `{user_id | username, role: admin|member}` (maintainer; only the owner grants `admin` = maintainer) |
| PUT | `/servers/{id}/members/{uid}` | `{role: admin|member}` (owner) |
| DELETE | `/servers/{id}/members/{uid}` | maintainer removes a member (owner removes maintainers; anyone may leave); also drops their channel and chat-window memberships |
| DELETE | `/servers/{id}` | (owner only — not other maintainers) deletes the server with every channel, member, invite and setting. Body `{"confirm": "Delete Server"}`, else 400 `confirmation_required`. Stored media, speech and PDFs are removed, sockets stop following its channels and every former member's clients get `server.deleted {server_id}`. Returns `{ok, channels, files}`. |
| GET | `/servers/{id}/all-channels` | (maintainers) every channel of the server, member or not: `{id, name, description, created_at, member_count, message_count}` |
| DELETE | `/channels/{id}` | (server maintainers; a channel GM is not enough) deletes the channel with its chat, characters, documents, media, scenarios and logs. Body `{"confirm": "Delete Channel"}`, else 400 `confirmation_required`. Server members get `channel.deleted {server_id, channel_id}`. Returns `{ok, files}`. |
| GET/PUT | `/servers/{id}/settings` | members get `{name, language, features{consistency,dice,inspiration,log_studio,atmosphere,illustrations}, policy{join_policy: open|invite|closed, channel_creation: members|maintainers, guest_invites, main_chat_spectators}, llm_mode, images_enabled, is_maintainer}`; PUT (maintainer) accepts the same `policy` object; maintainers also get `ai` (providers and model uses, see [AI_PROVIDERS.md](AI_PROVIDERS.md)) and, for older clients, the single-provider view derived from it: `llm{provider: mock|openai_compatible|anthropic|<kind>, api_base, model, reasoning_effort, embedding_model, api_key_set, api_key_hint}`, `image{provider: disabled|mock|gpt_image|<kind>, api_base, model, size, quality, api_key_set, api_key_hint}`, `tts{provider: disabled|mock|qwen|openai|<kind>, api_base, model, voice, api_key_set, api_key_hint}`, `ai_policy{token_budget, image_budget, period: month|total, max_concurrent, period_start, tokens_used, cached_tokens_used, images_used, running}` and `private_endpoints_allowed`. PUT (maintainer) still takes the old `llm`/`image`/`tts` objects (translated to providers and uses; a group sent back unchanged changes nothing) plus `api_key` / `clear_api_key` per group, and `ai_policy{token_budget, image_budget, period, max_concurrent, reset_usage}`. A live provider needs its own key; keys are sealed (AES-256-GCM) and never returned. Endpoints must be https on a public address unless the deployment sets `AI_ALLOW_PRIVATE_ENDPOINTS`. Budgets of 0 mean no limit; a spent budget answers AI requests with 429 `ai_budget_exhausted`, and a server already running `max_concurrent` AI tasks makes new ones wait (503 `ai_busy` after two minutes). |
| GET | `/ai/catalog` | provider kinds `{id, label, capabilities, default_api_base, protocol, fields, models, notes}` and uses `{id, capability, modes, default, label, tasks?}` (any signed-in user) |
| GET | `/servers/{id}/ai` | maintainers: `{providers: [{id, name, kind, api_base, api_key_set, api_key_hint, options, secrets{field:{set,hint}}, used_by}], uses: {use: {provider, model, options}}}` |
| POST, PUT, DELETE | `/servers/{id}/ai/providers[/{pid}]` | maintainers: add, change (the kind is fixed) or remove a provider; removing one returns its uses to their defaults. See [AI_PROVIDERS.md](AI_PROVIDERS.md) |
| PUT | `/servers/{id}/ai/uses` | maintainers: `{uses: {use: {provider: id|mock|disabled|inherit, model?, options?}}}`; a provider must be of a kind that can do the use |
| GET/POST | `/servers/{id}/dice-texts` | dice reply text groups `{id, name, base, texts, dice_name, avatar_version}`; create `{name, base: en|zh, texts:{key: template | [template…]}, dice_name?, avatar_data?}` (maintainer). A text given as a list (up to 20) is answered with one of its templates at random; empty templates are dropped. `dice_name` (up to 60 bytes, one line) and `avatar_data` (a PNG or JPEG data URI, at most 128 KiB and 512×512) make the dice persona: every roll in a channel using the group stores `dice.bot {name, group_id, avatar_version}` (without a group: `{name: "Dice" or "骰子", avatar_version: 0}`) |
| PUT/DELETE | `/servers/{id}/dice-texts/{gid}` | (maintainer); PUT takes the same fields, `avatar_data: ""` removes the avatar and an absent one keeps it; deleting resets channels that used it |
| GET | `/dice-avatars/{gid}?v=` | the dice persona's picture, for members of the group's server (session or file token); 404 when there is none |
| GET | `/dice/texts` | built-in texts `{keys, en, zh}` (template placeholders such as `{name}`, `{attr}`, `{roll}`, `{target}`, `{level}`) |
| GET | `/users/search?q=` | `[{id, username, display_name}]` for the member pickers |
| GET/POST | `/servers/{id}/channels` | create `{name, description?, knowledge_mode: public|isolated, rule_system?: coc7e|dnd2024|pbta, point_buy?}` — creator becomes GM; Main Chat + 6 documents created |

## Channels
| GET/PUT | `/channels/{id}` | details incl. `my_role`, `my_character_ids`, `player_group_id`, `player_group_version`, `player_group_name`; GM may update `name, description, knowledge_mode, ai_enabled` (the observer/consolidator behind the reminder and document bubbles; off = no model calls for the channel, even from `ai/observe-now`), `consistency_enabled`, `inspiration_enabled`, `atmosphere_enabled`, `illustrations_enabled` (each under the server's feature switch, all on by default; off answers 403 `feature_disabled` and hides the backdrop), `dice_text_group` (`''` = follow server language, `builtin:en`, `builtin:zh`, or a text group id), `studio_visible`, `studio_player_access`, `rule_system` (`coc7e` Call of Cthulhu 7e / BRP, or `dnd2024` D&D 2024 from SRD 5.2; anything else is 400; decides the dice commands, the character sheet and how AI prompts name the game and the GM — see [DND_2024.md](DND_2024.md)) and `point_buy` (role cards are checked by the rule system's point buy: COC7 occupation/interest points, or D&D 27-point buy / standard array); also returns `story_status: ongoing|ended`, `story_ended_at`, `story_reveal_all` A new `rule_system` is a transition (see [Switching the rule system](DND_2024.md#switching-the-rule-system)): the response adds `rule_transition {from, to, archived, pending, rebuild[{id, name}]}` (PCs to rebuild; NPCs are not named), and a system line in the main window asks the players to rebuild. |
| POST | `/channels/{id}/story/end` | GM: `{reveal_keeper_lines?}` — every member may then open the Log Studio and read the whole story (GM-only lines only when revealed); members get `channel.updated` on the chat socket |
| POST | `/channels/{id}/story/reopen` | GM: back to the GM's Studio switches and per-player visibility |
| GET/POST | `/channels/{id}/members` | add `{user_id | username, role: gm|player}` (GM; the user must already be on the server unless the GM is a server maintainer) |
| DELETE | `/channels/{id}/members/{uid}` | (GM) also removes them from every chat window of the channel |
| GET/POST | `/channels/{id}/characters` | create `{name, kind: pc|npc, speaking_style?, sheet?, description?}` (NPC: GM). A PC belongs to its creator, or to `user_id` when the GM names one. A PC owned by a GM account is a *GM-cast* PC, such as an AI co-player: the GM voices it, so it is never bound into the GM's window memberships, and Log Studio and the player-group memory treat its lines as an investigator's. GET: each row carries `vitals` for the status summary: `{rule_system, hp, hp_max, san, san_max, dex}` (Call of Cthulhu), `{rule_system, hp, hp_max, ac, dex}` (D&D 2024) or `{rule_system, resources[{id, name, value}], conditions[{id, name}]}` (PbtA: the pack's resources and the conditions that are on); a number the sheet lacks is null. |
| PUT | `/channels/{id}/characters/{cid}` | owner or GM |
| GET/PUT | `/channels/{id}/characters/{cid}/attributes` | `{attrs, editable}`; PUT `{set?: {name: number}, remove?: [name]}` (owner or GM; NPCs: GM). Names are canonicalised (`侦查`, `spot` → `Spot Hidden`) |
| POST | `/channels/{id}/dice/preview` | `{content, chat_window_id, character_id?}` → `{hint, command}` — the composer's gray hint; never rolls |

## Character space
| GET | `/channels/{id}/characters/{cid}/space` | `{character (with role_card, bio, asset_mode, appearance_prompt, editable), avatar, portrait, subtitles[{subtitle, id, version, …}], jobs[], era, narrative_time, attrs, generation_available, card_archives[{id, rule_system, numbers, attrs, reason: rule_change|restore|legacy, archived_at, archived_by_name}]}`; `character.card_pending` is true while the numbers still need rebuilding for the channel's rule system (also on the character list). Former cards are read-only. Players read any PC's space; NPC spaces are 404 for players. |
| GET/PUT | `/channels/{id}/pbta` | Channel rule pack and revision. GM-only replacement, import preview, playbooks, move commands and character fields are described in [PbtA](PBTA.md). |
| GET | `/api/dnd/rules` | D&D 2024 reference from SRD 5.2 (any signed-in user): `{source, classes[{name, names, hit_die, saves, skill_count, skills, caster}], species[{name, names, speed, …}], backgrounds[{name, names, abilities, skills}], point_buy{budget, min, max, costs}, standard_array, slots{full, half, pact}, abilities, skills}`. In a D&D channel `role_card.dnd` holds the build `{class, subclass, species, background, level, method: point_buy|standard_array|manual, base, increases, improvements, saves, skills{name: 0|1|2}, ac, speed, initiative, hp_max, hit_dice, spell_ability, slots, features, spells, notes}`; saving it mirrors scores, proficiencies, AC, HP Max, Speed and slot maxima into the sheet's attributes (live HP, slots left and death saves are only filled in when missing). With `point_buy` on, a card that breaks the rules answers `400 points_rule`, and only the GM can change `improvements`. |
| GET/POST | `/channels/{id}/windows/{w}/initiative` | D&D Initiative order of the window: `{entries[{id, name, total, tiebreak, character_id, created_by}], turn, round}`, highest first (ties by the DEX tiebreak, then name). POST `{action: next|remove|clear, entry_id?}`: `next` and `clear` are the GM's; a player may remove an entry they created. Changes emit `initiative.changed {chat_window_id}` on `/ws/chat`. |
| GET | `/api/coc7/rules` | COC7 point-buy reference (any member): `{skills[{name, base, names{lang: name}}], families[{name, base, names}], characteristics[{name, names}], careers[{id, name, names, credit, points, formula, fixed, choices, free, description, descriptions}], hobby_formula}`. See [COC7_POINT_BUY.md](COC7_POINT_BUY.md). With the channel's `point_buy` on (in a `coc7e` channel), `PUT …/card` recomputes skill totals from `role_card.career` and `role_card.skill_points` and answers `400 points_rule` when a limit is broken; the space carries `points {enabled, language, career_budget, career_spent, hobby_budget, hobby_spent, characteristics_total, luck, allowed, violations, warnings}`. |
| PUT | `/channels/{id}/characters/{cid}/card` | `{name?, speaking_style?, bio?, role_card?, card_rebuilt?}` (GM or the character's actor). Only the channel's own rule system's numbers are kept (the other system's are dropped); the rebuild flag goes once the numbers are rebuilt, or when the GM sends `card_rebuilt: true`. A save that lands after the GM switched the rules is refused (409): reload the card. The COC7 card: `basic {player, occupation, age, sex, residence, birthplace}`, `characteristics {STR…LUK}`, `derived {hp, hp_max, mp, mp_max, san, san_max, mov, build, db}`, `skills {name: value}`, `background {personal_description, ideology, significant_people, meaningful_locations, treasured_possessions, traits, injuries, phobias, arcane, encounters}`, `items [{name, note, qty}]`, `wealth {cash, assets, spending_level}`. Characteristics, HP/MP/SAN/MOV and skills are mirrored into `sheet.attrs`, which the dice read. |
| POST | `/channels/{id}/characters/{cid}/card-archives/{archive}/restore` | GM or the character's actor. Brings a former card of the channel's current rule system back: its numbers and dice values return to the card, the numbers on the card are archived in turn (reason `restore`), the entry is used up and the rebuild flag goes. 409 for a card of another system, 404 for an unknown one. Returns the space. |
| GET | `/users/{id}/avatar`, `/channels/{id}/media/{asset}`, `/channels/{id}/studio/tts/audio/{clip}` with `?direct=1` | For a browser (`?token=`): when the object is in the public bucket, `200 {url, keep}` (`application/vnd.acerciae.direct+json`) instead of the `302` to it, so the client fetches the bucket from its own origin (a followed redirect would carry `Origin: null`). `keep` says whether the client may keep the object on the device. Objects outside the public bucket, and requests with an `Authorization` header, get the bytes as usual. |
| PUT | `/channels/{id}/characters/{cid}/appearance` | `{asset_mode: uploaded|generated, appearance_prompt}` |
| POST | `/channels/{id}/characters/{cid}/assets` | multipart `slot` (`avatar`, `portrait`, `subtitle`) + `subtitle` (IDLE, SAY, FIGHT, …) + `file`: an approved image asset of the character, attached to the slot |
| POST | `/channels/{id}/characters/{cid}/assets/generate` | generated mode only: `{slots: [portrait, avatar], subtitles: [...], allow_cloud}` queues one image job per target; the prompt is the appearance prompt plus the channel's `era`, the current scenario's moment and the slot's framing; results are approved and attached when the job completes |
| DELETE | `/channels/{id}/characters/{cid}/assets/{aid}` | detaches and deletes the image (from the base look or an outfit) |
| POST | `/channels/{id}/characters/{cid}/outfits` | generated mode only (409 otherwise), GM or the character's actor: `{name (≤120 bytes), attire (≤2000 bytes)}`; names are unique per character (409), at most 8 outfits (409). Returns the space, which lists `outfits[{id, name, attire, avatar, portrait, subtitles[]}]`, `max_outfits` and `character.outfit_id` (worn now) |
| PUT/DELETE | `/channels/{id}/characters/{cid}/outfits/{oid}` | PUT `{name?, attire?}`; DELETE removes the outfit and its images (a character wearing it goes back to the base look; lines written in it show the base look) |
| POST | `/channels/{id}/characters/{cid}/outfits/{oid}/generate` | like `assets/generate` for one outfit: `{slots: [portrait, avatar], subtitles: [...], allow_cloud}`. The portrait is drawn from the main portrait (required), the avatar and poses from the outfit's portrait (queued in the same request, or the one it has; poses without one are 400). Jobs carry `attach.outfit_id` |
| PUT | `/channels/{id}/characters/{cid}/outfit` | `{outfit_id}` (null = the base look): what the character wears now. The character list then reports the outfit's avatar as `avatar_asset_id` (`base_avatar_asset_id`, `outfit_name`), and each new line of the character records it (`outfit_id`, `outfit_name` and its avatar on the message) |

Chat messages carry `character_avatar_asset_id` and `character_avatar_version`; `PUT /channels/{id}` accepts `era`.

Character rows additionally carry `passive_since: timestamp | null`. GM-only
`PUT /api/channels/{id}/characters/{cid}/presence` accepts `{passive: boolean}` for a PC in that channel,
returns the updated character and broadcasts `character.updated`. Repeating `true` preserves the original timestamp;
`false` clears it. A non-GM receives 403; a non-PC or malformed boolean receives 400.

## Chat windows & messages
| GET/POST | `/channels/{id}/windows` | create `{name, kind: group|private, members:[{user_id, character_id?}]}` (GM); a new window joins the campaign's current scenario |
| PUT | `/channels/{id}/windows/{w}` | GM rename `{name}` and/or archive/restore `{archived: boolean}`. Archived windows remain readable; posting and new membership return 409 until restored. Main Chat cannot be archived. |
| POST | `/channels/{id}/windows/{w}/fork` | GM `{name, kind?: group|private, members:[{user_id, character_id?}], through_seq?, request_id?}`. New window with immutable `fork_parent_id` and `fork_seq`; the GM is included automatically. Defaults to the parent's current history cutoff; nested ancestry respects every cutoff. A request ID is idempotent per channel and creator; reusing it with different settings returns 409. |
| GET/POST | `/channels/{id}/windows/{w}/members` | add `{user_id, character_id?}` (GM); a new member gains only messages after joining. Rows include `visibility_paused`. Re-adding an existing member does not resume visibility. |
| PUT | `/channels/{id}/windows/{w}/members/{uid}/visibility` | GM `{paused: boolean}`; idempotent pause/resume. Previously readable history remains available; messages during a pause stay hidden after resuming. A paused user cannot post (403). Main Chat and GM accounts cannot be paused. Same-group active members still share their readable messages. |
| DELETE | `/channels/{id}/windows/{w}/members/{uid}` | (GM) |
| GET | `/channels/{id}/windows/{w}/messages?limit&before_seq&after_seq&include_history` | viewer-filtered, including bounded ancestor history by default; `include_history=false` returns only this window’s stored messages. Original message IDs, sequence numbers and window IDs are preserved. No messages are copied on fork. Without `after_seq`: the newest `limit` lines (default 80, at most 200) before `before_seq` when given. With `after_seq` (0 or more): the first `limit` lines after it — how a client that keeps the history catches up from the last line it has (`0` reads from the first line). Oldest first either way; recalled lines come as their tombstones. |
| POST | `/channels/{id}/windows/{w}/read` | `{seq}`: the caller has read the window up to `seq` (never moves backwards, never past the newest message). `GET /windows` returns each window's `unread`: messages the caller may read, by others, after that point (counted up to 100). |
| POST | `/channels/{id}/windows/{w}/messages` | `{content, kind: ic|ooc|narration, character_id?, visibility: window|gm_only|whisper, whisper_to?[], reference_ids?: UUID[0..5]}`. When dice are enabled, Sealdice commands are evaluated: `.r [N#]<expr> [reason]`, `.rh` (hidden), `.ra`/`.rc [N#] [hard|extreme|困难|极难] [b|p[n]] <skill> [value][±mod] [reason]`, `.rah`, `.sc <ok>/<fail> [SAN]`, `.st <name><value>…` / `.st <name>±<dice>` / `.st show|del|clr`, `.en <skill>`. In a `dnd2024` channel the D20 commands replace the percentile ones: `.rc`/`.ra [adv|dis] <ability|skill|ABILITY save|attack> [±mod] [dc|ac N] [#reason]`, `.ri`/`.rih [adv|dis] [±mod] [name]` (Initiative, stored per window), `.init [next|del <name>|clr]`, `.ds` (Death Saving Throw), `.ss [<level> [+N|-N]] | .ss reset` (spell slots: list, spend, regain, Long Rest); `.r` and `.st` work in both, and the other system's commands answer 400 `dice_error`. The message keeps the command as `content`, gets `kind: roll` (the only way to get it: `roll` sent without a command is refused) and `dice: {type, command, text, …}`; hidden rolls are whispered to the roller's character and the window gets a `hidden_notice`. Errors (no character, unknown attribute) return 400 `dice_error` |
| POST | `/channels/{id}/windows/{w}/scene` | deprecated alias of `/scenarios/enter` (`{scene_id}`); scenarios are campaign-wide, the window is ignored |
| POST | `/channels/{id}/windows/{w}/illustrations` | Illustrate a moment: `{prompt: 1–1500 chars (who does what, where, light), character_ids?: UUID[0..6], orientation?: landscape\|portrait\|square, allow_cloud, request_id?}`. Any member who may post in the window; players may pick player characters only (NPCs 403). Each character is drawn in the outfit they wear unless `outfits: {character_id: outfit_id | ""}` picks another ("" = the base look; an outfit not theirs is 400). Optional: 403 `feature_disabled` for everyone, the GM included, while the server's `features.illustrations` or the channel's `illustrations_enabled` is off (both on by default; the list, cancelling and pictures already posted stay available). Each character's main portrait (else avatar) goes to the image provider as an identity reference, with the platform's direction (an unexpected, cinematic viewpoint), the era and the current story time. 400 when the server has no image provider, 409 while the caller's previous illustration is still being drawn, 429 after 20 in an hour; the server's image budget applies. Returns the job `{id, status, kind: "illustration", reference_count}`. When the picture is ready it is posted in the window as the requester's `ooc` line (`content` `🖼️ ` + the description, `media_asset_id` set) |
| POST | `/channels/{id}/windows/{w}/images` | Post a picture of one's own (a handout, a map, a photo) as a chat line. Multipart: `file` (PNG, JPEG, WebP or GIF, told by its content, at most 10 MB) and, as for a text line, `content` (the caption, optional, at most 2000 characters), `kind` (`ic` default, `ooc`, `narration`), `character_id`, and for the GM `visibility` (`gm_only`, `whisper`) with `whisper_to` (comma-separated character ids). Anyone who may post in the window; no image AI is involved, so the illustration switches do not apply. Returns the posted message: `media_asset_id` set, `content` the "🖼️" mark and then the caption (the mark alone without one; a caption is never read as a dice command). 400 not an image or an empty file, 413 `too_large`, 429 beyond 60 an hour per person and channel, 403/409 as for a text line (not their character, a player's whisper, an archived window); a refused picture leaves nothing stored. The picture is private chat art (`asset_type: illustration`, `source_type: upload`): served through its line only, listed in the GM's media library |
| GET | `/channels/{id}/illustrations` | the caller's last 10 illustrations here: `{id, status, error, window_id, prompt, character_ids, orientation, message_id, reference_count, created_at, finished_at}`; `error` on a completed one means it was drawn but could not be posted (the requester left the window) |
| POST | `/channels/{id}/illustrations/{job}/cancel` | the requester or the GM, while pending or running (409 after) |
| GET | `/channels/{id}/messages/{mid}/image?token=` | a line's picture, only for someone who may read the line (404 otherwise or once recalled); `?direct=1` answers with the bucket URL as for media; `?download=1` sends the bytes themselves (never a redirect) with `Content-Disposition: attachment` and a readable name, `illustration-<date>-<description>.png` for a drawn picture and `picture-<date>-<caption>.<ext>` for an uploaded one (`filename*` in UTF-8, any script kept) |
| GET | `/channels/{id}/messages?q=` | search |
| GET | `/channels/{id}/messages/{mid}` | 404 once the message is recalled |
| POST | `/channels/{id}/messages/{mid}/recall` | the author takes back their own `ic`, `ooc` or `narration` line up to 2 minutes after sending it; anyone else gets 403, a line the caller cannot read 404, a dice roll, system line or PbtA move record 409 `not_recallable`, a later attempt 409 `recall_expired`. Returns `{message, content}`: the tombstone and the original text (for the author to edit and send again); repeating it returns the tombstone with `content: ""`. The row stays as a tombstone (same `id`, window and `seq`; `content` empty, `dice` null, `reference_ids` empty, `recalled_at` set), so clients replace their copy by id; message lists return it in place, while search, unread counts and references skip it. Its events and campaign-log copies (and with them every snapshot's line) are deleted, so the AI, scene logs and exports never see it again; highlights and reminders citing it are dismissed and Keeper journal entries resting only on recalled lines are retracted (a `system` revision). Copies already published, rendered to PDF or downloaded are not reached. A picture the author uploaded is deleted with its line (a drawn illustration stays in the GM's media library). Every message row carries `recall_seconds_left`: seconds until it can no longer be recalled, `null` when it cannot be. |

Window reads, search, references, player knowledge, Log Studio and WebSocket message delivery use the same
membership intervals. Resume opens a new interval; it never reveals the gap. Fork history additionally checks
original source permissions. Archiving only hides a window from the default active list and makes it read-only.
`GET /windows` returns `fork_parent_id`, `fork_seq`, `archived_at` and each member’s `visibility_paused`.
On `window.changed`, clients should refresh windows and the current history instead of treating pause as removal.

Messages additionally carry `stand_in: boolean` (default `false`). The message POST body may set `stand_in: true`
only for the GM speaking as another user's PC, with an explicit `character_id`, kind `ic` or `ooc`, and `window`
visibility. Dice commands are not allowed. Invalid stand-in requests receive 400. The author remains the GM account,
but the associated event has `actor_role: player`; REST and `message.posted` retain the flag. Log Studio copies it to
`metadata.stand_in` and native JSON export messages expose `stand_in: true`.

The owner of a stand-in line's character can recall it without a time limit, in addition to the author's existing
120-second permission. Readability, archived-window and move-record restrictions still apply. Clients determine this
owner permission from `stand_in` and the character's `user_id`, independently of `recall_seconds_left`. Clients talking
to older servers should treat an absent flag as false and an absent `passive_since` as null.

## Scenes & events
| GET/POST | `/channels/{id}/scenes` | Scenarios (stages of the story; a campaign-wide state, one current scenario for every window; POST prepares one without entering it). GM rows carry `summary`, `key_points`, `summary_status: none|pending|ready|gm_edited`, `auto_detected`, `stage_reason`, `boundary_event_id`; players get neutral `Scene N` labels. POST `{title, location?, narrative_time?, summary?}` (GM) |
| GET/PUT | `/channels/{id}/scenes/{sid}` | PUT (GM): a changed `summary` is marked `gm_edited` and is never overwritten by the model |
| POST | `/channels/{id}/scenes/{sid}/close` | |
| POST | `/channels/{id}/scenes/{sid}/summarize` | (GM) write or rewrite the AI summary of a scenario from its chat log |
| POST | `/channels/{id}/scenarios/advance` | (GM) `{title?, location?, narrative_time?}` opens the next scenario for the whole campaign: every window moves there, the current scenario closes and is summarized, and it can only be consulted from then on. On a COC7 channel the closed scenario's investigator development runs first (also on `scenarios/enter` and `scenes/{id}/close`): every skill a player character succeeded with (`.ra`/`.rc` at Regular or better) gets a growth check as `.en` does, the sheet and role card take the improvements, and a `kind: system` message in the Main Chat lists the results. Returns `{scene, previous, windows}`. |
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
| PUT | `/channels/{id}/documents/{did}/entries/{eid}` | GM correction `{summary?, status?, content_md?, data?, reason?, expected_version?}` (GM partition only; cannot widen visibility) |
| GET | `/channels/{id}/entries/{eid}` · `/related` | entry · related entries |
| GET | `/channels/{id}/proposals?status=needs_gm_review` | (GM) |
| POST | `/channels/{id}/proposals/{pid}/decide` | `{accept: bool}` (GM) — GM memory proposals only; legacy sharing is retired |

The GM and each player group's observer perform editorial selection in the same extraction pass: skip irrelevant/repeated chat, update an existing `fact_id` for a meaningful development of the same subject, or add a distinct useful story fact. A batch with no meaningful change returns empty proposals successfully. Technical explanations, placeholder labels and unexplained raw dice results should not become entries describing their own irrelevance. Tagged `ic`/`narration` or GM authorship does not automatically establish narrative value. Important short clues, consequential attempts, adjudicated checks and story corrections remain eligible. The prompt explicitly supplies top-level `update_entry` fields and directs the model to consult existing scene entries before adding.

Player observer context includes the witnessed message payload (message type and structured dice information) and a snapshot of the current scene's own entries. The backend rejects AI writes based solely on unambiguous placeholders and new entries based solely on raw rolls without a purpose (an existing action entry can supply context for an update), and skips materially identical AI updates without a fact/document version bump. Original messages and proposal audit records remain intact. Other semantic judgments are made by the configured model; mock mode only uses conservative rules and exact-entry matching, not full semantic editing. Existing confirmed or GM-authored entries retain review protections; this change does not bulk-delete previously recorded clutter.

## World record
The chronicle above says what happened; the world record says what is true **now** about each entity (alive, dead,
missing, destroyed; where it is; one short line of state). It lives on `entities` in each memory partition: the GM's
(`player_group_id IS NULL`) and each player group's own.

| Method | Path | Notes |
|---|---|---|
| GET | `/channels/{id}/world` | any member; the caller's partition (GM: the GM's; player: their group's). `{version, entities: [{id, kind, name, aliases, description, status: active|inactive|missing|dead|destroyed|unknown, state, location: {id, name}\|null, state_version, state_updated_at, state_by: ai|gm\|null, fact_count}], recent_changes: [{entity_id, name, version, status, state, location_name, actor: ai|gm, created_at}]}`. Entities sorted by kind, name; the last 30 changes, newest first. `version` grows whenever any entity's state changes or an entity is added (compare, do not interpret). A player sees entities their group's facts mention or whose state cites chat the group can still read. |
| POST | `/channels/{id}/world/declare?observe=true` | (GM) `{text: 1..4000 chars, secret?: bool}` → `{event_id, seq, jobs?}`. Records a GM declaration about the world (often off-screen) as an event `gm.declared` (`visibility: gm_only`, `actor_role: gm`, `payload {content, secret}`, the channel's current scene), never a chat message. `observe=true` runs the observer synchronously like `ai/observe-now` and returns its `jobs`. |

**Observer op `entity_state`** (in the observer reply's top-level `"world"` array; also accepted inside a document's `ops`, where it is moved out):
`{"op":"entity_state","entity":"name or id","kind":"npc|location|item|organisation|concept","status":"…","state":"…","location":"entity name or id","source_event_ids":["…"]}`.
`kind` is required only when the entity does not exist yet (it is then created); at least one of `status`, `state`, `location` is required;
an omitted field is unchanged, except that a new status without a new `state` clears the old state line. An unknown `location` is created as a
`location` entity in the same partition. Validation (`DocumentService::commitWorld`) is the documents' provenance rule: an AI change must cite
source events of the batch it was given; a player group's must be chat that group can read; entities and locations resolve only inside the
writer's partition (database triggers also refuse cross-partition locations and history). A change citing a `gm.declared` event is the
GM's (`state_by: gm`); so is a GM-accepted review. An AI change to a state the GM set becomes a `needs_gm_review` proposal
(`document_id: null`, `ops[0].op: entity_state` with `entity_name` and `previous`), decided with `POST /proposals/{pid}/decide`. Each applied
change bumps `state_version`, appends an `entity_state_history` row and emits `world.updated`. Repeating the current state is skipped.

**`gm.declared`** is authoritative for the GM's observer: facts it establishes are `confirmed` (a GM-authored event backs `confirmed`), or
`gm_secret` when `payload.secret` is true (the backend forces `gm_secret` on a fact citing a secret declaration). Players never read it: the
event filter, `player_group_chat_events` and the player-group observer batch only contain witnessed `message.posted` events that are not
`gm_only`. Mock mode recognises a few English patterns per sentence (`<Name> is dead|died|was killed`, `the <Place> burns|is destroyed`,
`<Name> is missing|vanished`, `<Name> flees|moves|goes to <Place>`), in declarations and chat alike, and records a declaration itself as a
timeline entry.

## Reminder bubbles
| GET | `/channels/{id}/reminders` | active reminders for the caller (players: their group's; GM: the GM's), minus the ones they dismissed. `{id, version, status, updated_at, status_reason, review_citations[], kind: forgotten|needed|plan|note|pinned, title, why, citations[{event_id, message_id, chat_window_id, scene_id, seq, quotes[]}], scene_id, priority, llm_mode, created_at, expires_at}`. Each quote is a verbatim substring of a line the group can read; a reminder is never stored without a verified quote. New entries also emit `reminder.created` for older clients. All changes emit `reminders.changed {channel_id}` on `/ws/context` to the group (or GMs); refetch the list to apply updates and removals while respecting per-user dismissal. |
| POST | `/channels/{id}/reminders/{rid}/dismiss` | per-user dismissal |
| POST | `/channels/{id}/messages/{mid}/pin` | pins a line the caller can read (404 otherwise; a recalled or system line 409): a reminder of kind `pinned` in the caller's group's bubbles (the GM's for the GM), priority 4 so it lists first, `title` the line's beginning, one verbatim quote, `why` "Pinned by <name>", `pinned_by`, `pinned_by_name`, `pinned_message_id`, `llm_mode: user`, never expiring and outside the AI's maintenance (it never resolves, defers or counts it against the active limit; the planner reads the pins and does not repeat them). Pinning a line pinned already returns that pin. Returns the reminder. |
| DELETE | `/channels/{id}/reminders/{rid}` | unpins: the pinner or the GM (403 for another member of the group; 404 for another group's pin or a pin already taken down). Emits `reminders.changed`. |
| GET | `/channels/{id}/reminders/{rid}/context?limit` | the chat log around the first quoted line, viewer-filtered on every call (`events[]` with `cited` and `quotes` on the quoted lines, `anchor_event_id`); 404 for another group |

The group observer raises reminders after each batch of its chat: it reads the group's hidden knowledge index (relationships, clues, open threads, and the story index of per-scenario outlines in `player_scenario_outlines`), the current scenario, the end of the previous one and the newest lines, may fetch more with `get_chat_log`, reads the lines the members pinned and the reminders it keeps (all laid out as prose with each line's event id), and **thinks ahead before it reminds**: it first writes a private `outlook` (where the group stands, the most likely next move a thoughtful player would make, and what that move depends on, marking what the newest lines show the players have lost track of), then proposes at most three "forgotten" or "needed" reminders, each for a need of that move the group has lost track of, with the ground in `why` and verbatim quotes. The outlook is never shown; it is kept per group in `group_outlooks` and read by Inspiration as a hint about the moment ("THE TABLE'S MOMENT"), together with the group's pins. The GM's planner does the same from the GM's side: the next beat to run and what it needs from the script and the chat. The knowledge index is prepended to player-facing model requests (observer, reminders, consistency, inspiration) and is never shown to players.

The **same reminder planning response** also maintains existing reminders: `{changes: [{reminder_id, expected_version, action, reason, quotes, title?, why?}], reminders: [...]}`. Actions are `update` (refresh/reword an active entry), `resolve` (completed or no longer applicable), `defer` (temporarily irrelevant), and `reactivate` (a deferred entry becomes relevant). Omitted entries remain unchanged. Completion must be established in new chat; intention, speculation and silence are not completion. Topic changes defer rather than resolve. The response is limited to 12 changes and 3 new entries. There is no separate maintenance LLM pass; retrieval/tool calls and schema repair can still take multiple provider calls.

The planner receives up to 8 active, 20 deferred and 12 recently resolved reminders from its own partition. Every change must target an ID/version in that input and quote verified, readable messages from the current batch. The backend rejects stale versions, repeated batches, foreign IDs and invalid evidence, then commits changes and creations together. Original `citations` and `source_event_ids` are preserved; `review_citations`, `status_reason`, `reviewed_through_seq`, `version` and `updated_at` track maintenance separately. `reminder_revisions` records before/after state and evidence. This operation never edits chat, script knowledge or narrative documents.

Only active entries are listed. Active entries expire after 3 days unless reviewed/refreshed; deferred entries are available for review for 30 days. Resolved entries are terminal. The model sees resolved history for 30 days, and database checks additionally suppress exact-title/dedupe-key recreation outside that context window. At most 8 entries stay active; overflow is deferred, not marked completed. Per-user dismissal survives reactivation. The web client refetches after invalidation and reconnect, reconciles every 30 seconds, and prunes expired entries every 15 seconds. Other clients, including mobile, should handle `reminders.changed` by replacing their list from GET, rather than only appending creation events.

Without a configured LLM, maintenance is explicitly rule-based: a chat line exactly equal to `Resolved: <full reminder title>`, `Set aside: <full reminder title>` or `Return to: <full reminder title>` exercises the transitions (`已解决：`, `暂时搁置：`, `重新关注：` also work). Mock mode does not infer semantic completion or topic changes. Live models receive instructions to make these judgments from the conversation; quality still depends on the configured model. Maintenance runs when the observer processes new chat, not while the channel is idle.

## GM script knowledge and the pinned board (GM only)
| GET | `/channels/{id}/script-knowledge?kind` | the GM's knowledge built from the module: `{id, module_id, kind: flow|relationship|clue|foreshadowing|background, title, body, data, citations[{page, excerpt}], node_ids[], position, status: pending|active|done|skipped, status_event_ids[], origin: script|play|gm, gm_edited, llm_mode}`. `flow` entries are the script's stages in order (`data.location, prerequisites[], keeper_actions[], leads_to[], twists[]`). |
| PUT | `/channels/{id}/script-knowledge/{kid}` | `{title?, body?, status?}` GM edit: marks `gm_edited`; the entry is never changed automatically again |
| POST | `/channels/{id}/script-knowledge/rebuild` | `{module_id?}` rebuilds the script-origin entries of a module (GM-edited and play-origin entries survive) |
| GET | `/channels/{id}/script-knowledge/changes?limit` | every automatic change proposed from play with the reviewer's verdict: `{op: add|update|status, proposal, evidence[{event_id, text}], verdict: approved|rejected, reviewer_reason, applied, title, kind, status}` |
| GET | `/channels/{id}/kp/board` | the two pinned cards: `next {has_script, current, next, pending_clues[], pending_foreshadowing[], stages_done, stages_total, summary}` and `notes {open_threads[], timeline[], recent_changes[], stages_done[]}`. Pushed as `kp.board` on `/ws/context` to GMs. |

The script knowledge is built when a module finishes structuring (and on rebuild): the flow of the script, NPC and
investigator relationships, clues, foreshadowing and background, each citing module pages. It is prepended to every
GM-facing model request before anything else (`GM KNOWLEDGE INDEX`), and the GM's tools include
`get_script_knowledge {kind, query}`. After each processed batch of the GM's observer a first model proposes
changes from the newest lines (a stage reached, a clue revealed, a twist paid off, a fact the narration established)
with verbatim chat quotes as evidence; a second model reviews each proposal against the quoted lines and the module
citations, and only approved changes are applied. Reaching a later stage closes the running one. Players' knowledge
never passes a reviewer. GM reminders may carry `script_refs[{knowledge_id, kind, title, page, excerpt}]` next to
their chat citations; nothing of this is reachable by a player group (403).

## Highlights
| GET | `/channels/{id}/highlights?document_id` | active, scope-filtered |
| POST | `/channels/{id}/highlights/{hid}/dismiss` | |

## Knowledge / shards
| GET | `/channels/{id}/facts?kind&q&scene_id` · `/facts/{fid}` | viewer-filtered facts |
| GET/PUT | `/channels/{id}/facts/{fid}/visibility` | GET returns `scope: gm|player_group` and group identity; PUT returns 409 (direct GM sharing retired) |
| GET | `/channels/{id}/entities?q` · `/entities/{eid}` | entity graph |
| GET | `/channels/{id}/knowledge/{cid}` | facts a character knows (own character or GM) |
| POST | `/channels/{id}/tools/{tool}` | execute a Tool API call under the caller's identity (`search_scene_history`, `get_entity`, `list_scenarios`, `get_chat_log {scene_id?, chat_window_id?, from?, to?, after_seq?, around_event_id?, limit?}` for verbatim lines by scenario, time or around one event, …) |
| GET | `/channels/{id}/shards?id=clue/<uuid>` | shard fetch |

## AI auxiliary features (user-triggered)
Both return 403 `feature_disabled` when a server maintainer turned the feature off. Requests use the server's LLM profile (model, reasoning effort, output language).

| POST | `/channels/{id}/consistency` | `{chat_window_id, character_id?, draft}` → `{score|null, score_label, insufficient_evidence, rationale, conflicts[], evidence[], highlights[], llm_mode}` |
| GET | `/channels/{id}/consistency/history` | my checks |
| POST | `/channels/{id}/inspiration` | `{chat_window_id, character_id?, hint?, variant?, avoid?: [texts already shown]}` → `{options[{text, kind: ic\|ooc, roll, angle}], draft, used_fact_ids, notes?, editable: true, auto_sent: false}`. Three ways the character might play the moment, in their own voice, built like the GM agent's co-player: the prompt lays out the persona, speaking style, role card and condition, who is with them, the story's date and place, what their group knows (facts, cited in `used_fact_ids`), the lines they witnessed and the newest one, under the same tablemate rules (short lines, never narrate outcomes, support the others, roll when an action calls for it: `roll` carries the dot command the player may send). `draft` is the first option's text (older clients); `hint` steers every option; `avoid` lists texts another take must not repeat. Never sends anything. |

## AI observer admin
| GET | `/channels/{id}/ai/status` | scheduler status, LLM status, cursors |
| GET | `/channels/{id}/ai/jobs` | (GM) |
| POST | `/channels/{id}/ai/observe-now` · `/consolidate-now` · `/cleanup-highlights` | (GM) run synchronously |

## Modules / GM workspace (GM only)
| GET | `/channels/{id}/modules` · `/modules/{mid}` · `/modules/{mid}/pages/{n}` | |
| POST | `/channels/{id}/modules` | multipart `file` (PDF) + `title`; processed asynchronously (`status: uploaded→extracting→structuring→ready`) |
| POST | `/channels/{id}/modules/text` | `{title, pages:[...] | text}` synchronous import |
| PUT | `/channels/{id}/modules/nodes/{nid}` | `{name?, description?, node_type?, progress?}`. Node types: stage, scene, location, npc, creature, clue, item, secret, condition, twist, ending; in a D&D channel the import keeps a creature's stat block as `data.stat_block {size_type, ac, hp, hp_formula, speed, cr, abilities{STR…CHA}, saves, skills, senses, languages, traits[], actions[], bonus_actions[], reactions[], legendary_actions[]}` (each entry `{name, text}`) |
| GET | `/channels/{id}/modules/hints?status=potential` | potential associations |
| POST | `/channels/{id}/modules/hints/{hid}/decide` | `{decision: accepted|dismissed}` |
| GET | `/channels/{id}/gm/workspace` | modules, scenes vs module, pending hints/proposals, node progress, GM-only facts, recent jobs |

## WebSocket
Connect with `?token=` (a short-lived file token from `POST /auth/file-token`, as the web and mobile apps do; a session token is also accepted) to `/ws/chat` or `/ws/context`, then send `{"type":"subscribe","channel_id":"..."}`.

Chat stream: `message.posted {message}` (only to users allowed to read it), `message.recalled {message}` (the tombstone, to the same audience; spectators get `spectate.recalled`), `window.changed {window}`, `scene.changed {scene}`,
`character.updated {character}` (attribute changes; NPCs to GMs only), `server.settings {server_id, settings}` (public view), `initiative.changed {chat_window_id}` (refetch the window's Initiative order),
`typing.changed {chat_window_id, character_id, active}` and, right after `subscribed`, `typing.snapshot {typing: [{chat_window_id, character_id}]}` (see below).

Typing flags are the character's, not the user's. A client raises one with `{"type":"typing","channel_id","chat_window_id","character_id","active":true}` (its own character, or any for the GM, in a window it belongs to; anything else answers `error`), sends the same pack again every few seconds while the writer keeps typing, and lowers it with `"active":false`. The server lets a flag fall 10 s after the last pack, or when the socket that raised it closes, so a closed tab never leaves a character typing. Each change goes to the users who may read the window (the GMs; the window's members whose view is not paused; everyone in the channel for the Main Chat or a public-knowledge channel); an NPC's flag reaches the GMs only. Heartbeats get no reply.

Context stream: `document.updated {document_id, doc_type, version, change_count, entry_ids, gm_only, actor, summary}`,
`highlight.created {highlight}` (scope-filtered), `highlight.expired {highlight_ids}`, `proposal.pending` (GM),
`module.updated` (GM), `ai.job {job}` (GM), `scene.changed`, `reminder.created {reminder}` and `reminders.changed {channel_id}` (its group, or GMs),
`kp.board {board}` (GM), `script.changed {payload}` (GM), `world.updated {channel_id, version}` (the partition's audience:
GMs for the GM's world record, group members for their group's; refetch `GET /world`).

Both streams answer `{"type":"ping"}` with `pong`. The upgrade must be the first request on its TCP connection (browsers
always do this).

## The campaign log (Log Studio)
| GET | `/channels/{id}/studio/log` | the channel's one campaign log, synced from the chat on every call: `{project (event_count, speakers, snapshots, scenes), synced_added, windows[{id, name, kind, line_count, last_at}], scenarios[], last_event_at}`. Viewer-filtered. Nothing is ever imported. |
| GET | `/channels/{id}/studio/log/export?format=json|txt|html|sealdice|zip&chat_window_id=` | viewer-filtered download of the whole campaign (or one window). `json` is the native **acerciae-log 2.0** format, readable without the database (no internal ids): `{format: "acerciae-log", schemaVersion: "2.0", generator, exported_at, campaign {name, era, description, viewer}, players [{username, display_name, role: gm|player, avatar_url}], characters [{name, kind: pc|npc, player (username), bio, speaking_style, appearance_prompt, role_card, avatar_url, portrait_url, poses {SUBTITLE: url}}], windows [{name, kind}], scenarios [{sequence, title, location, narrative_time, summary, status}], messages [{time (ISO 8601 UTC), time_text, window, scenario (sequence), speaker, character, player (username), role, type, content, dice {expression, total, outcome, check_name, text}, visibility: public|gm|private}]}`. Links are absolute (`PUBLIC_URL`, else the request's host): media in the public bucket get their permanent public URL, others the API route (which asks for a sign-in). NPC cards, bios and appearance prompts are the GM's only; players see NPC names and art once the story ended. `sealdice` needs `chat_window_id` and returns story-painter's `{version: 105, items[{nickname, IMUserId, time, message, isDice, commandId?, commandInfo?, role}]}` for that window. `zip` bundles the JSON, the text and one SealDice JSON per window. Snapshot exports (`/snapshots/{s}/export?format=json`) use the same 2.0 format. Native 1.0 files (`{schemaVersion: "1.0", meta, events}`) still import. |

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
| GET/POST | `/projects/{p}/snapshots` | POST `{title?,scope:gm_full\|pl_public\|character,scope_character_id?,selection?:{mode,...,windows?}}`. Selection supports campaign, scenes (`scene_keys`), range, session, events (`event_ids`); `windows` (chat window ids of the channel, at least one) narrows any mode to those windows, keeping lines that belong to no window. |
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
| PUT | `/pevents/{event}` | Performance-only fields: hidden, display_kind, segments, voice, tts_text, style_instruction, assets/positions/effects. A stage placement (`character_asset_ids[]`) may name an outfit of its character (`outfit_id`; `""` = the base look; another character's is 400); one the reader filled in (`outfit_auto`) is not stored. Canonical text remains immutable. |
| POST | `/presentations/{p}/events/bulk` · `/merge` · `/reorder` | Existing edit operations; all event IDs must belong to the specified presentation. |
| POST | `/pevents/{event}/split` · `/suggestion` | Split uses character ranges; suggestion decision uses `{accept:boolean}`. |
| GET/POST | `/presentations/{p}/progress` | Per-user reading position. |
| GET | `/vn-scripts/status` | `{mock, model, cloud_allowed, images, max_lines, note}`. |
| GET | `/vn-scripts/windows?scope=&scope_character_id=` | The chat windows a visual novel may tell in that point of view (the same scope rules as POST): `{scope, windows[{id, name, kind, line_count}], unwindowed}`. The GM sees every window; a player the windows they are in or can read. `line_count` is what a snapshot of that scope would hold from the window. POST `/vn-scripts` takes `windows` (ids) to tell only those; without it every window is told. The job carries `params.windows` (and `windows` in the list), and a continuation keeps them. |
| GET · POST | `/vn-scripts` | Any member. GET lists the caller's jobs (all jobs for the GM). POST `{scope?: gm_full\|pl_public\|character, scope_character_id?, windows?, title?, template?, instructions?, allow_cloud?, generate_art?}` freezes the campaign log in that scope (players: `pl_public` or their own character) and queues a script job; `{snapshot_id}` plans an existing snapshot instead. `{continue_presentation_id}` (its author or the GM) continues that visual novel: the log is frozen again in its scope and only the lines after its last one are planned and appended to it (400 when there are none, 409 while another continuation runs; see [Continuing a visual novel](VISUAL_NOVEL.md#continuing-a-visual-novel-as-the-story-goes-on)). `allow_cloud:true` and the campaign cloud policy are required unless the LLM is in mock mode. Template values are validated (400 on bad values). |
| GET | `/vn-scripts/{j}` | The job's author or the GM. Job with `status` (`pending`, `running`, `waiting` while the script editor's questions are open, `completed`, `failed`, `cancelled`), `progress {chunks_total, chunks_done, lines, questions_open}`, `questions [{part_index, first_line, last_line, items [{id, question, refs, options}], answered, answers}]`, validated `script` ([VN_SCRIPT_SCHEMA.json](VN_SCRIPT_SCHEMA.json)) including `generation {backgrounds[], portraits[]}` (queued image jobs) and the draft `presentation_id`. Progress also arrives as `studio.vnscript.progress` WebSocket events. |
| POST | `/vn-scripts/{j}/cancel` | The job's author or the GM; pending, running or waiting jobs. |
| POST | `/vn-scripts/{j}/answers` | The job's author or the GM; a `waiting` job. `{part_index, answers: {"q1": "…"}}` answers that part's questions (at least one, each up to 2000 characters; the rest are the editor's own call), `{part_index, skip: true}` keeps the editor's draft for it. 404 for a part that asked nothing, 400 once it is answered. The job runs again (status `pending`) once every open part is answered, redoing only those parts (see [Questions from the editor](VISUAL_NOVEL.md#questions-from-the-editor)). Returns the job. |
| POST | `/vn-scripts/{j}/backgrounds/retry` | Draft author or GM. `{scene_key?, allow_cloud?}` resumes a single missing background, or all missing backgrounds when omitted. Keeps completed images and active jobs; failed/cancelled jobs reset their attempts. Original cloud consent is reused, while current campaign policy is rechecked. GET job details includes `background_jobs: [{scene_id,scene_key,job_id,status,error}]`, including `missing` for images never queued or not attached. |
| POST | `/presentations/{p}/cast` | Author or GM. `{cast: {narrator: voiceId, <character_id>: voiceId}}` sets the voice of narration/dice/system/scene lines and of each character's dialogue and actions; stored as `settings.cast`. Unknown voices are 400. |
| GET | `/presentations/{p}/bundle.zip` | Anyone who can read the presentation. ZIP with `index.html` (offline player), `script.json`, `assets/*` and `audio/*`, built during the request (kept for API and mobile clients; the web app uses the background bundle below). |
| POST | `/presentations/{p}/bundle` | `{force?}` prepares the same ZIP in the background for the caller's own view. Returns the job `{id, status: pending|running|ready|failed|expired, progress{files_done, files_total}, file_name, bytes, expires_at, download_path, public}`; a pending, running or still-current ready bundle is reused unless `force`. Stored for `VN_BUNDLE_TTL_HOURS` (default 24), in the public R2 bucket under an unguessable key when one is configured (GM-only `gm_full` presentations too), then deleted. |
| GET | `/presentations/{p}/bundles` | the caller's bundle jobs for the presentation, newest first (5) |
| GET | `/presentations/{p}/files` | The same standalone visual novel as a file list, for clients that save it file by file (the desktop app): `{title, folder, total_bytes, files: [{path, content} for index.html and script.json, {path, url, bytes, mime} for each image (path `assets/<id>-v<version>.<ext>`) and voice line]}`. URLs are API paths the client authenticates. Events in `script.json` carry `audio_ms`, the voice line's length. |
| GET | `/channels/{id}/studio/bundles/{job}/download` | the requester only, until it expires: a browser (`?token=` file token) is redirected to the public URL; header-authenticated clients and private bundles get the bytes. 404 once expired. |
| GET/POST | `/styles` | Versioned campaign art direction (POST GM). |
| PUT | `/styles/{id}` | GM edits/version bump. |
| GET | `/character-visuals` | NPC profiles are GM-only. |
| PUT | `/character-visuals/{character}` | Owner/GM maintains identity and reference/default assets. |

**Client caching of binaries.** Every binary route (`/media/{id}`, `/users/{id}/avatar`, `/atmosphere/assets/{id}`, `/studio/tts/audio/{id}`) sends an `ETag` (the stored object, which is never rewritten) and answers `If-None-Match` with `304`. A response a client may keep for good is marked `Cache-Control: private, max-age=31536000, immutable`:
- a media asset requested with `?v=N`, when a player could see it (not GM-only, approved, not an NPC's);
- a user avatar with `?v=`;
- an atmosphere backdrop;
- a TTS clip fetched by a player.

Everything else revalidates (`private, no-cache`, such as a media asset without `?v=`) or is only briefly cacheable: GM-private material and the GM's TTS clips get `private, max-age=…` without `immutable`. The web, desktop and mobile clients keep on disk only `immutable` responses, keyed without the file token, separately per account, and delete them on sign-out, so GM-private material is never written to a device.

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

All paths below are under `/api`. A channel player belongs to one group; GM identities cannot be assigned to groups.
`knowledge_mode=public` allocates new players to the first group; `isolated` creates a separate group for each new player.
Changing the mode does not move existing members.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/channels/{id}/player-groups` | GM: all groups; player: own group. Rows include `id`, `name`, `version`, `members` (`user_id`, `display_name`). |
| POST | `/channels/{id}/player-groups` | GM only, `{name}` (1–100 characters); creates an empty group. |
| PUT | `/channels/{id}/player-groups/{gid}` | GM only, `{name}`; renames a group. |
| PUT | `/channels/{id}/player-groups/{gid}/members/{uid}` | GM only, empty body; moves a channel player to the target group. Returns groups. |

Moving a player invalidates both affected groups' derived memory and increments their versions. Window membership changes
also invalidate affected groups. Raw chat and GM memory remain unchanged. Empty groups remain available for reuse.
`knowledge.reset` on the context WebSocket tells clients to discard cached documents, highlights, chat and pending drafts,
then refetch. Clients should reconcile group versions after reconnect (the web client also polls every ten seconds).
A group member can read a window witnessed by another member, but only direct window participants may post there.

Documents/facts/entities/revisions/highlights/shards/tools use the caller's memory partition. GM document endpoints return
only GM documents; player endpoints return only that group's five journals. `scene_id=all` retrieves all current-scene
entries for workshop browsing. Player scene titles are neutral sequence labels; private GM scene metadata is omitted.
The old fact-visibility write endpoint and sharing proposals cannot expose GM memory to players.

Posting a message accepts optional `reference_ids`, with at most five original message UUIDs from the same channel.
The server validates access before storing and again in the posting transaction. Message responses contain only the IDs,
never an embedded source excerpt. Fetch each reference with `GET /channels/{id}/messages/{mid}`; 404 means unavailable
for the current reader. A reference link grants no additional access. A quote may point at a message from another readable
window; the original `chat_window_id` is returned for navigation. Chat-origin event payloads retain `reference_message_ids`.

PDFs with memory appendices are private exports bound to GM or the originating player group and version. They cannot be
published as share links or requested with `pl_public` scope. Group changes invalidate access to old player memory exports.
Legacy PDFs containing shared-memory appendices become GM-only, and their old publication links are revoked by migration.

## Channel atmosphere backgrounds

Maintainers enable `features.atmosphere` in `PUT /servers/{id}/settings` and configure the independent `image` provider. Each user opts in with `PUT /auth/me {"atmosphere_enabled":true}`; both default off. The account field is a boolean and persists across logins.

`GET /channels/{id}/atmosphere` requires channel membership. Returns `{enabled:false}` when either switch is off; otherwise `{enabled:true,id?,mock?,assets?:{day_landscape,night_landscape,day_portrait,night_portrait}}`. Assets appear only when an entire four-image set is complete. Keys contain media asset IDs, not external provider URLs. A failed/incomplete newer set leaves the previous complete set active. Rejected, deleted or GM-private assets cannot be used as shared backgrounds.

`GET /channels/{id}/atmosphere/assets/{asset_id}` delivers version 1 of a current background with membership and both switches checked on every request. Accepts the normal Authorization header or a short-lived file token; private/no-store. The channel preview is separate from publication approval: generated assets stay candidates in Log Studio until the GM approves them for publishing.

`GET /channels/{id}/atmosphere/history` is GM-only. Returns the latest 100 sets with their scene label, mood, reason, all four prompts, source event IDs, timestamps and per-variant job status/error/asset ID. The database retains all sets. Prompt and source metadata also accompany each generated media asset. The asset library exposes this history for review and later VN reuse.

A `studio.atmosphere.updated` context WebSocket event invalidates the current set after image completion; clients also refresh on reconnect. Web uses device `prefers-color-scheme` and viewport orientation: light → day, dark → night, wide → landscape, tall → portrait. These are display variants, not assertions about story time. Native clients can use their resolved app theme and orientation with the same keys; their background UI is not added by this change. Web opacity is 0.26.

The GM observer invokes a separate structured LLM request with only public Main Chat GM narration that every occupied player group witnessed. No private narration, module secrets, player records or retrieval tools enter it. Context includes the previous set's four prompts. After at least three fresh public narrations, reviews are limited to once every two minutes. New sets require at least 30 minutes and 12 public narrations since the preceding request, no pending image jobs, confidence ≥0.85, fresh public source IDs, and a sufficiently established changed setting. Image calls use existing per-server image budgets, concurrency limits and retry handling. Review and generation timestamps persist across restarts.

Mock LLM mode only generates for an explicit public narration beginning `[Atmosphere] ` plus a scene description; three eligible public narrations and the same cooldown rules still apply. Mock images are visibly identified diagnostic patterns. No paid-provider request was made to validate this feature.

## Module import progress and duplicate protection

PDF imports return a saved task immediately. `POST /channels/{ch}/modules/text` accepts `{title,text,async:true}` or `{title,pages,async:true}` for the same background behavior. Omitting `async` retains synchronous text import for existing/native clients. HTTP success acknowledges receipt; inspect `status` before claiming the module is ready.

Module list/detail responses add `import_stage` (`queued`, `extracting`, `structuring`, `knowledge`, `ready`, `failed`), `completed_chunks`, `total_chunks`, and nullable `import_warning`. Chunk progress counts completed structured-text blocks, not elapsed time or a percentage of the whole import. Extraction, queueing and GM knowledge preparation have indeterminate progress. WebSocket `module.updated` events carry stage/counts and are GM-only; clients should also poll while an import is active and refresh after reconnect. Post-processing failure leaves a usable graph with `status=ready` and a visible warning; rebuild GM knowledge separately.

Content fingerprints and a unique per-channel index make concurrent/repeated submissions of the same PDF bytes or the same text section array return the existing module ID with `deduplicated:true`. A changed title alone does not make a new import. Existing records from before migration 0031 have no fingerprint and are not retroactively merged. Different content remains a separate import.

`POST /channels/{ch}/modules/{id}/retry` (GM only) restarts a failed saved task without uploading another file. Repeated retries of an active/ready task do not enqueue duplicate work. At backend startup, unfinished tasks are marked failed with an interruption message so they can be retried; this follows the existing single-instance deployment model. Queue saturation is reported as a saved failed task with a retry message. Blank text and non-readable/scanned PDFs cannot silently finish as successful imports.

Output limits are centralized in the LLM gateway: general requests receive at least `LLM_MAX_TOKENS` (default 8192), while `module_structure` and `script_knowledge` use `LLM_MODULE_MAX_TOKENS` (default 32768) and `LLM_MODULE_TIMEOUT_MS` (default 300000). OpenAI-compatible and Anthropic clients share these effective limits. Explicit deployment environment values override defaults; the configured model must support the selected output allowance. Existing token budgets still apply to actual usage. Provider truncation is a failure even if partial JSON appears parseable.

### Background GM knowledge rebuilds

`POST /api/channels/:channel/script-knowledge/rebuild` with `{ "module_id": "…", "async": true }` immediately returns a saved build job. Duplicate requests for an active module return the same job. GM-only `GET /api/channels/:channel/script-knowledge/builds` returns recent jobs with `pending/running/completed/failed`, `completed_batches`, `total_batches`, `error`, and final `result`. Poll until terminal; navigating away does not cancel a job. After a server restart interrupted jobs become failed and can be retried without reimporting the module. Omitting `async` retains the legacy synchronous response, executed on the bounded AI pool with a 90-second HTTP response deadline. Long rebuilds should use jobs.

Character pose/gesture (`subtitle` / `standee`) generation uses the approved main profile portrait as its identity reference. GPT Image requests explicitly send `background=transparent` and `output_format=png`, including multipart `/images/edits`; prompts request an isolated full-body cutout, retained identity and style, and no copied backdrop or painted checkerboard. These options are saved in new jobs and their cache keys. Backgrounds, avatars and main profile portraits retain their existing framing. The maintainer-selected model is preserved; GPT Image 2.5 model IDs include `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`. Mock standees are clearly labelled diagnostic PNGs with actual transparent margins. Existing opaque assets are not automatically regenerated.

API reference: [OpenAI image edits and transparent output](https://developers.openai.com/api/reference/resources/images/methods/edit).

Visual-novel script creation accepts optional boolean `retry_failed_chunks`. `GET /api/channels/{ch}/studio/vn-scripts/status` reports `max_tokens`, `timeout_ms` and the default `retry_failed_chunks`. `POST /api/channels/{ch}/studio/vn-scripts/{id}/retry` retries a failed job on its existing snapshot, with optional boolean `retry_failed_chunks`; it resets the attempt allowance but preserves validated part checkpoints. Only its owner or the GM can retry, and snapshot/cloud access is checked again. Other job states are rejected.
