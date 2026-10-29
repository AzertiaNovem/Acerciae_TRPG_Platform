# Acerciae — AI-assisted CoC / BRP tabletop platform

A multiplayer online table for Call of Cthulhu and other Basic Roleplaying games, built around one idea:

> **The AI never speaks in the chat.** It is a silent background chronicler that watches play, keeps six living
> documents up to date with traceable, incremental changes, and surfaces attention through highlights — not messages.

| Layer | Stack |
|---|---|
| Backend | C++20, [Drogon](https://github.com/drogonframework/drogon) (HTTP + WebSocket), [libpqxx](https://github.com/jtv/libpqxx), jsoncpp, libcurl, poppler-cpp |
| Database | PostgreSQL 16 with full-text search, `pg_trgm`, optional `pgvector` |
| Frontend | React 18 + TypeScript + Vite, zustand, react-markdown |
| AI | Per-server LLM gateway (OpenAI- or Anthropic-compatible), image and speech providers set by each server's maintainers, or a clearly labelled **Mock mode** |
| Deployment | Docker Compose (db / backend / frontend / PDF worker; optional MinIO) |

Screenshots (taken from the running app in mock mode):

| Context Bubble Dock | Fluorescent highlight on an earlier clue | Consistency check |
|---|---|---|
| ![](docs/screenshots/bubble-dock.png) | ![](docs/screenshots/clue-journal-highlight.png) | ![](docs/screenshots/consistency-check.png) |

| GM workspace | Module knowledge graph | Revision history |
|---|---|---|
| ![](docs/screenshots/gm-workspace.png) | ![](docs/screenshots/gm-module.png) | ![](docs/screenshots/revision-history.png) |
| Next per the script, pinned for the Keeper | The script knowledge and its reviewed changes | A reminder bubble opened: the quoted lines highlighted |
| ![](docs/screenshots/kp-board.png) | ![](docs/screenshots/script-knowledge.png) | ![](docs/screenshots/reminder-viewer.png) |
| The character space: COC7 role card | Appearance mode, generated portrait and subtitles | The Scenarios manager |
| ![](docs/screenshots/character-space.png) | ![](docs/screenshots/character-look.png) | ![](docs/screenshots/scenarios.png) |

## Quick start (Docker Compose)

```bash
cp .env.example .env            # AI keys are not set here: each server's maintainers configure them in Server settings → AI
# In .env set AUTH_SECRET and PDF_WORKER_TOKEN to two different random secrets (openssl rand -hex 32),
# and change the database password in POSTGRES_PASSWORD and DATABASE_URL.
docker compose up --build
```

* Frontend: http://localhost:5173 (register the first account, create a server)
* Backend API: http://localhost:8080/api/health — bound to this machine; PostgreSQL is too.
* The backend refuses to start without a strong `AUTH_SECRET`. For a throwaway local demo, `ALLOW_INSECURE_DEV=true` with
  `SEED_DEMO=true` seeds a demonstration campaign with users **keeper / alice / bob / carol**, password **password** —
  never on a reachable machine.
* Put TLS in front of port 5173 (any reverse proxy) before exposing it beyond localhost.

> Note: the Docker images were authored against the exact Ubuntu 24.04 package set used to build and test the backend in
> this repository's CI-less environment, but `docker compose build` itself was not executed in the authoring environment
> (no Docker daemon was available). See “Running without Docker” for the verified path.

## Running without Docker

Prerequisites (Ubuntu 24.04 names): `build-essential cmake ninja-build pkg-config libdrogon-dev libtrantor-dev libpqxx-dev
libpq-dev libjsoncpp-dev libpoppler-cpp-dev libcurl4-openssl-dev libssl-dev uuid-dev zlib1g-dev libbrotli-dev libhiredis-dev
libyaml-cpp-dev libsqlite3-dev libmariadb-dev` (the last one is only needed because Ubuntu's Drogon package was compiled with
MySQL support and its CMake config insists on finding the client headers; the platform itself is PostgreSQL-only),
PostgreSQL 16 (+ `postgresql-16-pgvector` optional), Node 22.13+ (or Node 24+), Chromium/Chrome and Noto CJK fonts for PDF publication.

```bash
# backend
cd backend
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build
createdb acerciae
AUTH_SECRET=$(openssl rand -hex 32) DATABASE_URL=postgresql://postgres@localhost:5432/acerciae MIGRATIONS_DIR=./migrations UPLOAD_DIR=/tmp/acerciae-uploads ./build/acerciae-server
# frontend (dev server proxies /api and /ws to :8080)
cd ../frontend && npm install && npm run dev
```

Migrations are applied automatically at startup (`schema_migrations` table). `./build/acerciae-server --migrate-only` and
`--seed-demo` (force re-seed, local development only) are also available.

## Configuration

Everything is read from environment variables; see [`.env.example`](.env.example). Highlights:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | libpq connection string |
| `LLM_TIMEOUT_MS`, `LLM_MAX_TOKENS`, `LLM_TEMPERATURE` | limits for the model calls servers make (providers and keys are per server, not environment variables) |
| `AI_ALLOW_PRIVATE_ENDPOINTS` (false) | allow server AI endpoints on private addresses or plain http — only for a trusted self-hosted model |
| `AI_HTTP_WORKERS` (4) | threads that run request-triggered model calls off the HTTP threads |
| `AI_OBSERVER_INTERVAL_MS` (5000) | scan cadence of the high-frequency observer |
| `AI_CONSOLIDATOR_INTERVAL_MS` (60000) | cadence of the low-frequency consolidation pass |
| `HIGHLIGHT_TTL_SECONDS`, `HIGHLIGHT_CLEANUP_INTERVAL_MS` | highlight lifetime and the independent expiry sweeper |
| `AUTH_SECRET` | HMAC key for API tokens and the key that seals per-server API keys. Required, ≥ 32 characters; the backend refuses a missing or published value unless `ALLOW_INSECURE_DEV=true` (local development only). Rotating it signs everyone out and invalidates stored server keys |
| `CORS_ORIGINS` | origins allowed to call the API cross-origin (empty = same origin only) |
| `TRUST_PROXY` | take the client address from the reverse proxy's `X-Real-IP` / `X-Forwarded-For` (login throttling) |
| `AUTH_REGISTER_PER_HOUR`, `RETENTION_AI_JOB_DAYS`, `RETENTION_AUDIT_DAYS` | registration throttle and retention of old rows |

There are no platform AI keys. Each server's maintainers set its language model, embedding model, image and speech providers
with the server's own keys (sealed at rest, never sent to browsers); a server without a provider runs in **Mock mode** (banner in
the UI, `llm_mode: "mock"` in the server settings). Provider endpoints must be https on a public address unless
`AI_ALLOW_PRIVATE_ENDPOINTS` is set; DNS is resolved once and pinned, and redirects are not followed.

## What is implemented

**Personal settings** — Eleven interface languages matching server settings, saved per account; editable login username, Unicode display name and uploaded avatar. The sidebar profile gear opens these controls. Personal language is independent of the server's AI/dice language. See [USER_SETTINGS.md](docs/USER_SETTINGS.md) for the API and validation.

**Product structure** — Servers → Channels (one campaign each, strictly isolated context) → Chat Windows (each with
its own participants; windows and scenes are many-to-many). GM / player roles; GM-only notes and whispers.

**Document-based background assistant** — six documents per channel (`Current Scene`, `Clue Journal`,
`Relationship Journal`, `Open Threads`, `Timeline`, `Module Progress` (GM)) with stable ids, independent version numbers,
entry-level addressing, full revision history and rollback. The AI proposes incremental ops
(`add_entry`, `update_entry`, `set_status`, `append_text`, `remove_entry`, `add_relation`, `link_facts`); the backend validates
sources, permissions, epistemic status, version and conflicts before committing.

**Epistemic status is first-class** — every fact is `attempted | confirmed | npc_claim | hypothesis | ai_inferred |
gm_secret | resolved | retracted`. The validator downgrades AI "confirmed" claims that lack a GM-authored source, and turns
contradictions of confirmed records into **pending GM proposals** instead of overwriting.

**Independent memory partitions** — KP memory and each channel player group's facts, entities, documents and revisions
have separate identities. Players share their group's readable chat perspectives. A separate observer builds each group's
five journals only from that chat and its own earlier summaries; it cannot retrieve KP/module memory. KP's six categories
are available in GM Workshop, with sections, source citations, revisions and correction controls.
Group or window-access changes invalidate and rebuild the affected player summaries. Existing KP records remain intact.
See [knowledge architecture and migration](docs/KNOWLEDGE_GROUPS.md).

**One campaign log** — a channel keeps a single log of the entire campaign across every chat window, pulled from the
chat itself (nothing is imported). Everyone downloads what they may read: the lossless Acerciae JSON, a
SealDice-compatible JSON per chat window, text, HTML or a zip of all of them. PDFs and visual novels are made from this
one log.

**Character space** — every character has a page: the avatar shown in chat, the main portrait, basic information,
the COC7-styled role card (characteristics, derived values, skills, wealth), background and carried items. The Keeper and
the character's actor edit it; everyone at the table reads a PC's page. Images come from uploads or, in generated mode,
from an appearance prompt that the image AI combines with the campaign's era and the current moment of the story; one
image per subtitle (IDLE, SAY, FIGHT, …) feeds the visual novel.

**Scenarios** — the story's stages, and a campaign-wide state: every chat window is in the channel's current
scenario. Only the Keeper opens the next one (or enters a prepared one), after a confirmation window that names the
current and the new scenario; at that moment the previous scenario closes,
gets an AI summary in the scenario list, and can only be consulted from then on. The Keeper's observer still watches the
narration: when it sees a shift of time or place it raises a "New scenario?" bubble in the Keeper's dock, anchored to the
line, but never opens one itself. Chat can be located by scenario or by time (`list_scenarios`, `get_chat_log`).
GM-edited summaries are never overwritten. Players see neutral scenario labels only.

**Keeper script knowledge** — when a module is imported, the model reads its structured graph and pages and writes the
Keeper's working knowledge: the flow of the script (its stages in order, what each needs, what the Keeper does there),
NPC and investigator relationships, clues, foreshadowing and background, each citing pages. The model reads this first
whenever it works for the Keeper. During play it proposes changes (a stage reached, a clue revealed, a twist paid off);
a second model reviews every proposal against the quoted chat lines before it is applied, and the Keeper's own edits are
final. Two cards stay pinned at the top of the Keeper's dock: what the script plans next, and the Keeper's notes (open
threads, timeline, latest reviewed changes). Keeper reminders can point at the script as well as at the chat. Nothing of
this is reachable by a player group.

**Reminder bubbles** — the players' dock no longer shows journals: their group's knowledge (relationships, clues,
open threads, and a per-scenario story index) is a hidden prelude the model reads first, a shortcut for searching.
After each batch the group's observer reads the current scenario and the end of the previous one and points out what the
players most likely forgot or need, as bubbles on the right. Every bubble is anchored to verbatim quotes from lines the
group can read (checked by `get_chat_log`; unverifiable quotes are dropped). Clicking a bubble opens the chat log around
the quoted lines with the passages highlighted in yellow-green, with jump and quote-as-reference. The Keeper keeps the six
documents.

**Scheduled AI observer** — every 5 s (configurable) per (channel, window, scene) group: cursor-based event reading, DB-level
task locks (`ai_jobs` partial unique index) plus in-process locks, batch analysis, tool-assisted retrieval, validated commit,
WebSocket notification, cursor advance. Player groups use independent generation-bound cursors and commits.
No new events ⇒ no LLM call. A separate KP consolidator runs at low frequency.

**Sharded context and the Tool API** — `get_current_scene`, `get_scene_by_id`, `search_scene_history`, `search_events`,
`get_entity`, `get_relationships`, `get_clue`, `get_open_threads`, `get_module_excerpt`, `get_knowledge_scope`, `get_shard`.
Every tool call runs under the calling identity's visibility filters (FTS + trigram, optional pgvector).

**Chat references** — players can attach up to five original messages to a new message, including from a journal source
viewer. References store IDs rather than copied excerpts; viewing or jumping to the original rechecks chat access.

**Highlights** — a separate short-lived `highlights` object bound to document entries (optionally a text range), with
reason, source events, priority, scope and expiry; pushed over the context WebSocket, fade-in in the UI, hover/click to
see why and jump to the original event, dismissable, swept by an independent cleanup loop.

**Consistency Check / Inspiration** — user-triggered only. Consistency returns a heuristic 0–100 % score (or
*Insufficient Evidence*), rationale, conflicts, traceable evidence and temporary user-scoped highlights; it never rewrites
or blocks the draft and never leaks GM-only facts. Inspiration returns an editable draft grounded only in the character's
knowledge, never auto-sent (insert / regenerate / discard).

**Integrated dice (Sealdice-compatible)** — any message that starts with a dot command (`.r` `.rh` `.ra`/`.rc` `.rah` `.sc` `.st`
`.en`; there is no separate roll option) is rolled automatically, evaluated against the
speaking character's attributes (`characters.sheet.attrs`, CoC 7e base values, English and 中文 aliases): hard/extreme
difficulty, bonus/penalty dice, sanity loss written back to SAN, hidden rolls whispered to the roller and the GM. While typing,
a gray hint follows the command (`.ra research —— Alice's research is 53`). Reply wording comes from built-in English/中文 texts
or server-defined text groups; each channel's GM picks one. GMs maintain NPC sheets by speaking as the NPC or in the character sheet. Checks follow 7e: a fumble is 100, or 96–100 when the number needed (after Hard/Extreme) is below 50; `.en` cannot
improve Cthulhu Mythos, and a skill improved to 90+ grants 2D6 SAN. `.st fast-talk 50` and `.sc 1 / 1d6` are accepted.

**Server maintainers** — the server owner and admins ("maintainers") set the server's language, its AI providers (language model with
thinking effort and embedding model, images, speech) and AI policy — a token and an image budget for the whole server (per month or
until reset) and how many AI tasks may run at once — and switch Consistency Check, Integrated Dice and Inspiration on or off; they invite and remove
members and delete channels (Server settings → Channels, after typing "Delete Channel"). Only the owner deletes the whole
server (Server settings → General, after typing "Delete Server"); members still in it are moved off at once. Keys are sealed with AES-256-GCM under `AUTH_SECRET` and never returned to clients; a server API base is only used with
the server's own key; there is no platform key to fall back to. They also set the server's access policy: how people join (an
invite link — the default —, open to anyone from the server directory, or closed so that only maintainers add members), who may
create channels (every member or maintainers only), whether channel GMs may invite **guests** from outside the server (a guest sees
only the channels they were invited to and leaves the server with their last channel), and whether members may **spectate** the
Main Chat of channels they were not invited to (read-only, only lines the whole table sees). Members are chosen with search-and-click pickers when creating chat windows, inviting to the server or a
channel, and managing an existing window's participants.

**PDF module import** — poppler text extraction per page → chunked LLM structuring into a conditional knowledge graph
(`module_nodes` / `module_edges`) with page citations → GM review/edit → progress recognition and “potential association”
hints when play touches or leaves module content. Module data is a separate GM-only layer from play events.

**Frontend** — all required components (`ServerSidebar`, `ChannelSidebar`, `ChatWindow`, `MessageList`,
`MessageComposer`, `ContextBubbleDock`, `ContextDocumentViewer`, `DocumentRevisionViewer`, `HighlightedText`,
`ConsistencyButton`, `ConsistencyResultPanel`, `InspirationButton`, `InspirationDraftPanel`, `GMWorkspace`,
`ModuleImportPanel`, `SceneManager`). Two WebSocket streams (`/ws/chat`, `/ws/context`); document bodies and highlights
live in separate stores so highlight traffic never re-renders document text; the dock collapses and never covers Send.

## Log Studio

The production workspace now supports SealDice/native import previews, alias mapping, source-preserving Canonical Logs,
versioned snapshots, styled HTML/JSON/text export, existing manually edited performances, character speech profiles,
Qwen HTTP and explicit Mock TTS, pronunciation dictionaries, selective audio cache invalidation, budgets and queued jobs.
Vivliostyle renders Classic Log, Investigation Dossier and Novel PDFs with Chinese text, covers, illustrations, configurable
page styles and permission-filtered document appendices. Published styled logs, existing performances and PDFs freeze their
content/resources and support revocable sharing. Style/character profiles, uploaded assets, candidate image generation and
reviewed delivery suggestions reuse the same campaign context without modifying historical facts.

Real Qwen speech and GPT-Image-compatible image adapters are implemented and exercised against local protocol fixtures,
but paid-service credentials were not available for live verification. Mock TTS produces labelled tone WAVs; Mock images are
labelled procedural test patterns. They do not pretend to be real voices/artwork. Local Qwen3 inference, video/FFmpeg export
and pixel-perfect generated identity are not implemented. Docker/MinIO deployment has not been executed here; the local
C++/PostgreSQL/Node path was tested.

Open Log Studio: the campaign log is there for every member within their own view, and snapshots of it feed PDFs and
visual novels. The Keeper decides whether the Studio is shown and whether players may open it before the story ends; ending
the story opens it to everyone with the whole story. The GM sets the speech budget and enables cloud processing for Studio
work under Campaign production settings (disabled by default); providers and keys come from Server settings → AI. A
separate PDF worker must be running for PDF jobs to leave pending state:

```bash
npm --prefix pdf-worker ci
# Set the same PDF_WORKER_TOKEN on the backend and this worker.
API_BASE=http://127.0.0.1:8080 PDF_WORKER_TOKEN="$PDF_WORKER_TOKEN" node pdf-worker/src/index.mjs
```

On the Visual novel tab any member can make a visual novel in four steps: the LLM reads the campaign log in their scope
as time blocks and writes the script (backgrounds and portrait subtitles, never new text), the image AI paints missing
backgrounds and generated-mode portraits, the author casts a voice for every character and the narration (Qwen TTS),
and a zip with a standalone HTML player, the images and the voice lines downloads for offline viewing. The server
maintainer can turn the Log Studio off, and the Keeper can hide it per channel or keep it from players until the story
ends. See
[visual novel guide](docs/VISUAL_NOVEL.md).

A server maintainer can switch on **COC7 point-buy** (Server settings → Features): role cards then show the
characteristic total, take a career from the built-in list of 230 (credit-rating range, points formula, career skills,
option groups and free specialties, generated from the community COC7 sheet), and split skill investment into career
points (career skills only) and hobby points (INT×2, any skill) with the limits enforced on save. Skill names follow
the server language, and dice commands take them in English or that language (`.ra 目星` on a Japanese server). See
[COC7 point-buy](docs/COC7_POINT_BUY.md).

See [Log Studio guide](docs/LOG_STUDIO.md), [speech provider](docs/TTS_PROVIDER.md), [media/generation](docs/ASSETS.md),
[PDF templates](docs/PDF_TEMPLATES.md), and [example fixtures](examples/logstudio/README.md). `docs/API.md` includes the
shared mobile-facing contracts; `mobile/` development is maintained independently.

## AI Game Master client

[`gm-agent/`](gm-agent/README.md) is an optional Node.js client that sits at the table as the Keeper through the same
HTTP + WebSocket API the web and mobile apps use. It narrates and voices the NPCs with the Keeper's full context,
including the platform's AI tips (board, reminders, script knowledge, documents, highlights). It also plays a chosen
number of **co-players**: AI investigators whose COC7 role cards its LLM writes, and who see only the chat lines their
character witnessed.

```bash
cd gm-agent && npm install && cp .env.example .env   # account, ANTHROPIC_API_KEY (or another provider)
node src/cli.mjs setup --coplayers 3 && CHANNEL_ID=<printed id> npm start
```

## Tests

```bash
scripts/test.sh                      # everything below, against a local PostgreSQL (CI runs the same script)
# or individually
backend/build/unit_tests             # no DB needed
(cd backend && TEST_DATABASE_URL=postgresql://postgres@localhost:5432/acerciae_test ./build/db_tests)
# every HTTP suite against a running backend (start it with ACERCIAE_STRICT_DB=1 to fail on nested transactions,
# AUTH_REGISTER_PER_HOUR high enough for the suites' registrations, and a PDF worker for logstudio.test.mjs)
API_BASE=http://localhost:8080 node --test --test-concurrency=1 tests/integration/*.test.mjs
npm --prefix pdf-worker test
npm --prefix frontend test && npm --prefix frontend run build
npm --prefix gm-agent test
```

See [docs/ACCEPTANCE_SCENARIOS.md](docs/ACCEPTANCE_SCENARIOS.md) for how each mandated scenario is exercised and how to
reproduce it by hand with the demo campaign.

## Documentation

* [第十三声雾钟](docs/DEMO_STORY.zh-CN.md) — Chinese demo story and feature walkthrough for the Keeper, with a separate [player handout](docs/DEMO_STORY_PLAYER_HANDOUT.zh-CN.md)
* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, data model, permission model, schedulers
* [docs/DATA_FLOW.md](docs/DATA_FLOW.md) — the vertical flow from message to highlighted document, proposal validation
* [docs/API.md](docs/API.md) — HTTP and WebSocket reference
* [docs/ACCEPTANCE_SCENARIOS.md](docs/ACCEPTANCE_SCENARIOS.md) — the seven scenarios
* [docs/OPERATIONS.md](docs/OPERATIONS.md) — deployment checklist, TLS, backups and restore, upgrades, housekeeping
* [docs/SERVER_AI_SETTINGS.zh-CN.md](docs/SERVER_AI_SETTINGS.zh-CN.md) — server AI providers and AI policy
* [gm-agent/README.md](gm-agent/README.md) — the AI Game Master client: roles, what each role sees, configuration

## Known limitations (explicitly out of the MVP)

* **Mock LLM mode is rule-based.** It demonstrates every pipeline end to end and is deterministic, but its extraction is
  heuristic English pattern matching; the live mode uses the same prompts, schemas, tools and validators with a real model.
* Semantic (pgvector) retrieval is wired but only active when the server sets an embedding model; FTS + trigram is the default.
* Timeline compression and relationship merging in the consolidator are conservative (resolve promise threads, drop exact
  duplicate relationships); richer long-term compression is left to the live model.
* Group membership is managed explicitly by the KP. Changing it rebuilds derived player journals from currently readable
  chat; the AI never directly shares or copies KP facts. Public/isolated channel mode controls new-player allocation.
* Database access is synchronous on Drogon's IO threads (pooled libpqxx connections); adequate for table-sized loads,
  not tuned for very large deployments. Multi-instance deployment is possible (locks and cursors live in PostgreSQL;
  WebSocket fan-out is per instance and would need a broker for cross-instance pushes).
* The Node e2e suite uses the `ws` package because Node's built-in WebSocket reuses pooled HTTP connections, which Drogon
  does not upgrade (browsers always open a fresh connection, so the product is unaffected).

## License

BSD 3-Clause; see [LICENSE](LICENSE).

### Optional channel atmosphere

Server settings → Channel atmosphere backgrounds enables automatic generation using that server's image provider and budget; User settings → Show channel atmosphere backgrounds enables personal display. Both switches default off. The Keeper-side LLM conservatively evaluates public narration and remembers previous prompts. It generates four images of the same place: landscape day, landscape night, portrait day, portrait night. Web selects day/night by the device light/dark theme, not the story clock, and displays the appropriate orientation at 26% opacity.

A new set requires a 30-minute cooldown and at least 12 further public Keeper narrations; uncertain/minor changes reuse existing art. All four images must finish before switching. Prompts and source references are retained, with Keeper-readable history in Log Studio → Assets; generated images remain candidates for publication review and can be reused after approval. Private Keeper knowledge and split-party chat are excluded from shared background generation. Migration `0030_channel_atmosphere.sql` is additive. [API and native client contract](docs/API.md#channel-atmosphere-backgrounds).

The integration test `tests/integration/atmosphere.test.mjs` exercises opt-in, four-image mock generation, image access, cooldown and privacy against an isolated backend. Database tests cover previous-prompt context, uncertainty, private evidence rejection and fallback to a complete prior set. Frontend tests cover all four theme/orientation combinations. Real image API credentials were not used for this feature's verification; the existing GPT Image adapter is reused.
