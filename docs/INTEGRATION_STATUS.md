# Integration status — 27 October 2026

Both Claude branches were merged into `main` and pushed as `25c1b53`. The additional Log Studio implementation is on `codex/log-studio-publication`. Automatic visual-novel template generation is deliberately deferred; the existing manually edited presentation/player is retained. No files under `mobile/` were edited or staged by this work.

## Local services

The original demo backend on port 8080 was left running without restart. The Studio acceptance backend runs at `http://127.0.0.1:18081`, using database `acerciae_studio_e2e_20261026` on PostgreSQL port 55432. Its React UI is at `http://127.0.0.1:5175`; a separate PDF worker claims jobs from 18081. These are development processes, not installed system services. The mobile agent separately reports its own backend on port 18082 and database `acerciae_mobile_demo`; this work does not control those processes.

The seeded Studio accounts are `keeper`, `alice`, `bob`, and `carol`, with development password `password`. For an already populated Studio example, log in as `gm0pf9vbumb9u` with the same development password, then open channel `4384422d-8fff-4105-a24c-22d8b523b028`. That campaign contains the Chinese dock log, mock voice assets, approved mock images, and rendered PDFs. Mock audio is a test tone, not real synthesized speech.

## Client contracts

Personal settings are now available on the Studio backend through `PUT /api/auth/me`: username, display name, avatar and one of the same eleven interface languages as server settings. Login/me responses carry these preferences; message payloads add `author_avatar_version`. See [USER_SETTINGS.md](USER_SETTINGS.md). This additive change does not restart the mobile backend on 18082.

The exact request and response fields are documented in [API.md](API.md). Authenticated clients should send `Authorization: Bearer <login token>` for JSON, media, stored speech and PDF downloads. IDs and UI visibility are not authorization. Treat 403/404 as unavailable rather than retrying a broader scope.

The minimal snapshot/read/export chain is:

1. Authenticate through `POST /api/auth/login`; discover permitted servers, channels and windows using the existing APIs.
2. Use `/api/channels/{channel}/studio` as the Studio prefix. List `/projects`; a GM can create a project, `POST /projects/{project}/sync`, then `POST /projects/{project}/snapshots` with `{ "scope": "pl_public" }`.
3. Read `GET /snapshots/{snapshot}` for ordered frozen events; export via `/snapshots/{snapshot}/export?format=json`, `txt` or `html`.
4. List `/presentations?project_id={project}` and read `/presentations/{presentation}` for existing authored performances. Play stored clips from `/tts/audio/{audio_id}`; playback never invokes synthesis. Save per-user reading position at `/presentations/{presentation}/progress`.
5. For PDFs, list `/pdf/jobs`, poll `/pdf/jobs/{job}`, and fetch `/pdf/jobs/{job}/file` only when completed. A GM creates a job at `POST /snapshots/{snapshot}/pdf` with controlled `config`; built-ins come from `/pdf/templates`.
6. Published files use `/publications/{publication}/files/{id}` (authenticated) or `/api/published/{share_token}/files/{id}` (explicit link share). Use `pdf` as the file ID for a PDF. Revocation disables both metadata and files.

Use the exact structured chat `dice` result and its `text` field. Canonical logs keep the original command in `content` and the source result in `metadata.dice_result`; never reroll on replay. Public hidden-roll notices intentionally omit the actual result. Snapshot `campaign_id` is the existing channel ID, and `speaker_id` aliases the stable speaker key.

TTS cost estimation uses a flat `event_ids`/`scene_ids` selection; job submission nests that selection in `scope`. Poll job endpoints after reconnecting: sensitive progress notifications are GM-only. A server maintainer configures provider credentials, while a channel GM controls `/studio/settings` cloud permission and character budget. Cloud permission defaults to false. Dictionary contents are GM-only. See [TTS_PROVIDER.md](TTS_PROVIDER.md) for provider capabilities and cost limitations.

The schemas and routes above are the implemented integration contract. Future provider additions can add capability fields and preset voices; clients should tolerate unknown fields and show unavailable capabilities explicitly. No mobile-specific replacement API is required.

## Verified and pending

The backend compiled; 188 unit checks and 98 database checks passed. All 10 existing HTTP integration scenarios passed. The Studio HTTP acceptance scenario passed against a real PostgreSQL database and running Vivliostyle worker, including Chinese/source preservation, frozen snapshots, structured dice, two character voices, selective cache invalidation, private data isolation, candidate approval, three real PDF templates, and revocable publication. The PDF worker's three unit tests and frontend production build passed. PDF.js browser preview was visually inspected, including Chinese text, colors, dice and pagination; [the screenshot](screenshots/log-studio-pdf.png) records that result.

Qwen and image providers have real configured execution paths plus explicit mock modes, but no paid external request was made. Real credentials, regional availability, speech quality, Docker/MinIO deployment and the complete native mobile playback experience remain environment-specific validation. The frontend build reports its existing large-main-chunk warning. See [LOG_STUDIO.md](LOG_STUDIO.md) for repeatable test commands; database tests must use a disposable database because they reset its schema.
