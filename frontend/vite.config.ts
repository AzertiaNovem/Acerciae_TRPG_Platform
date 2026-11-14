import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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
  // The interactive-message engine (src/hypertext/client.ts starts hypertext-worker.ts, which loads the QuickJS WASM) is
  // emitted as the worker's own chunk and asset; only cards with script handlers ever load them.
  build: { outDir: 'dist', sourcemap: false },
  // The read-aloud worker (Kokoro) loads its model code in chunks.
  worker: { format: 'es', plugins: () => [dropOnnxWasm()] },
});
