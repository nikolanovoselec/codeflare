import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    // Compact per-test output in CI (dots + summary); full reporter locally.
    reporters: process.env.CI ? ['dot'] : ['default'],
    server: {
      deps: {
        inline: [/@solidjs\/router/],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Emit the report even when tests fail. Vitest skips report generation on
      // failure by default, so the coverage lane's "was a table produced?" check
      // fired first and blamed a missing report for what was actually a failing
      // test - and its explicit test-failure branch never ran.
      reportOnFailure: true,
      include: ['src/**/*.{ts,tsx}'],
      // Administration material-state UI is user-validated on Integration by contract;
      // backend behavior remains covered in Worker suites without source-copy UI tests.
      exclude: [
        'src/__tests__/**',
        'src/index.tsx',
        'src/components/admin/AnalyticsPage.tsx',
        'src/components/admin/AnalyticsUserDetail.tsx',
        'src/components/admin/ReportsPage.tsx',
        'src/components/admin/ActivityPage.tsx',
      ],
      // Measured 2026-07-20 (run 29725141008), the first run that ever executed
      // them: 77.44 statements / 65.99 branches / 77.09 functions / 79.66 lines.
      // The old 32/27 were never run and sat ~45 points below actual, so they
      // would have passed a suite with most of its tests deleted. Set ~2 points
      // under measured.
      thresholds: {
        statements: 75,
        branches: 63,
        functions: 75,
        lines: 77,
      },
    },
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
});
