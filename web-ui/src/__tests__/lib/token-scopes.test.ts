// Implements REQ-AGENT-028 (OAuth scope-tier selector catalogs)
import { describe, it, expect } from 'vitest';
import { GITHUB_TIERS, CLOUDFLARE_TIERS, tierOptionList } from '../../lib/token-scopes';

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

describe('tierOptionList', () => {
  it('maps a tier catalog to {value,label} options keyed by tier id', () => {
    const opts = tierOptionList(GITHUB_TIERS);
    // value is the tier id (what the connect URL sends), label is the catalog label.
    expect(opts.map((o) => o.value)).toEqual(['minimal', 'recommended', 'advanced']);
    expect(opts.map((o) => o.label)).toEqual([
      GITHUB_TIERS.minimal.label,
      GITHUB_TIERS.recommended.label,
      GITHUB_TIERS.advanced.label,
    ]);
  });
});
