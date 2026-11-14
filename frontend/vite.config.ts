import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const apiTarget = process.env.ACERCIAE_API_TARGET || 'http://localhost:8080';

// The read-aloud worker's Kokoro packages bring ONNX Runtime, whose code names its WebAssembly files with
// `new URL(…, import.meta.url)`, so the build would copy them (21–27 MB each; Cloudflare Pages refuses any file over
// 25 MiB). They are never fetched from here: Transformers.js (v3 for kokoro-js, v4 for @uzen/kokoro-js) points ONNX
// Runtime at the same files on cdn.jsdelivr.net before it loads. So they are left out of the build.
const dropOnnxWasm = (): Plugin => ({
  name: 'drop-onnx-runtime-wasm',
  apply: 'build',
  generateBundle(_options, bundle) {
    for (const name of Object.keys(bundle)) if (/(^|\/)ort-wasm[^/]*\.wasm$/.test(name)) delete bundle[name];
  },
});

// Dev server proxies API + WebSocket traffic to the C++ backend so no CORS setup is needed.
export default defineConfig({
  plugins: [react(), dropOnnxWasm()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist', sourcemap: false,
    // The interactive-message engine (src/hypertext/client.ts → hypertext-worker.ts and the QuickJS WASM) is built as
    // its own entry until the card UI imports it; only cards with script handlers ever load it.
    rollupOptions: {
      input: { index: fileURLToPath(new URL('./index.html', import.meta.url)), hypertext: fileURLToPath(new URL('./src/hypertext/client.ts', import.meta.url)) },
      preserveEntrySignatures: 'exports-only',
    },
  },
  // The read-aloud worker (Kokoro) loads its model code in chunks.
  worker: { format: 'es', plugins: () => [dropOnnxWasm()] },
});
