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

Performance suggestions use the existing LLM gateway, with 1–30 explicitly selected presentation event IDs. They save candidate delivery instructions and reasons only. Accepting a suggestion updates presentation data; neither images nor suggested emotion are written into the Canonical Log or narrative memory. Visual novels are generated from the campaign log; see [VISUAL_NOVEL.md](VISUAL_NOVEL.md).

### Storing images in Cloudflare R2

Media bytes go to the object store chosen by `OBJECT_STORE` (`local`, `s3` or `r2`). `IMAGE_STORE` (same values,
defaulting to `OBJECT_STORE`) overrides it for images only, so `IMAGE_STORE=r2` keeps portraits, avatars, backgrounds and
generated art in R2 while speech and PDFs stay where `OBJECT_STORE` puts them. Configure R2 in `.env` with
`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (an R2 API token limited to Object Read & Write
on that private bucket); `R2_ENDPOINT` overrides the endpoint, e.g. for the EU jurisdiction. The backend signs requests
with AWS Signature V4 (region `auto`) and refuses to start when R2 is selected but incomplete.

Images are never served from R2 directly: browsers keep fetching `/api/channels/{id}/media/{asset}`, which checks
channel membership, GM-only visibility and approval before streaming the bytes, so the bucket stays private.

Switching back is a single setting: `IMAGE_STORE=local`. Reads try the configured backend first and then every other
one that is configured (the local directory always, R2 while its variables remain), so images written under either
setting stay readable. To move them for good, copy them with the backend binary and then remove the old settings:

```bash
acerciae-server --copy-images local r2     # existing local images → R2
acerciae-server --copy-images r2 local     # back from R2
```

The copy covers every version of every image asset, skips objects the destination already has, never deletes, and
can be re-run safely. With Docker Compose: `docker compose run --rm backend /app/acerciae-server --copy-images local r2`.

For MinIO development, set S3 variables in `.env`, use `docker compose --profile s3 up`, create a private bucket and provision a bucket-scoped access key. The profile has a development-only fallback password; configure a strong `S3_SECRET_KEY` before using shared infrastructure. The local object-store path was integration-tested; Docker/MinIO were not run in this environment.
