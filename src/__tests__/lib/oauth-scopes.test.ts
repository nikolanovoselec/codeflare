import { describe, it, expect } from 'vitest';
import { normalizeScopeTier, githubScopeForTier, cloudflareScopeForTier } from '../../lib/oauth-scopes';

// REQ-AGENT-028: Deploy Credential Token-Creation UX
// REQ-GITHUB-007: Broaden the panel gate beyond enterprise

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

// REQ-AGENT-079: Advanced Cloudflare OAuth tier scope catalog. The recommended-⊆-advanced
// superset assertion here and the exact-set assertion below guard the current catalog.
describe('REQ-AGENT-079: cloudflareScopeForTier advanced-tier scope catalog', () => {
  it('always requests offline_access and escalates capability with tier', () => {
    const minimal = cloudflareScopeForTier('minimal');
    const recommended = cloudflareScopeForTier('recommended');
    const advanced = cloudflareScopeForTier('advanced');

    for (const s of [minimal, recommended, advanced]) {
      expect(s.split(' ')).toContain('offline_access'); // refresh-token grant
      expect(s.split(' ')).toContain('analytics.read'); // Analytics read access
    }
    // minimal ⊆ recommended ⊆ advanced (verified by containment, not length). Advanced is a
    // strict superset of recommended: it keeps recommended's combined Access scopes
    // (zone-access.write/access-acct.write) AND adds the granular ids
    // (access-app/access-policy/access-org/access-idp/access-group), so NO recommended scope is
    // absent from advanced.
    const recSet = new Set(recommended.split(' '));
    const advSet = new Set(advanced.split(' '));
    expect(minimal.split(' ').every((s) => recSet.has(s))).toBe(true);
    expect(minimal.split(' ').every((s) => advSet.has(s))).toBe(true);
    expect([...recSet].filter((s) => !advSet.has(s))).toEqual([]);
    expect(recommended.split(' ').length).toBeGreaterThan(minimal.split(' ').length);
    expect(advanced.split(' ').length).toBeGreaterThan(recommended.split(' ').length);
    // Advanced unlocks AI; minimal does not.
    expect(advanced).toContain('ai.write');
    expect(advanced).toContain('cloudchamber.write');
    expect(minimal).not.toContain('ai.write');
    expect(minimal).not.toContain('cloudchamber.write');
    expect(cloudflareScopeForTier(undefined)).toBe(recommended);
  });
});

// REQ-BROWSER-002: Browser Rendering is additive in the server-side token scope catalog.
describe('REQ-BROWSER-002: Browser Rendering scope in the Cloudflare token template', () => {
  // The Cloudflare OAuth catalog scope ID for the "Browser Rendering - Edit" capability.
  const BROWSER_RENDERING_EDIT = 'browser-rendering.write';

  // The finalized non-Browser-Rendering advanced scope set. The exact-set
  // assertion detects removed, added, or renamed scopes. Advanced is a superset
  // of recommended: it carries BOTH the combined Access scopes (zone-access.write/access-acct.write,
  // inherited from recommended) AND the granular ids (access-app/access-policy/access-org/
  // access-idp/access-group).
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
    'analytics.read',
    // zone / dns + recommended's combined Access scopes (inherited from recommended)
    'dns.write',
    'zone-access.write',
    'access-acct.write',
    'zone-waf.write',
    // workers platform
    'page.write',
    'containers.write',
    'cloudchamber.write',
    'queues.write',
    'pipelines.write',
    'r2-catalog.write',
    'workers-ci.write',
    'workers-observability.write',
    'workers-tail.read',
    'cf-agents.write',
    'secrets-store.write',
    // AI (browser-rendering.write asserted separately in AC1). aig.* = AI Gateway,
    // agw.* = Agents Gateway — distinct Cloudflare products, both in the OAuth catalog.
    'ai.write',
    'ai.read',
    'aig.write',
    'aig.run',
    'agw.write',
    'agw.read',
    'agw.run',
    'ai-search.index',
    'ai-search.run',
    'ai-search.write',
    'aiaudit.read',
    'aiaudit.write',
    'firewall-for-ai.read',
    'firewall-for-ai.write',
    'websearch.run',
    'vectorize.write',
    'challenge-widgets.write',
    // access / zero trust
    'teams.write',
    'access-org.write',
    'access-idp.write',
    'access-group.write',
    'access-app.write',
    'access-policy.write',
    'access-audit-log.read',
    'access-device-posture.write',
    'access-service-token.write',
    // cloudflare one / networking
    'teams-connectors.write',
    'teams-networks.write',
    'argotunnel.write',
    'magic-wan.write',
    'connectivity-directory.admin',
    'magic-firewall.write',
    'pcaps-api.write',
    'logs.write',
    'mcp-portals.write',
    // account security
    'account-firewall-access-rules.write',
    'account-waf.write',
    'account-ssl-and-certificates.write',
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

  // REQ-AGENT-079 AC1/AC3: this exact-set assertion is the advanced-tier scope-catalog guard —
  // the non-Browser-Rendering advanced set must equal the finalized catalog exactly (pins
  // logs.write, both the combined and granular Access ids, and the absence of the
  // no-OAuth-scope permissions).
  it('REQ-AGENT-079 AC1/AC3: non-Browser-Rendering advanced scopes match the finalized catalog', () => {
    // offline_access requests refresh tokens and is not a Cloudflare capability.
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
