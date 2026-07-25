/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const cssContent = readFileSync(
  resolve(__dirname, '../../styles/kitt-scanner.css'),
  'utf-8'
);

// Cascade-safety: scope every assertion to the ONE .kitt-scanner rule block and
// assert it is unique, so a later override (or a `top` on a sibling selector like
// .kitt-beam) cannot satisfy these checks while the real rule regresses.
function kittScannerRuleBody(): string {
  const matches = [...cssContent.matchAll(/\.kitt-scanner\s*\{([^}]*)\}/g)];
  // Exactly one base rule → nothing downstream can re-declare and win the cascade.
  expect(matches).toHaveLength(1);
  return matches[0][1];
}

describe('kitt-scanner.css', () => {
  it('declares exactly one .kitt-scanner rule positioned at top: 0 (not clipped by overflow:hidden)', () => {
    const body = kittScannerRuleBody();
    expect(body).toMatch(/top:\s*0[;\s]/);
    expect(body).not.toMatch(/top:\s*-2px/);
  });

  it('uses a 7px mask fade (not 15px) for tighter edge blending, inside the .kitt-scanner rule', () => {
    const body = kittScannerRuleBody();
    expect(body).toContain('black 7px');
    expect(body).toContain('calc(100% - 7px)');
    expect(body).not.toContain('black 15px');
    expect(body).not.toContain('calc(100% - 15px)');
  });
});
