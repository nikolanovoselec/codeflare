import { defineConfig } from 'vitest/config';
import { NODE_SUITE_FILES } from './vitest.node-suite.mjs';

// The backend test files that run under plain Node, NOT the Workers pool.
//
// They exercise preseed/agents/pi/extensions logic, the generated seed data, and
// the CI gate scripts with node:child_process (spawning git and node), node:fs
// temp trees, and process.env — none of which exist inside workerd. Under
// @cloudflare/vitest-pool-workers the pool died loading each file and vitest
// reported the file as "passed" with ZERO tests: seven files were silently
// dead in CI while runs stayed green (the fail-open the backend gate's
// zero-test check now rejects). vitest.node-suite.mjs is the one list; the
// Workers config excludes exactly it, so each file runs in exactly one runtime.
export default defineConfig({
  test: {
    environment: 'node',
    // Pinned, not inherited: suite-gates spawns git and node, pi-memory-inject
    // calls process.chdir, and both throw ERR_WORKER_UNSUPPORTED_OPERATION
    // under the threads pool. Forks is vitest's current default, so relying on
    // it would make a pool switch or a major bump an opaque suite failure.
    pool: 'forks',
    include: [...NODE_SUITE_FILES],
    slowTestThreshold: 5000,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Compact per-test output in CI (dots + summary); full reporter locally.
    reporters: process.env.CI ? ['dot'] : ['default'],
  },
});
