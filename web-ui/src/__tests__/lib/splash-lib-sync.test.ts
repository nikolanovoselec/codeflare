/**
 * Splash-cursor vendored-library drift guard (DEAD-001).
 *
 * web-ui and landing are independently built npm packages with no workspace
 * linking, and each vendors the same first-party fluid-simulation library.
 * The contract is: one logical library, two vendored copies, byte-identical —
 * so a fix lands once and cannot silently diverge again (the pre-consolidation
 * state was an 85%-similar drifted splash-cursor-logic.ts). If this test
 * fails, port the change to the other package's copy instead of forking.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SHARED_SPLASH_FILES = [
  'webgl-utils.ts',
  'splash-shaders.ts',
  'splash-math.ts',
  'splash-cursor-logic.ts',
];

const WEB_UI_LIB = resolve(__dirname, '../../lib');
const LANDING_LIB = resolve(__dirname, '../../../../landing/src/lib');

describe('splash-cursor vendored library stays in sync between web-ui and landing (DEAD-001)', () => {
  for (const file of SHARED_SPLASH_FILES) {
    it(`${file} is byte-identical in both packages`, () => {
      const webUiCopy = readFileSync(resolve(WEB_UI_LIB, file), 'utf8');
      const landingCopy = readFileSync(resolve(LANDING_LIB, file), 'utf8');
      expect(webUiCopy).toBe(landingCopy);
    });
  }
});
