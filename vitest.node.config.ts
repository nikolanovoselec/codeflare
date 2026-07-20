import { defineConfig } from 'vitest/config';

// Pi-extension test files run under plain Node, NOT the Workers pool.
//
// These tests exercise preseed/agents/pi/extensions logic and the generated
// seed data with node:child_process (spawning git), node:fs temp trees, and
// process.env — none of which exist inside workerd. Under
// @cloudflare/vitest-pool-workers the pool died loading each file and vitest
// reported the file as "passed" with ZERO tests: seven files were silently
// dead in CI while runs stayed green (the fail-open the backend gate's
// zero-test check now rejects). The same files are excluded from
// vitest.config.ts so each runs in exactly one runtime.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/__tests__/lib/agent-seed-multi-agent.test.ts',
      'src/__tests__/lib/local-statusline-repo.test.ts',
      'src/__tests__/lib/pi-memory-vault-delivery.test.ts',
      'src/__tests__/lib/review-enforcement.test.ts',
      'src/__tests__/lib/pi-review-scope.test.ts',
      'src/__tests__/lib/review-helpers.test.ts',
      'src/__tests__/lib/vault-manifest-detection.test.ts',
    ],
    slowTestThreshold: 5000,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Compact per-test output in CI (dots + summary); full reporter locally.
    reporters: process.env.CI ? ['dot'] : ['default'],
  },
});
