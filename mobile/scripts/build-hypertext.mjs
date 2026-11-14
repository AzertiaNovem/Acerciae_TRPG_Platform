// Builds the card engine for the mobile apps (mobile/hypertext/engine.ts → mobile/contracts/hypertext/). The QuickJS
// WASM is inlined as bytes, so the WebView never fetches it. The bundle is wrapped in a named function whose source
// the page turns into a blob: worker (mobile/hypertext/engine.ts), hence worker-src blob: in the page's CSP. --check
// rebuilds in memory and fails on any difference from the committed files, or when the bundle outgrows the fixture's
// engine.max_bundle_bytes.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(root, 'frontend/package.json'));
const { build } = require('esbuild');
const out = path.join(root, 'mobile/contracts/hypertext');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'mobile/contracts/fixtures/hypertext-client.json'), 'utf8')).engine;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const r = await build({
  entryPoints: [path.join(root, 'mobile/hypertext/engine.ts')], bundle: true, format: 'iife', target: ['safari17', 'chrome100'], minify: true,
  charset: 'utf8', loader: { '.wasm': 'binary' }, conditions: ['browser'], define: { 'import.meta.url': '"file:///hypertext-engine.js"' },
  legalComments: 'eof', nodePaths: [path.join(root, 'frontend/node_modules')], write: false, logLevel: 'warning',
});
const js = Buffer.from(`(function __hypertextBundle() {\n${r.outputFiles[0].text}})();\n`);
const wasm = fs.readFileSync(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'));
const files = {
  'hypertext-engine.js': js,
  'hypertext-engine.html': Buffer.from('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' file: \'wasm-unsafe-eval\'; worker-src blob:; base-uri \'none\'; form-action \'none\'"><meta http-equiv="x-dns-prefetch-control" content="off"><script src="hypertext-engine.js"></script>\n'),
  'hypertext-engine.sha256.json': Buffer.from(JSON.stringify({ wasm_sha256: sha256(wasm), bundle_sha256: sha256(js), bytes: js.length }, null, 2) + '\n'),
};
const problems = [];
if (sha256(wasm) !== fixture.wasm_sha256) problems.push(`the WASM is not the pinned build (sha256 ${sha256(wasm)})`);
if (js.length > fixture.max_bundle_bytes) problems.push(`hypertext-engine.js is ${js.length} bytes, over ${fixture.max_bundle_bytes}`);
if (process.argv.includes('--check')) {
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(out, name);
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) problems.push(`${name} is stale: run node mobile/scripts/build-hypertext.mjs`);
  }
} else if (!problems.length) {
  fs.mkdirSync(out, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(out, name), bytes);
}
if (problems.length) { for (const p of problems) console.error(p); process.exit(1); }
console.log(`hypertext-engine.js ${js.length} bytes${process.argv.includes('--check') ? ': up to date' : ''}`);
