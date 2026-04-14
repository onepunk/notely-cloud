import { copyFileSync, mkdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    {
      name: 'copy-security-files',
      closeBundle() {
        // Copy the security directory to dist-electron after build
        const securitySrc = path.resolve(__dirname, 'src/security');
        const securityDest = path.resolve(__dirname, 'dist-electron/security');

        try {
          mkdirSync(securityDest, { recursive: true });
          copyFileSync(
            path.join(securitySrc, 'license-public-key.pem'),
            path.join(securityDest, 'license-public-key.pem')
          );
          console.log('Copied security files to dist-electron/security');
        } catch (error) {
          console.error('Failed to copy security files:', error);
        }

        // Copy baseline-schema.sql into dist-electron/ so MigrationRunner
        // can find it at runtime. Vite bundles all TS into a single main.cjs,
        // so __dirname-relative paths that assumed the source tree layout
        // (migrations/ -> ../ -> storage/) no longer work. Placing the SQL
        // file next to main.cjs is the correct approach for bundled builds
        // and also works inside app.asar for packaged distributions.
        try {
          copyFileSync(
            path.resolve(__dirname, 'src/main/storage/baseline-schema.sql'),
            path.resolve(__dirname, 'dist-electron/baseline-schema.sql')
          );
          console.log('Copied baseline-schema.sql to dist-electron/');
        } catch (error) {
          console.error('Failed to copy baseline-schema.sql:', error);
        }
      },
    },
  ],
  resolve: {
    alias: { '@common': path.resolve(__dirname, 'src/common') },
    // CRITICAL: Use Node.js resolution conditions instead of browser
    // This prevents packages like 'ws' from resolving to their browser stubs
    conditions: ['node', 'import', 'require', 'default'],
    mainFields: ['module', 'main'],
  },
  // Explicitly configure for Node.js/Electron main process
  ssr: {
    target: 'node',
    noExternal: [],
  },
  // Disable deps optimizer for main process - we want raw Node.js modules
  optimizeDeps: {
    noDiscovery: true,
    include: [],
  },
  build: {
    // Explicitly target Node.js (Electron 39 uses Node 22)
    target: 'node20',
    lib: {
      entry: 'src/main/main.ts',
      formats: ['cjs'],
      fileName: 'main',
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
      external: [
        'electron',
        'better-sqlite3-multiple-ciphers',
        'keytar', // Keep external for migration code (not installed, import will fail and be caught)
        'winston',
        'winston-daily-rotate-file',
        'jsonwebtoken',
        'ws',
        'archiver',
        // Add all Node.js builtin modules to ensure proper externalization
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
    },
  },
});
