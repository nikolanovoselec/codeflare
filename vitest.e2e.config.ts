import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./e2e/global-setup.ts'],
    include: ['e2e/**/*.test.ts'],
    testTimeout: 120000, // E2E tests may be slow (2 minute default — session creation + KV propagation)
    hookTimeout: 120000,
    // Run test files sequentially — E2E tests share live deployment state
    // (setup-wizard tests reset setup:complete, which affects all other tests)
    fileParallelism: false,
    // Sequence tests for predictable rate limiting behavior
    sequence: {
      shuffle: false,
    },
  },
});
