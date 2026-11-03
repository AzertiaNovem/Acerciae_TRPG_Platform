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

## On the device

The web client keeps media on the device in IndexedDB (`frontend/src/lib/assetCache.ts`; the native apps keep theirs in
`AssetDiskCache`): character avatars and portraits, poses, asset-library thumbnails, visual-novel backgrounds, standees
and voice clips, user avatars and atmosphere backgrounds.

**Keys.** The server stores the SHA-256 of every picture it keeps (`asset_versions.content_hash`, mirrored to
`media_assets.content_hash` for the current version; `users.avatar_hash`) and names it wherever the picture is
referenced (`content_hash` on media rows, `hash` on the character space's avatar, portrait and poses,
`avatar_asset_hash` on the character list, `character_avatar_hash` / `author_avatar_hash` on messages, `avatar_hash` on
the profile, `background_asset_hash` on visual-novel scenes and `asset_hash` on their placements, `hashes` on the
atmosphere state). A reference that carries a hash is cached by it: the same bytes are one entry however many assets,
versions or users show them, and a picture is downloaded again only when its hash changes or its entry expired. New
objects are hashed as they are written; an object stored before hashes existed is hashed the first time it is served
(read once, even when the browser is then sent to the public bucket); until then the entry is keyed by the URL without
its file token, so a renewed token never reloads anything either. Keys are scoped to the account and server.

**What is kept.** Only responses the server marks `immutable`: a named version (`?v=`) of something a player may see, an
atmosphere image, a player's voice clip. The current version of an asset and GM-private material (GM-only assets,
NPC art, the Keeper's voice clips) are never marked and never written to disk; they revalidate by ETag (304) instead.
Media that redirects to the public bucket is followed there and kept too: the bucket's objects are immutable, and its
CORS policy must allow the web app's origin (set on the R2 bucket or its custom domain in the Cloudflare dashboard);
without that the browser still shows the picture through the URL itself, only nothing is kept. Every API response carries
`Vary: Origin`, so a browser never reuses the answer to an `<img>` load (no CORS header) for a `fetch()` from the app.

**How long.** Each time an entry is shown its lifespan starts over: it lives until it has not been shown for 30 days
(`ASSET_CACHE_MAX_AGE_MS`) or the cache passes 768 MB (`ASSET_CACHE_MAX_BYTES`, least recently used first); files over
64 MB are not kept. A sweep runs once per session start. The cache stays across sign-out; when another account signs in
on the same browser it is emptied first. Personal settings show its size with a **Clear** button. Without IndexedDB
(private windows, blocked storage) or on any error the direct URL is used as before, so the cache is never required.

