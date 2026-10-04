import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * The trusted game runtime: one classic script (IIFE), one stylesheet and the
 * bundled font as a real file (no data: URLs, so a strict CSP can apply).
 * Used by the sandboxed studio preview and copied into exports.
 */
export default defineConfig({
  base: './',
  resolve: { alias: { '@shared': path.join(root, 'shared/src') } },
  publicDir: false,
  build: {
    outDir: path.join(root, 'dist/runtime'),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: path.join(root, 'runtime/src/main.ts'),
      output: {
        format: 'iife',
        entryFileNames: 'runtime.js',
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? '';
          if (/\.(woff2?|ttf)$/.test(name)) return 'fonts/[name][extname]';
          if (name.endsWith('.css')) return 'runtime.css';
          return '[name][extname]';
        },
      },
    },
  },
});
