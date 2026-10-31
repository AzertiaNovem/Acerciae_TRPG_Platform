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

### Cloudflare R2: storage, direct downloads and moving existing media

**Where bytes go.** `OBJECT_STORE` (`local`, `s3` or `r2`) holds all media; `IMAGE_STORE` (same values, defaulting to
`OBJECT_STORE`) overrides it for images. Configure R2 with `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` (an R2 API token with Object Read & Write on the buckets below); `R2_ENDPOINT` overrides the
endpoint, e.g. for the EU jurisdiction. Requests are signed with AWS Signature V4 (region `auto`); the backend refuses
to start when R2 is selected but incomplete.

**Direct downloads (saving the backend's bandwidth).** Set `R2_PUBLIC_BUCKET` to a second bucket that has public access
(a custom domain or the `r2.dev` URL) and `R2_PUBLIC_BASE_URL` to that address. Media that is not secret is then written
there under keys starting with `pub/`:

| Goes to the public bucket | Stays private (streamed through the backend) |
|---|---|
| AI-generated images (and the mock provider's stand-ins), except SVG | uploaded images, audio, video and documents |
| voice clips (TTS audio) | PDFs, publications, log imports |
| user avatars | voice-enrollment samples (never stored) |

Browsers still ask the backend: `/api/channels/{id}/media/{asset}`, `/studio/tts/audio/{id}` and `/api/users/{id}/avatar`
check membership, Keeper-only visibility and approval exactly as before, then answer with a `302` to the public URL
instead of streaming the bytes. The redirect is a few hundred bytes; the picture or clip itself comes from Cloudflare,
which may cache it for a year (`Cache-Control: public, max-age=31536000, immutable`; every version has a new key).
Keys contain random UUIDs and an R2 bucket is never listable, but a URL, once handed out, works for whoever has it:
that is why only the media above is placed there. Native apps send an Authorization header and keep receiving the bytes
(some HTTP stacks would forward the header across the redirect).

Give the public bucket a CORS rule allowing `GET` from your site's origin; the visual-novel player's sound effects
are fetched by script and need it (pictures and voices play through `<img>`/`<audio>` and do not).

**Moving existing media: automatic.** Every start runs the media migration in the background (`MEDIA_MIGRATION=false`
turns it off; `acerciae-server --migrate-media` runs it in the foreground and prints a report):

1. avatars still stored inline in PostgreSQL become media objects;
2. with a public bucket, existing AI art, voice clips and avatars are copied there and their rows repointed to the
   `pub/` key (only after the copy succeeded);
3. everything still in the local directory that now belongs in object storage is uploaded, once (recorded in
   `object_migrations`).

So turning R2 on is enough: the next start sends the local media up. Local files are kept unless
`MEDIA_MIGRATION_DELETE_LOCAL=true`; failures are logged and retried on the next start.

**Switching back.** Set `OBJECT_STORE`/`IMAGE_STORE` back to `local` and remove `R2_PUBLIC_BASE_URL` (keep
`R2_PUBLIC_BUCKET` and the credentials for a while): new media is written locally, everything is streamed by the backend
again, and reads still find objects in R2. To leave R2 for good, copy first, then remove the R2 settings:

```bash
acerciae-server --copy-media r2public local   # the public bucket (avatars, voices, AI art)
acerciae-server --copy-media r2 local         # the private bucket
acerciae-server --copy-images local r2        # only images, e.g. into the private bucket
```

Copies keep the keys, skip what the destination already has, never delete, and can be re-run. With Docker Compose:
`docker compose run --rm backend /app/acerciae-server --copy-media r2public local`.

For MinIO development, set S3 variables in `.env`, use `docker compose --profile s3 up`, create a private bucket and provision a bucket-scoped access key. The profile has a development-only fallback password; configure a strong `S3_SECRET_KEY` before using shared infrastructure. The local object-store path was integration-tested; Docker/MinIO were not run in this environment.
