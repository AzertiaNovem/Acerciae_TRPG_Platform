# Log Studio architecture and compatibility

Log Studio extends the existing campaign channel, identity and permission system. A campaign ID in the exchange model is the existing channel ID; no parallel campaign membership system exists. Canonical events live in `log_events`, immutable materialized selections in `log_snapshots`/`log_snapshot_events`, performance data in `log_presentations`/`presentation_events`, and output style in `pdf_templates`/`pdf_render_jobs`. The existing React player/editor is retained. Automatic visual-novel template generation is deferred by request.

Migrations `0007_logstudio.sql`, `0008_tts_audit.sql`, `0009_studio_publication.sql`, `0010_snapshot_metadata.sql` and `0011_studio_cloud_policy.sql` are additive. The two historical `0007_*` files belong to separate Claude branches; the migration ledger keys full filenames, so both run once. Do not renumber an already applied migration. Backfilling old snapshots can freeze only their state at migration time; it cannot reconstruct earlier metadata that was never stored.

## Import compatibility

Native JSON supports `schemaVersion:"1.0"`, with extension data in `metadata`, `source_reference` and original `raw_text`. See `LOG_SCHEMA.json`. Known native version mismatch is rejected. Import previews are stored before commit; uncertain lines/items remain events with issues rather than disappearing. Role/alias mapping is a user decision; identical IM IDs under different nicknames are offered as separate keys for manual mapping.

SealDice compatibility was checked against [story-painter](https://github.com/sealdice/story-painter/tree/fad63caf6ce3690d7e629cc747e4044210f04acc/src/logManager/importers), specifically SealDiceLogImporter, EditLogImporter and RenderedLogImporter at commit `fad63caf6ce3690d7e629cc747e4044210f04acc`. Supported JSON is `{version,items:[{nickname,IMUserId,time,message,isDice,commandId?,commandInfo?,...}]}`; the repository fixture uses version 105. The top-level version is recorded, but this is not blanket certification of all SealDice releases. JSON export is the native schema, not a fabricated universal SealDice JSON.

Text compatibility covers `nickname(IMUserId) YYYY/MM/DD HH:MM:SS` followed by multiline message content (optional date and `#n` suffix), rendered text `[date ]HH:MM:SS<nickname(QQ)>:message`, and QQ export `YYYY-MM-DD HH:MM:SS nickname(QQ)`. Arbitrary rendered HTML import is not supported. UTF-8/BOM, BOM-tagged UTF-16 and inferred GB18030/GBK are converted losslessly to UTF-8; inferred encoding is reported for preview review. Invalid byte sequences are rejected with an actionable encoding error before saving an import.

Message whitespace, CQ codes, original JSON items and unrecognized content are retained. CQ media extraction adds structured metadata and optional display text; it does not fetch arbitrary remote media. Source log timestamps without a timezone are interpreted as UTC, with original textual timestamps retained when a complete date is absent. Native imports/exports preserve nullable fields instead of inventing missing dice results. Sample text/JSON are authored fixtures following the verified format, not real player records.

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
```

Run the HTTP suites against an isolated server/database with `TTS_PROVIDER=mock`, `IMAGE_PROVIDER=mock`, and a running PDF worker. They create their own users/campaigns and leave those test records for inspection. `PDF_TEST_OUTPUT` can point to an existing directory to save the three generated PDFs. The studio suite exercises source preservation, multiline/renamed/OOC imports, immutable metadata, structured dice, affected-line cache invalidation, private audio/jobs/PDF access, candidate images, approval/reuse, three actual PDFs, publication file permissions and revocation. Browser playback/audio unlock is a manual check; HTTP tests do not certify every browser or real Qwen speech quality.

The `mobile/` workspace is owned by a separate agent and was not included in this implementation. Its clients can use the stable contracts in `API.md`; the local mobile/demo server was not restarted for these tests.
