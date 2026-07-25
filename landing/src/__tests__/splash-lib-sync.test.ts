/**
 * Splash-cursor vendored-library drift guard (DEAD-001) — landing-side mirror
 * of web-ui/src/__tests__/lib/splash-lib-sync.test.ts. Both packages carry the
 * guard because CI path filters can run either package's shard alone; whichever
 * side edits its vendored copy trips its own shard's guard. If this test fails,
 * port the change to the other package's copy instead of forking.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHARED_SPLASH_FILES = [
  'webgl-utils.ts',
  'splash-shaders.ts',
  'splash-math.ts',
  'splash-cursor-logic.ts',
];

const LANDING_LIB = resolve(process.cwd(), 'src/lib');
const WEB_UI_LIB = resolve(process.cwd(), '../web-ui/src/lib');

describe('splash-cursor vendored library stays in sync between landing and web-ui (DEAD-001)', () => {
  for (const file of SHARED_SPLASH_FILES) {
    it(`${file} is byte-identical in both packages`, () => {
      const landingCopy = readFileSync(resolve(LANDING_LIB, file), 'utf8');
      const webUiCopy = readFileSync(resolve(WEB_UI_LIB, file), 'utf8');
      expect(landingCopy).toBe(webUiCopy);
    });
  }
});
