import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./e2e/global-setup.ts'],
    include: ['e2e/**/*.test.ts'],
    testTimeout: 60000, // E2E tests may be slow (1 minute default)
    hookTimeout: 60000,
    // Run test files sequentially — E2E tests share live deployment state
    // (setup-wizard tests reset setup:complete, which affects all other tests)
    fileParallelism: false,
    // Sequence tests for predictable rate limiting behavior
    sequence: {
      shuffle: false,
    },
  },
});
