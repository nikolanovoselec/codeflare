import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const cssContent = readFileSync(
  resolve(__dirname, '../../styles/kitt-scanner.css'),
  'utf-8'
);

describe('kitt-scanner.css', () => {
  it('should position .kitt-scanner at top: 0 (not clipped by overflow:hidden)', () => {
    // The scanner must sit at top: 0 so it is not clipped when a parent
    // container uses overflow:hidden (e.g. the onboarding card).
    expect(cssContent).toMatch(/\.kitt-scanner\s*\{[^}]*top:\s*0[;\s]/);
    expect(cssContent).not.toMatch(/\.kitt-scanner\s*\{[^}]*top:\s*-2px/);
  });

  it('should use 7px mask fade (not 15px) for tighter edge blending', () => {
    // Both -webkit-mask-image and mask-image should fade at 7px from each edge
    expect(cssContent).toContain('black 7px');
    expect(cssContent).toContain('calc(100% - 7px)');
    expect(cssContent).not.toContain('black 15px');
    expect(cssContent).not.toContain('calc(100% - 15px)');
  });
});
