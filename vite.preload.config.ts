import path from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: { '@common': path.resolve(__dirname, 'src/common') },
  },
  build: {
    lib: {
      entry: 'src/preload/index.ts',
      formats: ['cjs'],
      fileName: 'preload',
    },
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      mangle: {
        reserved: ['require', 'module', 'exports', '__dirname', '__filename'],
      },
      compress: {
        dead_code: true,
        passes: 2,
        drop_console: false,
      },
      format: {
        comments: false,
      },
    },
    outDir: 'dist-electron',
    emptyOutDir: false,
    rollupOptions: {
      external: ['electron'],
    },
  },
});
