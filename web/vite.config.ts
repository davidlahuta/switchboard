import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../src/shared', import.meta.url));
const daemon = process.env.SWITCHBOARD_URL ?? 'http://127.0.0.1:4477';
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: { '@shared': shared },
  },
  server: {
    port,
    strictPort: Boolean(process.env.PORT),
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
    proxy: {
      '/api': { target: daemon, changeOrigin: false },
      '/ws': { target: daemon, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 700,
  },
});
