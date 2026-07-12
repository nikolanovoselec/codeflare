/// <reference types="vitest" />
import { getViteConfig } from 'astro/config';

// getViteConfig loads astro.config.mjs so .astro components compile inside
// vitest — required by the Container API render tests.
export default getViteConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // Compact per-test output in CI (dots + summary); full reporter locally.
    reporters: process.env.CI ? ['dot'] : ['default'],
  },
});
