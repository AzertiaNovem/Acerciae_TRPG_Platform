# Log Studio architecture and compatibility

Log Studio extends the existing campaign channel, identity and permission system. A campaign ID in the exchange model is the existing channel ID; no parallel campaign membership system exists. Canonical events live in `log_events`, immutable materialized selections in `log_snapshots`/`log_snapshot_events`, performance data in `log_presentations`/`presentation_events`, and output style in `pdf_templates`/`pdf_render_jobs`. The existing React player/editor is retained. Visual-novel look templates and LLM-organised scripts are described in [VISUAL_NOVEL.md](VISUAL_NOVEL.md).

Migrations `0007_logstudio.sql`, `0008_tts_audit.sql`, `0009_studio_publication.sql`, `0010_snapshot_metadata.sql`, `0011_studio_cloud_policy.sql`, `0012_user_preferences.sql` and `0013_vn_scripts.sql` are additive. The two historical `0007_*` files belong to separate Claude branches; the migration ledger keys full filenames, so both run once. Do not renumber an already applied migration. Backfilling old snapshots can freeze only their state at migration time; it cannot reconstruct earlier metadata that was never stored.

## The campaign log

One channel keeps one log: every chat window, the whole campaign. `GET /studio/log` creates the project on first
use and pulls every new channel event under a system identity, so each line carries its own visibility and
readers are filtered when they read or export. Nothing is imported from outside any more: the import adapters,
their preview/commit endpoints and the log editor's scene surgery were removed (the parsing helpers stay in
`LogAdapters.cpp` for classification and for the SealDice text export).

Exports need no snapshot and are available to every member within their own view: the lossless native JSON
(`LOG_SCHEMA.json`, now with `meta.windows`, `meta.scenarios`, `meta.characters`), plain text, HTML, a
SealDice-compatible JSON per chat window (`{version:105, items[]}` as story-painter reads it, with the structured
dice result under `commandInfo`), and a zip of all of them.

## Who reads what

Access to the Log Studio (`studioAccess`): the server maintainer can turn the feature off for the whole server.
Before the story ends, the Keeper decides whether the Studio is shown in the channel at all (`studio_visible`) and
whether players may open it (`studio_player_access`; refused with 403 `studio_locked`). When the Keeper ends the story
(`POST /channels/{id}/story/end {reveal_keeper_lines?}`), the Studio opens to every member regardless of those
switches; `POST /channels/{id}/story/reopen` restores them.

Which lines a reader sees is decided when they read, never frozen at sync time:

* the Keeper reads everything;
* before the end, a player reads a line from the channel's chat only if the chat itself lets their player group read
  it (`player_group_readable_messages`), whatever the knowledge mode — a Keeper side window, another group's window or
  a Keeper-only line never appears. Whispers (hidden rolls included) stay with the characters they were addressed to,
  even inside a shared group. Scenario titles and locations read "Scenario N", and a scenario the Keeper only
  prepared is not a line at all;
* after the end, every member reads the whole story — every window, whispers and hidden rolls, real scenario titles —
  except Keeper-only lines, which appear only if the Keeper chose to reveal them.

Snapshot scopes use the same rules: `pl_public` holds the lines every player group can read (never a whisper),
`character` the lines that character's player can read. A players' snapshot made before the end freezes masked
scenario titles. Presentations and publications show player characters' visuals plus the NPCs who speak in their
lines; an NPC's art never appears in a player's media library and its appearance notes stay with the Keeper.

## Snapshots, privacy and publication

Snapshots freeze ordered event text/metadata, role mappings, scene labels, scope and creation version. New chat events require explicit sync and a new snapshot. Current access restrictions are also checked when reading a working snapshot. GM-only, public-player and per-character snapshots are distinct. UI hiding is not the permission boundary: API, TTS jobs/audio, images and PDF downloads check access independently.

Only GMs publish. `gm` publication is restricted to GMs; `players` is authenticated channel access; `link` is an explicit bearer-share capability. Player/link publishing requires a `pl_public` snapshot. Shared responses omit storage keys and expose only files captured by that publication. Tokens are not listed to other members. Revocation disables both the content endpoint and every file endpoint. Already downloaded files cannot be recalled. Publication freezes assets and audio references separately from working presentation changes; it does not write back to narrative facts.

Workers use PostgreSQL task tables. TTS workers live in C++, the image worker uses an independent provider interface, and only PDF layout runs in Node. Studio progress events use the existing context WebSocket. Polling remains supported and is required for reliable state after reconnects; sensitive job progress is sent only to GMs. Audit rows track imports, sync, snapshots, PDF jobs/downloads, publishing, revocation and generation/suggestion requests.

## Verification

```bash
cmake -S backend -B backend/build
cmake --build backend/build -j 4
backend/build/unit_tests
# This DB test resets its database: only use an explicitly disposable database.
(cd backend && TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/acerciae_test ./build/db_tests)
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix pdf-worker ci
npm --prefix pdf-worker test
API_BASE=http://127.0.0.1:18081 node --test tests/integration/scenarios.test.mjs
API_BASE=http://127.0.0.1:18081 node --test tests/integration/logstudio.test.mjs
API_BASE=http://127.0.0.1:18081 node --test tests/integration/vnscript.test.mjs
```

Run the HTTP suites against an isolated server/database with `TTS_PROVIDER=mock`, `IMAGE_PROVIDER=mock`, and a running PDF worker. They create their own users/campaigns and leave those test records for inspection. `PDF_TEST_OUTPUT` can point to an existing directory to save the three generated PDFs. The studio suite exercises source preservation, multiline/renamed/OOC imports, immutable metadata, structured dice, affected-line cache invalidation, private audio/jobs/PDF access, candidate images, approval/reuse, three actual PDFs, publication file permissions and revocation. Browser playback/audio unlock is a manual check; HTTP tests do not certify every browser or real Qwen speech quality.

The `mobile/` workspace is owned by a separate agent and was not included in this implementation. Its clients can use the stable contracts in `API.md`; the local mobile/demo server was not restarted for these tests.
