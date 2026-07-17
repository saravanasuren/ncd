import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its source so tests need no build step.
      '@new-wealth/shared': fileURLToPath(
        new URL('../packages/shared/src/index.ts', import.meta.url)
      ),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Heavy integration beforeAll hooks (multi-step approval flows over HTTP +
    // PGlite) can run long when many test files spin servers in parallel.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
