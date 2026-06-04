import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

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
    exclude: ['web-ui/**', 'e2e/**'],
    // Serialize the Workers pool — @cloudflare/vitest-pool-workers spins one workerd
    // isolate per worker and parallel isolates flake harder at teardown.
    // DO NOT add `isolate: false` here: with pool-workers 0.16.x it crashes workerd
    // during collection ("Worker exited unexpectedly", 0 tests run) — verified in CI.
    // The teardown crash that survives (after all tests pass) is a known upstream flake,
    // tolerated by the "Run backend tests" guard in .github/workflows/test.yml.
    maxWorkers: 1,

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
