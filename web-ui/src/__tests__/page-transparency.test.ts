import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Verify that the glassmorphism transparency token and all three page containers
 * (onboarding, setup, dashboard) use a consistent 10% transparency (alpha 0.9).
 */

const stylesDir = resolve(__dirname, '../styles');

function readCss(filename: string): string {
  return readFileSync(resolve(stylesDir, filename), 'utf-8');
}

describe('Page Transparency Normalization', () => {
  const designTokens = readCss('design-tokens.css');
  const onboardingCss = readCss('onboarding-landing.css');
  const setupCss = readCss('setup-wizard.css');
  const dashboardCss = readCss('dashboard.css');

  it('design token --glass-bg should use alpha 0.9 (10% transparency)', () => {
    // Match the --glass-bg token definition
    const match = designTokens.match(/--glass-bg:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
    expect(match).not.toBeNull();
    expect(parseFloat(match![4])).toBe(0.9);
  });

  it('onboarding card should use var(--glass-bg) for background', () => {
    // The .onboarding-card selector should reference --glass-bg
    expect(onboardingCss).toContain('var(--glass-bg)');
  });

  it('setup container should use var(--glass-bg) for background', () => {
    // The .setup-container selector should reference --glass-bg
    expect(setupCss).toContain('var(--glass-bg)');
  });

  it('dashboard panel should use var(--glass-bg) for background', () => {
    // The .dashboard-panel selector should reference --glass-bg
    expect(dashboardCss).toContain('var(--glass-bg)');
  });
});
