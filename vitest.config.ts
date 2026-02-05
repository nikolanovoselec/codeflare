import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Version note: Root uses vitest ^3.x (required by @cloudflare/vitest-pool-workers
// for Workers runtime testing), while web-ui uses vitest ^1.x (compatible with
// vite-plugin-solid and @solidjs/testing-library). These are independent test
// suites with separate configs and separate node_modules installs.
export default defineWorkersConfig({
  test: {
    // Only run backend tests - web-ui tests are run separately with their own vitest config
    slowTestThreshold: 5000,
    include: ['src/**/*.test.ts'],
    exclude: ['web-ui/**', 'e2e/**'],
    poolOptions: {
      workers: {
        /**
         * Workers pool mock hoisting (TQ-ST3):
         * Tests run inside the Cloudflare Workers runtime via miniflare.
         * vi.mock() calls are hoisted to the top of the module by Vite's transform,
         * but the Workers pool evaluates modules differently from Node.js.
         *
         * IMPORTANT: Always place vi.mock() at module level BEFORE any imports
         * that depend on the mocked modules. vi.hoisted(() => ...) can be used
         * to define shared mutable state that vi.mock() factories reference.
         *
         * Example pattern:
         *   const testState = vi.hoisted(() => ({ container: null }));
         *   vi.mock('@cloudflare/containers', () => ({
         *     getContainer: vi.fn(() => testState.container),
         *   }));
         *   import { ... } from '../../routes/...';
         */
        miniflare: {
          bindings: { LOG_LEVEL: 'silent' },
          compatibilityFlags: [
            'enable_nodejs_tty_module',
            'enable_nodejs_fs_module',
            'enable_nodejs_http_modules',
            'enable_nodejs_perf_hooks_module',
          ],
        },
        wrangler: { configPath: './wrangler.toml' },
      },
    },

    // v8 coverage configuration (FIX-54)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.test.ts', 'src/**/*.generated.ts'],
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 50,
        lines: 50,
      },
    },
  },
});
