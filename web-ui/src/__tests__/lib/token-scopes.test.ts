// Implements REQ-AGENT-028 (OAuth scope-tier selector catalogs)
import { describe, it, expect } from 'vitest';
import { GITHUB_TIERS, CLOUDFLARE_TIERS } from '../../lib/token-scopes';

describe('scope-tier catalogs', () => {
  for (const [name, tiers] of [
    ['GITHUB_TIERS', GITHUB_TIERS],
    ['CLOUDFLARE_TIERS', CLOUDFLARE_TIERS],
  ] as const) {
    describe(name, () => {
      it('exposes exactly the three tiers in order', () => {
        expect(Object.keys(tiers)).toEqual(['minimal', 'recommended', 'advanced']);
      });
      it('each tier carries a non-empty label and description', () => {
        for (const tier of Object.values(tiers)) {
          expect(tier.label).toBeTruthy();
          expect(tier.description).toBeTruthy();
        }
      });
    });
  }
});
