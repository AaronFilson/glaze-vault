import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Glazecalc's chemistry core and catalog submodules (docs/adr/0002-chemistry-copy.md).
const core = fileURLToPath(new URL('./lib/core', import.meta.url));
const catalog = fileURLToPath(new URL('./lib/catalog', import.meta.url));

// Tests of plain functions that still need a page (`@vitest-environment jsdom`).
const JSDOM_LOGIC = ['ui/importFormats.test.ts', 'ui/export.test.ts'];

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@glazecalc/core': core, '@glazecalc/catalog': catalog } },
  // Tauri expects a fixed port, and prints its own output.
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // macOS 12's WebKit is Safari 15's.
    target: ['es2022', 'safari15'],
    outDir: 'dist',
    // The app loads its page from disk, not the network, and the materials library is most of it.
    chunkSizeWarningLimit: 2000
  },
  test: {
    setupFiles: ['ui/testSetup.ts'],
    projects: [
      // Plain functions, tested in Node, keep nothing between tests, so their files share workers
      // instead of each loading the chemistry again.
      {
        extends: true,
        test: { name: 'logic', include: ['ui/*.test.ts'], exclude: JSDOM_LOGIC, isolate: false }
      },
      // Screens each get a page and modules of their own: React, the fake core and the dev tools
      // keep state in them.
      {
        extends: true,
        test: { name: 'screens', include: ['ui/**/*.test.tsx', ...JSDOM_LOGIC] }
      }
    ]
  }
});
