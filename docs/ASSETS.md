# Assets, style and generation

Media bytes live in `ObjectStore` (local development or S3-compatible storage); PostgreSQL stores IDs, versions, MIME/size, provenance, license metadata, approval and campaign scope. Uploads work with every AI provider disabled. Local files are stored under `UPLOAD_DIR/objects`; the S3 implementation uses private objects and backend-authorized delivery, not public bucket URLs.

Uploads are sniffed rather than trusting browser MIME types. Image uploads are bounded at 20 MB, audio at 50 MB and video at 200 MB, also subject to the global HTTP upload limit. Replacements are capped at 50 MB and require approval again. Generated art is initially a GM-private candidate. GM approval and changing visibility to `channel` are separate decisions; neither happens automatically. Uploaded/source media may record license/consent metadata. Published performances freeze asset version and object key; replacing the current image does not alter a publication. Deleting an asset referenced by an unrevoked publication is blocked.

`VisualStyleProfile` stores art direction, palette, lighting, rendering style, period, aspect ratio, negative constraints and reference IDs with a version. `CharacterVisualProfile` stores the approved identity description and reusable character assets. The image worker captures both profiles and approved reference bytes at submission. Only explicitly selected snapshot events are included as source text. Style and character references help consistency, but approval is the actual consistency gate; the system makes no pixel-level identity guarantee.

## ImageGenerationProvider

Server maintainers can now configure an independent image provider in Server settings → AI services. `image.provider`
is `inherit`, `disabled`, `mock`, or `gpt_image`; `api_base`, `api_key`, `model`, `size` and `quality` are separate from
text and TTS. Custom image settings never borrow platform/text/TTS credentials. Settings are resolved per channel at
submission and execution; pending jobs reject changed configuration rather than silently moving to another endpoint.
The `gpt_image` adapter uses JSON `/images/generations` or multipart `/images/edits` with actual stored reference bytes,
requests PNG, and decodes `data[0].b64_json`. It does not send the legacy `response_format` parameter or fetch returned URLs.
See [server configuration and character references](SERVER_AI_SETTINGS.zh-CN.md).

Character pose jobs freeze the main portrait's image/version as their reference. A batch that also generates a main
portrait creates a dependency on that specific job, resolves its output before calling the image provider, and fails
dependent poses if the portrait failed/cancelled. Visual-novel pose requests follow the same rule. Existing approved
main portraits can be uploaded and do not require an appearance prompt for pose-only requests.

Each server's maintainers pick the image provider in Server settings → AI: `disabled` reports generation unavailable; `mock` (the default) returns a visibly labelled procedural checkerboard and records `source_type:mock` — a diagnostic fixture, not AI artwork; `gpt_image` calls a GPT-Image-compatible Images API with the server's own base URL, key and model (see [server AI settings](SERVER_AI_SETTINGS.zh-CN.md)). There are no platform image credentials.

Generated images are decoded and validated before storage; remote image URLs are never fetched. Keys stay in the backend. The queue retries transient failures at most twice and supports cancellation/stale-job recovery.

Live Log Studio jobs (backgrounds, standees, visual-novel art) require both the campaign's `studio_cloud_allowed` setting and explicit `allow_cloud:true` for the selected inputs. Character-page art (portrait, avatar, poses) only needs the server's image provider and the requester's `allow_cloud:true`. Every live image counts against the server's image budget and concurrency limit. Disabling the policy prevents new provider requests while leaving uploaded assets and existing cached results usable. The reference image gateway has not been tested against a paid image provider here.

Performance suggestions use the existing LLM gateway, with 1–30 explicitly selected presentation event IDs. They save candidate delivery instructions and reasons only. Accepting a suggestion updates presentation data; neither images nor suggested emotion are written into the Canonical Log or narrative memory. Automatic visual-novel template generation is intentionally deferred.

For MinIO development, set S3 variables in `.env`, use `docker compose --profile s3 up`, create a private bucket and provision a bucket-scoped access key. The profile has a development-only fallback password; configure a strong `S3_SECRET_KEY` before using shared infrastructure. The local object-store path was integration-tested; Docker/MinIO were not run in this environment.
