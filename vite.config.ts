import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));
const api = `http://127.0.0.1:${process.env.PORT ?? 5174}`;

/** Studio (React). In development Vite serves it and proxies the API and the sandboxed preview. */
export default defineConfig({
  root: path.join(root, 'studio'),
  plugins: [react()],
  resolve: { alias: { '@shared': path.join(root, 'shared/src') } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.STUDIO_DEV_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/preview': { target: api, changeOrigin: false },
    },
  },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    outDir: path.join(root, 'dist/studio'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
