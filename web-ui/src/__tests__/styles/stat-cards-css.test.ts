import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const cssContent = readFileSync(
  resolve(__dirname, '../../styles/stat-cards.css'),
  'utf-8'
);

describe('stat-cards.css', () => {
  it('should not have semi-transparent rgba in stat-card background gradient', () => {
    // The stat-card gradient must NOT contain semi-transparent rgba values
    // because different parent backgrounds (dashboard panel vs dropdown)
    // cause visible differences when the card background is translucent.
    // Extract just the background property from the .stat-card block
    const statCardBlock = cssContent.match(/\.stat-card\s*\{[\s\S]*?\}/);
    expect(statCardBlock).not.toBeNull();
    const block = statCardBlock![0];
    // Extract the background line(s)
    const bgMatch = block.match(/background:\s*linear-gradient\([\s\S]*?\);/);
    expect(bgMatch).not.toBeNull();
    const bgValue = bgMatch![0];
    // Check for rgba with alpha < 1 in the gradient
    const rgbaMatches = bgValue.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/g) || [];
    for (const rgba of rgbaMatches) {
      const alpha = parseFloat(rgba.match(/,\s*([\d.]+)\s*\)/)![1]);
      expect(alpha, `Found semi-transparent rgba in .stat-card background: ${rgba}`).toBe(1);
    }
  });
});
