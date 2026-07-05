/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const cssContent = readFileSync(
  resolve(__dirname, '../../styles/header.css'),
  'utf-8',
);

// REQ-VAULT-022 AC6: a ready ('armed') vault button must stay green even under a
// sticky touch-device :hover. The generic header-button hover rule sets
// color: var(--color-text-primary) (near-white) at specificity (0,3,0); the armed
// override ties that specificity, so it only wins by coming LATER in source order.
// These assert the contract that makes the fix work — the selector, the colour it
// sets, and that it is declared after the generic hover rule — not any copy.
describe('header.css: armed vault button hover override (REQ-VAULT-022 AC6)', () => {
  const armedHoverRe = /\.header-vault-button--armed:hover:not\(\[aria-disabled="true"\]\)\s*\{[^}]*\}/;

  it('armed vault button keeps the success colour under sticky :hover', () => {
    const match = cssContent.match(armedHoverRe);
    expect(match).not.toBeNull();
    // The override sets the success colour (the same green the un-hovered armed state uses).
    expect(match![0]).toMatch(/color:\s*var\(--color-success/);
  });

  it('is declared AFTER the generic header-button hover rule so it wins the specificity tie', () => {
    // Generic rule that paints the near-white text-primary colour on hover.
    const genericHoverIdx = cssContent.search(
      /\.header-vault-button:hover:not\(\[aria-disabled="true"\]\)/,
    );
    const armedHoverIdx = cssContent.search(armedHoverRe);
    expect(genericHoverIdx).toBeGreaterThanOrEqual(0);
    expect(armedHoverIdx).toBeGreaterThanOrEqual(0);
    // Equal specificity (0,3,0) each → later declaration wins. Gut-check: swap the
    // order and the armed green loses to the near-white generic hover colour again.
    expect(armedHoverIdx).toBeGreaterThan(genericHoverIdx);
  });
});
