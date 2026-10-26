import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API + WebSocket traffic to the C++ backend so no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
