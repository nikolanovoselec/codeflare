import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { NODE_SUITE_FILES } from './vitest.node-suite.mjs';

export default defineConfig({
  plugins: [
    cloudflareTest({
      /**
       * Workers pool mock hoisting (TQ-ST3):
       * Tests run inside the Cloudflare Workers runtime via miniflare.
       * vi.mock() calls are hoisted to the top of the module by Vite's transform,
       * but the Workers pool evaluates modules differently from Node.js.
       *
       * IMPORTANT: Always place vi.mock() at module level BEFORE any imports
       * that depend on the mocked modules. vi.hoisted(() => ...) can be used
       * to define shared mutable state that vi.mock() factories reference.
       */
      miniflare: {
        bindings: { LOG_LEVEL: 'silent' },
        compatibilityFlags: [
          'enable_nodejs_tty_module',
          'enable_nodejs_fs_module',
          'enable_nodejs_http_modules',
          'enable_nodejs_perf_hooks_module',
          // Required by the Vitest runner — explicit so the pool doesn't
          // auto-inject (and log [vpw:debug] noise) on every test file.
          'enable_nodejs_v8_module',
          'enable_nodejs_process_v2',
        ],
      },
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
  test: {
    // Only run backend tests - web-ui tests are run separately with their own vitest config
    slowTestThreshold: 5000,
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['src/**/*.test.ts'],
    exclude: [
      'web-ui/**',
      // Pi-extension tests need node:child_process/node:fs and kill workerd at
      // collection — they run under plain Node via vitest.node.config.ts.
      ...NODE_SUITE_FILES,
    ],
    // Run the Workers pool across several workers. @cloudflare/vitest-pool-workers
    // crashes workerd at pool teardown ("Worker exited unexpectedly") AFTER every
    // test passes — the documented WebSockets + Durable Objects under per-file
    // storage-isolation limitation (known-issues#websockets). Serializing to one
    // worker never fixed that (the crash is a teardown, not a concurrency, bug);
    // it only cost wall clock, so the pool is parallel again and the crash stays
    // tolerated by the fingerprinted guard in scripts/ci/check-vitest-report.mjs
    // (which still fails on any real failure, and on any file collecting zero tests).
    // Cloudflare's other documented knob, --no-isolate, remains unusable: isolate:false
    // crashes workerd during *collection* (0 tests run) on pool-workers 0.16.14 AND
    // 0.16.16 — both verified in CI 2026-06-16 — so per-file isolation stays.
    //
    // Each worker is a full workerd + miniflare instance, so memory rather than
    // core count is the binding constraint: cap at 4 however large the runner is.
    maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),

    // Compact per-test output in CI (dots + summary); full reporter locally.
    // The deploy/test guards grep only the summary + pool-crash lines, which
    // the dot reporter still prints.
    reporters: process.env.CI ? ['dot'] : ['default'],

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
});
