import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const backend = 'http://localhost:8080';

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'web/index.html'),
        board: resolve(import.meta.dirname, 'web/board.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/m': backend,
      '/ws': { target: backend, ws: true },
    },
  },
});
