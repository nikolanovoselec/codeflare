import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import workersRuntimeTests from './scripts/workers-runtime-tests.json';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: { LOG_LEVEL: 'silent' },
        compatibilityFlags: [
          'enable_nodejs_tty_module',
          'enable_nodejs_fs_module',
          'enable_nodejs_http_modules',
          'enable_nodejs_perf_hooks_module',
          'enable_nodejs_v8_module',
          'enable_nodejs_process_v2',
        ],
      },
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
  test: {
    slowTestThreshold: 5000,
    testTimeout: 30000,
    hookTimeout: 30000,
    include: workersRuntimeTests,
    maxWorkers: 1,
  },
});
