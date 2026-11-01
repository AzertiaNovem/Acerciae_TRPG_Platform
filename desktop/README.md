# Acerciae desktop

The desktop app is the web app's own frontend (`frontend/`) in a [Tauri 2](https://tauri.app) shell. It runs in the
system's web view (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux), with no bundled Chromium. Every
feature of the web app is the same code, so the desktop and web versions match. The server is the same C++ API the
web and mobile apps use.

## What only the desktop app does

- **Server address** on the sign-in screen (default `https://trpg.missazertia.com`). It is remembered per device.
- **The sign-in stays in the system keychain** (macOS Keychain, Windows Credential Manager, Secret Service on Linux;
  a file only you can read where there is none), not in the web view's storage. A sign-in saved by an earlier version
  moves there at the next start. Signing out removes it.
- **Native downloads.** Log exports, PDFs and visual-novel zips are saved through a "Save as" dialog. Other links
  (shared publications, external pages) open in the user's browser; the app window only shows the app.
- **A visual novel saved file by file.** "Save files to a folder" writes `index.html` (the standalone player),
  `script.json`, every image and every voice line into a folder, downloading four at a time. Image paths carry the
  asset version and files already there with the same size are skipped, so saving again only fetches what changed.
  Files come from `GET /api/channels/{c}/studio/presentations/{p}/files`.
- **A visual novel as a video.** "Export video…" draws each line once (background, standees in the template's
  framing, the text box and name tag, scene title cards). Each picture is held for its line's duration: the voice
  line plus a pause, or a reading time. FFmpeg then encodes the video with the voice lines on the soundtrack:
  - *Lossless (MKV)*: H.264 RGB at QP 0 with FLAC. Pictures are bit-exact, and each still is stored once however
    long it lasts, so the file stays small. Plays in VLC, mpv, IINA and similar players.
  - *Compatible (MP4)*: H.264 4:2:0 at CRF 14 with AAC, 30 fps. Plays everywhere (browsers, QuickTime, phones).
  1080p or 720p. FFmpeg is bundled with the installers when CI could fetch it; otherwise the app uses `ffmpeg` on
  PATH and says so when it is missing.
- **System notifications.** When the app is in the background, a message posted in a window you joined (in the
  channel you have open) becomes a system notification, and the taskbar or Dock icon asks for attention. In front,
  the in-app banners show instead. Both follow the "Show message notifications" setting.

## Open Log Studio (local, no account)

The Log Studio on your own computer, for logs from anywhere. Open it from the sign-in screen ("Open Log Studio") or
the ✎ button in the server bar. Projects live in the app's data folder (`projects/<id>/project.json` plus `assets/`);
nothing goes through the Acerciae server.

- **Import:**
  - SealDice text (`Name(12345) 2026/10/02 21:41:06` headers) and JSON, QQ chat exports, story-painter rendered
    text, and Acerciae exports (native 2.0 and 1.0).
  - Several files of one campaign are joined in time order, and the lines where they overlap are dropped once.
  - Platform ids (QQ numbers) are dropped everywhere, including the kept source text.
  - UTF-8, UTF-16 and GBK/GB18030 files are read.
- **Supplement:**
  - The background: era, special settings, summary.
  - Who each speaker is: role, and which character they are.
  - Each character's appearance prompt, avatar, main portrait, poses (SAY, ANGRY, …) and voice.
  - Art is uploaded, or generated from the appearance prompt with your image service. Poses use the main portrait
    as the identity reference.
- **Export:**
  - Log files: the Acerciae log (JSON 2.0), SealDice text, plain text.
  - A styled HTML page saved as a folder with its pictures.
  - A PDF: the print-ready book opens in its own window with the system print dialog. On Linux the paper size is the
    one chosen in the dialog's Page Setup.
  - A visual novel:
    - The script is composed by rules (free, offline) or by your language model.
    - Your image service can paint the backgrounds and poses it asks for, and your speech service voices the lines.
    - It plays in the app, with the same look templates as the server.
    - It saves as a player folder or as a lossless MKV / compatible MP4 video.
    - **Continue the story.** Once a project has a visual novel, logs added in Overview ("Add a supplement log…")
      are placed after its last line instead of being re-merged, so every line keeps its number, the voice lines
      stay, and lines the project already holds are dropped. Lines dated earlier than the project's end still go
      at the end. **Continue the story (n new lines)** then writes only the new lines as scenes after the old ones.
      The writer is told the scene the story ended on, with its last lines, and is asked to reuse the novel's
      backgrounds and the characters' poses by name. It asks for art only for new places and poses. The first new
      scene joins the last old one when it keeps the same background. A project without a visual novel joins added
      logs in time order, as before.
- **AI services**, with your own keys, which are kept in the system keychain (or a user-only file where there is
  none):
  - Language model: OpenAI or any OpenAI-compatible address, or Anthropic.
  - Images: OpenAI `gpt-image-*` or a compatible service.
  - Speech: OpenAI or Qwen (DashScope).
  - Requests go from this computer straight to the provider.

## Develop

Requires Node 22+, Rust (stable) and, on Linux, `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
libxdo-dev libssl-dev`.

```sh
npm ci --prefix frontend
cd desktop && npm ci
npm run dev          # the Vite dev server inside the app window (hot reload)
npm run build        # installers for this OS under src-tauri/target/release/bundle/
cargo test --manifest-path src-tauri/Cargo.toml   # downloads and video encoding (needs ffmpeg on PATH)
```

To bundle FFmpeg in a local build: `node scripts/fetch-ffmpeg.mjs <rust target>` and then
`npx tauri build --config src-tauri/tauri.ffmpeg.conf.json`. The FFmpeg builds it fetches are GPL; include the FFmpeg
licence when you distribute installers that contain it.

## Release

`.github/workflows/desktop.yml` builds macOS (Apple silicon and Intel), Windows and Linux installers on every push
to `main` that touches `desktop/` or `frontend/`, and uploads them as workflow artifacts. Pushing a tag
`desktop-v0.1.0` also attaches them to a draft GitHub release. Without signing secrets the macOS app is ad-hoc signed
(`bundle.macOS.signingIdentity: "-"`). A downloaded app with no signature at all, or with only the linker's signature
on the executable, is reported as "damaged and can't be opened" on Apple silicon; an ad-hoc signed one only asks to
confirm the first launch: open it once, then System Settings → Privacy & Security → "Open Anyway". Builds from before
this change can be opened after `xattr -dr com.apple.quarantine /Applications/Acerciae.app`. Windows SmartScreen shows
a warning for unsigned installers. To sign properly, add the `APPLE_*` secrets listed in the workflow (Developer ID
certificate, `APPLE_SIGNING_IDENTITY`, and notarization; the identity secret replaces the ad-hoc `-`) and a Windows
code-signing certificate.

## Server requirements

The API accepts the desktop app's origins (`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`)
in addition to `CORS_ORIGINS`. Servers older than this change refuse its requests until they are redeployed.
