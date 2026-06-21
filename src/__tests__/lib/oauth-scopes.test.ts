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
    // Each tier is a proper superset of the previous — verified by containment, not
    // just length: every minimal scope is in recommended, every recommended in advanced.
    const recSet = new Set(recommended.split(' '));
    const advSet = new Set(advanced.split(' '));
    expect(minimal.split(' ').every((s) => recSet.has(s))).toBe(true);
    expect([...recSet].every((s) => advSet.has(s))).toBe(true);
    expect(recommended.split(' ').length).toBeGreaterThan(minimal.split(' ').length);
    expect(advanced.split(' ').length).toBeGreaterThan(recommended.split(' ').length);
    // Advanced unlocks AI; minimal does not.
    expect(advanced).toContain('ai.write');
    expect(minimal).not.toContain('ai.write');
    expect(cloudflareScopeForTier(undefined)).toBe(recommended);
  });
});

// REQ-BROWSER-002: Browser Rendering Scope in the Cloudflare Token Template.
//
// The SDD anchor for AC1/AC2 names `web-ui/src/lib/token-scopes.ts::CLOUDFLARE_TIERS`,
// but that catalog carries only {label, description} per tier — no machine-readable
// scope IDs. The actual Cloudflare token-template scope set (the contract the user's
// pasted token must satisfy to drive Browser Run) is the server-side scope catalog
// `cloudflareScopeForTier` / CLOUDFLARE_OAUTH_SCOPES here, where `browser-rendering.write`
// is the `Browser Rendering - Edit` capability. These assert that real contract value;
// asserting the web-ui description copy would be banned text-matching theater.
describe('REQ-BROWSER-002: Browser Rendering scope in the Cloudflare token template', () => {
  // The Cloudflare OAuth catalog scope ID for the "Browser Rendering - Edit" capability.
  const BROWSER_RENDERING_EDIT = 'browser-rendering.write';

  // The full known core (non-Browser-Rendering) scope set the template granted before
  // Browser Rendering was added — every Cloudflare deploy capability across all tiers.
  // This is the backward-compat baseline for AC3.
  const KNOWN_CORE_SCOPES = [
    // minimal
    'workers-scripts.write',
    'workers-kv-storage.write',
    'workers-r2.write',
    'd1.write',
    'workers-routes.write',
    'account-settings.read',
    'user-details.read',
    'zone.read',
    // recommended adds
    'dns.write',
    'zone-access.write',
    'access-acct.write',
    // advanced adds (excluding browser-rendering.write)
    'page.write',
    'containers.write',
    'queues.write',
    'ai.write',
    'vectorize.write',
    'workers-ci.write',
    'workers-observability.write',
    'r2-catalog.write',
    'agw.write',
  ];

  it('AC1: the advanced Cloudflare token template grants Browser Rendering - Edit', () => {
    // Browser Run is gated to advanced mode, so the Browser Rendering scope lives in the
    // advanced tier. Assert the exact scope ID is present as a discrete scope (not a
    // substring of some other scope).
    const advancedScopes = cloudflareScopeForTier('advanced').split(' ');
    expect(advancedScopes).toContain(BROWSER_RENDERING_EDIT);

    // And it is genuinely tier-gated: the minimal template must NOT carry it, so a
    // Browser-Run-incapable token never silently gets the scope.
    const minimalScopes = cloudflareScopeForTier('minimal').split(' ');
    expect(minimalScopes).not.toContain(BROWSER_RENDERING_EDIT);
  });

  it('AC2: the addition is additive — every known core scope still present in advanced', () => {
    // Additivity: adding browser-rendering.write must not have removed or renamed any
    // scope the template already granted. Assert each known core scope key still exists.
    const advancedScopes = new Set(cloudflareScopeForTier('advanced').split(' '));
    for (const core of KNOWN_CORE_SCOPES) {
      expect(advancedScopes.has(core)).toBe(true);
    }
  });

  it('AC3: backward-compat — non-Browser-Rendering scope set is exactly the known core set', () => {
    // Tokens created before the Browser Rendering scope was added still work for all
    // existing functionality: the set of non-Browser-Rendering scopes the template grants
    // must be EXACTLY the known core set — nothing core removed, nothing extra/unexpected
    // crept in beyond the one Browser Rendering addition (plus offline_access, which is the
    // refresh-token grant appended by cloudflareScopeForTier, not a Cloudflare capability).
    const advancedScopes = cloudflareScopeForTier('advanced').split(' ');
    const nonBrowserCore = advancedScopes
      .filter((s) => s !== BROWSER_RENDERING_EDIT)
      .filter((s) => s !== 'offline_access');

    // Same membership, no removals (every known core present) and no additions
    // (no scope outside the known core set).
    expect(new Set(nonBrowserCore)).toEqual(new Set(KNOWN_CORE_SCOPES));
    // No duplicates introduced.
    expect(nonBrowserCore.length).toBe(KNOWN_CORE_SCOPES.length);
  });
});
