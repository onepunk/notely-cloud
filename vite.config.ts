import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0'),
  },
  plugins: [
    react(),
    electron([
      {
        // Main process configuration
        entry: '../main/main.ts',
        vite: {
          plugins: [
            {
              name: 'copy-main-assets',
              closeBundle() {
                const distElectron = path.resolve(__dirname, 'dist-electron');
                mkdirSync(distElectron, { recursive: true });

                try {
                  copyFileSync(
                    path.resolve(__dirname, 'src/main/storage/baseline-schema.sql'),
                    path.join(distElectron, 'baseline-schema.sql')
                  );
                  console.log('Copied baseline-schema.sql to dist-electron/');
                } catch (error) {
                  console.error('Failed to copy baseline-schema.sql:', error);
                }

                try {
                  mkdirSync(path.join(distElectron, 'security'), { recursive: true });
                  copyFileSync(
                    path.resolve(__dirname, 'src/security/license-public-key.pem'),
                    path.join(distElectron, 'security/license-public-key.pem')
                  );
                  console.log('Copied security files to dist-electron/security');
                } catch (error) {
                  console.error('Failed to copy security files:', error);
                }
              },
            },
          ],
          build: {
            outDir: '../dist-electron',
            rollupOptions: {
              external: [
                'electron',
                'better-sqlite3-multiple-ciphers',
                'keytar', // Keep external for migration code (not installed, import will fail)
                'winston',
                'winston-daily-rotate-file',
                'node:fs',
                'node:path',
                'node:crypto',
                'node:child_process',
                'node:http',
                'node:net',
                'node:os',
              ],
            },
          },
        },
      },
      {
        // Preload script configuration
        entry: '../preload/index.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: '../dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
  ],
  root: 'src/renderer',
  publicDir: 'public', // Explicitly enable public directory (vite-plugin-electron disables it by default)
  resolve: {
    alias: {
      '@common': path.resolve(__dirname, 'src/common'),
      '@shared': path.resolve(__dirname, 'src/renderer/shared'),
      '@features': path.resolve(__dirname, 'src/renderer/features'),
      '@app': path.resolve(__dirname, 'src/renderer/app'),
    },
  },
  css: { modules: { localsConvention: 'camelCase' } },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      mangle: true,
      compress: {
        dead_code: true,
        passes: 2,
        drop_console: false,
      },
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/renderer/index.html'),
        meetingReminder: path.resolve(__dirname, 'src/renderer/meeting-reminder.html'),
        auth: path.resolve(__dirname, 'src/renderer/auth.html'),
        passwordUnlock: path.resolve(__dirname, 'src/renderer/passwordUnlock.html'),
      },
    },
  },
  server: {
    port: 5173,
    watch: {
      // Ignore node_modules to reduce file watcher usage
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/dist-electron/**',
        '**/.venv/**',
        '**/pytorch_env/**',
      ],
    },
  },
});
