#!/usr/bin/env node
// Puts a static FFmpeg for one target at src-tauri/binaries/ffmpeg-<target>[.exe], where Tauri bundles it next to
// the app (tauri.ffmpeg.conf.json). Used by CI; the app falls back to an FFmpeg on PATH when none is bundled.
//   node scripts/fetch-ffmpeg.mjs <rust target triple>
// Override a source with FFMPEG_URL=<url of a .zip or .tar.xz holding an ffmpeg executable>.
// These builds are GPL (they include x264): ship the FFmpeg licence with installers that bundle them.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const target = process.argv[2];
const sources = {
  'x86_64-unknown-linux-gnu': 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
  'aarch64-unknown-linux-gnu': 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz',
  'x86_64-pc-windows-msvc': 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  // An Intel build; Apple silicon Macs run it through Rosetta. Override FFMPEG_URL with a native arm64 build if wanted.
  'x86_64-apple-darwin': 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
  'aarch64-apple-darwin': 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
};
const url = process.env.FFMPEG_URL || sources[target];
if (!url) { console.error(`no FFmpeg source for ${target}`); process.exit(1); }
const exe = target.includes('windows') ? 'ffmpeg.exe' : 'ffmpeg';
const work = mkdtempSync(join(tmpdir(), 'ffmpeg-'));
const archive = join(work, url.endsWith('.tar.xz') ? 'a.tar.xz' : 'a.zip');
console.log(`fetching ${url}`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) { console.error(`download failed: HTTP ${res.status}`); process.exit(1); }
writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
// bsdtar (macOS, Windows) reads zip and tar.xz; GNU tar (Linux) reads tar.xz, unzip reads zip.
if (archive.endsWith('.zip') && process.platform === 'linux') execFileSync('unzip', ['-q', archive, '-d', work]);
else execFileSync('tar', ['-xf', archive, '-C', work]);
const find = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { const f = find(p); if (f) return f; } else if (n === exe) return p; } return null; };
const found = find(work);
if (!found) { console.error(`no ${exe} in the archive`); process.exit(1); }
const outDir = join(import.meta.dirname, '..', 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `ffmpeg-${target}${target.includes('windows') ? '.exe' : ''}`);
copyFileSync(found, out); chmodSync(out, 0o755);
console.log(`bundling ${out} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
if (!existsSync(out)) process.exit(1);
