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
    // Cloudflare's documented configuration for WebSockets + Durable Objects under
    // the Workers pool is `--max-workers=1 --no-isolate` (shared storage). Per-file
    // storage isolation is explicitly unsupported with WS+DO and is what crashes
    // workerd at pool teardown ("Worker exited unexpectedly" after all tests pass).
    // See https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#websockets
    // isolate:false crashed collection on pool-workers 0.16.14; retrying on 0.16.16
    // (newer bundled miniflare). pool-workers `isolatedStorage` (default on) still
    // stacks per-test storage, so this shares the worker, not necessarily test state.
    maxWorkers: 1,
    isolate: false,

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
