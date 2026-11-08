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
check membership, GM-only visibility and approval exactly as before, then answer with a `302` to the public URL
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
NPC art, the GM's voice clips) are never marked and never written to disk; they revalidate by ETag (304) instead.
Media in the public bucket is kept too, fetched straight from the bucket. The cache asks the API with `?direct=1`
(avatars, media assets, voice clips): instead of the redirect, the API answers `{url, keep}` as
`application/vnd.acerciae.direct+json`, and the client fetches `url` itself. Following the redirect would not work: a
request already cross-origin (app → API) that is redirected to a third origin (the bucket) is sent with `Origin: null`,
by the Fetch standard, in every browser, and no CORS policy naming the site matches that. Fetched from the page, the
request carries the page's own origin, so the bucket's CORS policy must allow the web app's origin (and the desktop
app's, `tauri://localhost` and `https://tauri.localhost`), set on the R2 bucket or its custom domain in the Cloudflare
dashboard. The fetch skips the browser's HTTP cache (`cache: 'no-store'`): an `<img>` load may have left a copy there
without CORS headers. `keep` is the API's own decision (a named version of something a player may see), because the
bucket marks every object immutable, GM-private ones included. When the bucket refuses the origin, the picture is still
shown through the API URL, only not kept. Every API response carries `Vary: Origin`, so a browser never reuses the
answer to an `<img>` load (no CORS header) for a `fetch()` from the app.

**How long.** Each time an entry is shown its lifespan starts over: it lives until it has not been shown for 30 days
(`ASSET_CACHE_MAX_AGE_MS`) or the cache passes 768 MB (`ASSET_CACHE_MAX_BYTES`, least recently used first); files over
64 MB are not kept. A sweep runs once per session start. The cache stays across sign-out; when another account signs in
on the same browser it is emptied first. Personal settings show its size with a **Clear** button. Without IndexedDB
(private windows, blocked storage) or on any error the direct URL is used as before, so the cache is never required.



## Illustrations in chat

**Illustrate** in the chat composer (shown when the server has an image provider and illustrations are on) lets any
member who may post in the window draw a moment of the story: they pick up to six characters as visual references
(players: player characters; the GM: NPCs too), describe the pose, action, place and light, and choose landscape,
portrait or square.

- **The prompt** (`chat/Illustrations.cpp`, `illustrationPrompt`) keeps the requester's description and adds the
  platform's direction: each named character with their appearance description, the channel's era and the current
  story time, and a composition note that asks the image model to dare an unexpected, cinematic viewpoint (low or
  high angle, over the shoulder or from behind, a wide shot, a close-up, a tilted frame, strong depth) instead of a
  plain front view, while keeping every character recognisable. No text or watermarks. The channel's default style
  profile applies, as for character art.
- **References**: each chosen character's main portrait (else avatar), when approved and PNG, JPEG or WebP, is frozen
  as an identity reference (20 MB in all); a character without one is drawn from the description. The image files
  carry no names, so the model learns which is whom from the text, said three times with the same numbering: each
  character line of the prompt ("(identity reference image 1 attached)"), the identity instruction ("Reference image
  1 is Ada. Mo has no reference image: follow the description. … never swap or blend two characters";
  `illustrationIdentity`), and each entry of the request's `characters` (`reference_image: 1` or `"none"`). Image
  models can still mix up look-alike characters; distinctive appearance descriptions help most.
- **Limits**: the server's image provider, budget and concurrency apply (`asset_generation_jobs.kind =
  'illustration'`); one illustration in flight per person and channel, 20 an hour. Like character art, it does not
  need the Log Studio's cloud switch; the requester confirms that the description and portraits go to the image
  service.
- **Posting**: when the picture is stored (`media_assets.asset_type = 'illustration'`, approved, GM-scoped so it is
  not listed in the players' media library), it is posted in the window as the requester's `ooc` line with
  `messages.media_asset_id`, with the requester's rights at that moment: a window they left gets no line, and the
  job keeps `error` "drawn, but not posted". `GET …/messages/{mid}/image` serves the picture only to those who may
  read the line (whispers and private windows stay private; spectators get no picture). The picture's object is AI
  art and lives in the public bucket under an unguessable key, as other generated art does.
- **Optional, on by default**: the server's maintainers switch illustrations for the whole server (Server settings →
  Features → Illustrations, `features.illustrations`), and the GM for their channel under it (GM workspace → AI in this
  channel → Illustrations, `illustrations_enabled`; greyed out while the server has it off). Off hides the button and
  the server refuses new drawings with 403 `feature_disabled`, the GM and the GM agent included; pictures already
  posted stay, as do the job list and cancelling. The mobile apps carry both switches in their server and GM settings.
- **Saving a picture**: the web app shows **Download** under each picture: a browser downloads it (the server names
  the file `illustration-<date>-<description>.png`), and the desktop app asks where with its own "Save as". On
  Android, **Save** in the full-screen picture opens the system's file picker (no storage permission). On iOS it opens
  the share sheet ("Save Image" to Photos, "Save to Files", AirDrop); the app declares
  `NSPhotoLibraryAddUsageDescription` for that. Both apps save the original bytes from their disk cache under the
  same kind of name, without the date.

## Outfits

A character whose look is **generated** can have up to eight outfits (`character_outfits`): a name ("Ball gown") and
what they wear. Each outfit gets its own portrait, avatar and poses (standees by subtitle), so the same person can
change clothes without losing their face:

- **Drawn from the base look.** The outfit's portrait is generated with the character's main portrait as the identity
  reference and an instruction to dress them in the outfit instead of the clothes in the reference
  (`CreativeService::createForCharacter` with an outfit; the prompt is the appearance plus "Outfit (replaces any
  clothing described above): …", `outfits::appearance`). The outfit's avatar and poses are then drawn from the
  outfit's own portrait (the one queued in the same request, or the one it has), like the base poses are from the main
  portrait. The character page's **Outfits** section (Appearance & images) adds, edits, generates, wears and deletes
  them; the GM and the character's player manage them.
- **Worn now.** `characters.outfit_id` is the outfit the character wears (none: the base look), switched on the
  character page (web: **Wearing** in its header; Android and iOS: **Wearing** in the character page's look section).
  The character list and `character.updated` events then report the outfit's avatar as `avatar_asset_id` (the base
  one as `base_avatar_asset_id`), with `outfit_name` and every character's `outfits[{id, name}]`, so every client
  shows the worn avatar without knowing about outfits.
- **Each line remembers.** A character's line records the outfit worn as it is written (`messages.outfit_id`) and
  shows that outfit's avatar ever after; lines from before an outfit change keep their look.
- **Visual novels.** A stage placement may name an outfit (`outfit_id`, `""` = the base look). When no editor chose
  one, the presentation reader fills in the outfit the character wore in their own nearest line (the latest at or
  before the event, else their next one), marked `outfit_auto` and never stored, so a VN shows every line in the
  clothes worn when it was written. An outfit placement shows the outfit's image for the subtitle, else its portrait
  (the same clothes beat the right pose); only an outfit without any image falls back to the base look. The VN
  editor's stage controls offer **As written**, **Base look** or any outfit, and `character_outfits` lists each
  character's outfits with the subtitles they have images for. Hybrid VNs use an outfit's own pose when it has one.
  Presentations made before outfits existed are unchanged: their lines carry no outfit.
- **Illustrations** draw each character in the outfit they wear unless the request picks another
  (`outfits: {character_id: outfit_id | ""}`; the Illustrate dialog shows the choice for characters that have
  outfits). The reference is the outfit's portrait (else its avatar); an outfit without images sends the base
  portrait for the face only, and the prompt says what they wear instead.
- **Images and deletion.** An outfit's images carry `media_assets.outfit_id`: they never stand in for the base
  look's (the VN's library fallback skips them), a newer one replaces the older in its slot
  (`MediaService::adoptOutfitImage`), and storage cleanup keeps those an outfit uses. Deleting an outfit deletes its
  images (one a live publication still shows is marked superseded until the publication is revoked); a character
  wearing it goes back to the base look, and lines written in it show the base look.

## Image references and object inventory

Image-generation jobs store reference asset IDs, versions, SHA-256 hashes and private snapshot keys. The image
bytes live under `channels/<channel>/image-references/<sha256>.png` in IMAGE_STORE. The extension is a routing
marker; the recorded MIME type describes the actual bytes. Identical reference bytes within a channel share one
snapshot. A snapshot survives replacement or deletion of its original portrait. The worker verifies its hash and
builds the provider's Base64 payload in memory when needed.

On startup, the media migrator converts old inline references one job at a time. It stores the snapshot before
replacing the JSON, skips running jobs and uses a compare-and-swap update. Workers also convert legacy references
when claiming a job. Failed uploads keep the old JSON for retry. `MEDIA_MIGRATION=false` disables the startup pass.

Storage cleanup expires completed image jobs after `RETENTION_IMAGE_JOB_DAYS` (default 30, 1–3650). A job still
named as a portrait dependency stays. Failed, pending and running jobs stay. Once no job uses a snapshot, the normal
orphan sweep can remove it after its protection period. Cleanup rechecks live references and a database-backed lease
under a row lock, so a new queued request can safely reuse an older snapshot. `STORAGE_CLEANUP=false` disables this
maintenance. Removing job rows does not remove their generated media assets.

Cached voice lines (`tts_audio_assets`) record `last_used_at`, refreshed when the cache serves a line and when a line is
played (at most once an hour). Cleanup deletes a line, row and object, once no presentation event points at it, no live
publication's frozen audio names it or its object, no voice job of its channel is pending or running, and it has gone
unused for `RETENTION_VOICE_AUDIO_DAYS` (default 30, 1–3650). Each delete re-checks those conditions in the same
statement, so a line taken back into use meanwhile stays.

`stored_objects` records each physical bucket/key separately with SHA-256, size, MIME when known, owner kind/ID,
verification time and bounded provenance receipts. Normal puts register the object and successful deletes remove
its record. Startup migration and daily cleanup reconcile configured buckets, including legacy files and external
removals. Existing verified immutable objects are not downloaded again unless size or modification time changed.
`stored_object_claims` exposes the current media/version, avatar, TTS, import, PDF, bundle, publication and image-job links.
Unknown owners are explicitly `unclaimed`. Inventory records are not authorization grants or GC pins. A completed
task can expire while a media object's independent ownership receipt remains. All-bucket reconciliation requires
List/Get permissions on the configured backends; failures are logged and retried on the next pass.

Reference snapshots are included in storage totals, copy-media operations and channel deletion. After conversion,
PostgreSQL can reuse the released table space. Returning the existing table's allocated disk space to the OS requires
separate database compaction; the background migration does not take an exclusive table-rewrite lock.
