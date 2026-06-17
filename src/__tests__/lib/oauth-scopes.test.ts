import { describe, it, expect } from 'vitest';
import { normalizeScopeTier, githubScopeForTier, cloudflareScopeForTier } from '../../lib/oauth-scopes';

describe('normalizeScopeTier', () => {
  it('passes through known tiers and defaults unknown/missing to recommended', () => {
    expect(normalizeScopeTier('minimal')).toBe('minimal');
    expect(normalizeScopeTier('advanced')).toBe('advanced');
    expect(normalizeScopeTier('recommended')).toBe('recommended');
    expect(normalizeScopeTier(undefined)).toBe('recommended');
    expect(normalizeScopeTier('not-a-tier')).toBe('recommended');
  });
});

describe('githubScopeForTier', () => {
  it('escalates capability with tier and defaults unknown to recommended', () => {
    const minimal = githubScopeForTier('minimal');
    const recommended = githubScopeForTier('recommended');
    const advanced = githubScopeForTier('advanced');

    // Minimal can push but not run workflows; recommended adds workflow; advanced adds hooks.
    expect(minimal).not.toContain('workflow');
    expect(recommended).toContain('workflow');
    expect(advanced).toContain('admin:repo_hook');
    expect(advanced.split(' ').length).toBeGreaterThan(recommended.split(' ').length);
    expect(githubScopeForTier('garbage')).toBe(recommended);
  });
});

describe('cloudflareScopeForTier', () => {
  it('always requests offline_access and escalates capability with tier', () => {
    const minimal = cloudflareScopeForTier('minimal');
    const recommended = cloudflareScopeForTier('recommended');
    const advanced = cloudflareScopeForTier('advanced');

    for (const s of [minimal, recommended, advanced]) {
      expect(s.split(' ')).toContain('offline_access'); // refresh-token grant
    }
    // Each tier is a superset of the previous (more scopes granted).
    expect(recommended.split(' ').length).toBeGreaterThan(minimal.split(' ').length);
    expect(advanced.split(' ').length).toBeGreaterThan(recommended.split(' ').length);
    // Advanced unlocks AI; minimal does not.
    expect(advanced).toContain('ai:write');
    expect(minimal).not.toContain('ai:write');
    expect(cloudflareScopeForTier(undefined)).toBe(recommended);
  });
});
