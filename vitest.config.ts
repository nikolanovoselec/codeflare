import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import workersRuntimeTests from './scripts/workers-runtime-tests.json';

export default defineConfig({
  test: {
    slowTestThreshold: 5000,
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['src/**/*.test.ts'],
    exclude: ['web-ui/**', 'e2e/**', ...workersRuntimeTests],

    // v8 coverage configuration (FIX-54)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.test.ts', 'src/**/*.generated.ts'],
      thresholds: {
        statements: 53,
        branches: 43,
        functions: 53,
        lines: 53,
      },
    },
  },
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./src/__tests__/helpers/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
});
