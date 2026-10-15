import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Glazecalc's chemistry, copied in until it settles (docs/adr/0002-chemistry-copy.md).
const chemistry = fileURLToPath(new URL('./vendor/glazecalc/lib/chemistry/index.js', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@glazecalc/chemistry': chemistry } },
  // The chemistry is CommonJS. A build converts it anyway, but the dev server only converts what
  // it pre-bundles, and it pre-bundles only node_modules unless told otherwise.
  optimizeDeps: { include: ['@glazecalc/chemistry'] },
  // Tauri expects a fixed port, and prints its own output.
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // macOS 12's WebKit is Safari 15's.
    target: ['es2022', 'safari15'],
    outDir: 'dist'
  },
  test: {
    include: ['ui/**/*.test.ts', 'ui/**/*.test.tsx']
  }
});
