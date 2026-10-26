# PDF publication

C++ owns access checks, snapshots, template validation, render jobs and published artifacts. The separate Node worker receives only a prefiltered frozen render payload. It cannot query arbitrary campaign data or execute user JavaScript. `src/template.mjs` generates escaped HTML and controlled paged CSS; `src/render.mjs` invokes Vivliostyle CLI without a shell. Images are bounded raster data URIs; scripts and external resources are denied by CSP. Temporary render directories are removed after each attempt.

## Templates and configuration

Classic Log emphasizes colored speakers and dice. Investigation Dossier (`dossier`) uses archive-paper colors and ruled entries. Novel uses a centered chapter opening and script-like dialogue spacing. This Novel template is for PDF typography; it does not generate a visual-novel performance.

The controlled config supports `base`, `page_size` (A4/A5/B5), `orientation`, `font` (licensed system Noto serif/sans), `font_size` (8–24 pt), `line_height` (1–2.5), `margin_mm` (8–40), `title`, `subtitle`, `header`, `footer`, `include_ooc`, `timestamps`, `toc`, `page_numbers`, `chapter_breaks`, `dice_style` (box/inline/hide), `character_colors` (speaker key → #RRGGBB), `cover_asset_id`, and `scene_images` (scene key → approved asset ID). Arbitrary HTML, JS, CSS and remote URLs are not template inputs. Config examples are in `examples/logstudio/pdf-*.json`.

A render request can select `appendix_document_ids`. C++ reuses document permissions under the snapshot's audience, copies only confirmed/resolved entries with source event references, and freezes document versions. Public-player snapshots cannot include the GM module document, even when requested by a GM. Later memory updates do not silently update an existing PDF.

The editor previews the actual completed PDF through a lazy-loaded PDF.js renderer and downloads that same artifact. It does not rely on the browser PDF plugin. Preview pages are rendered one at a time with text access and previous/next controls. Output has selectable/searchable text, a linked contents page, page counters, section breaks, widow/orphan rules and embedded CJK fonts. Layout is best-effort for very long unbreakable content. The Docker image installs `fonts-noto-cjk`; on macOS install Noto CJK or use the operating system's Chinese fallback fonts.

## Worker operations

Generate a secret with `openssl rand -hex 32` and set the same `PDF_WORKER_TOKEN` on backend and worker. The worker claims through `POST /api/internal/pdf/claim` with `X-Worker-Token`. A claim returns a five-minute lease. Completion uses `/api/internal/pdf/{id}/finish`, `X-Worker-Lease` and PDF bytes. A stale lease cannot overwrite a newer result. Claims use PostgreSQL `FOR UPDATE SKIP LOCKED`; identical payloads reuse jobs. Each worker renders one job at a time; run more workers for bounded parallelism. Failed renders retry at most twice. Expired leases recover on the next claim.

```bash
npm --prefix pdf-worker ci
API_BASE=http://127.0.0.1:8080 PDF_WORKER_TOKEN="$PDF_WORKER_TOKEN" \
  CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  node pdf-worker/src/index.mjs
```

`CHROMIUM_PATH` is optional when Vivliostyle has a managed browser installed. PDF files are validated by signature and capped at 60 MB. The complete payload is capped at 32 MB, each inline image at 10 MB. Use smaller snapshots for larger books. Rendering engine timestamps may differ between fresh builds; downloading a completed job returns exactly the same stored bytes.

Real local Vivliostyle rendering of all three templates was tested, including Chinese text extraction and page inspection. Docker container startup remains unverified because Docker was unavailable. There is no FFmpeg export/video encoding job; the existing player consumes WAV audio and original raster media directly.
