/**
 * Server-side OAuth scope catalog for the per-user connect flows. The frontend
 * sends only a `tier` (minimal | recommended | advanced) on the connect URL; the
 * scope strings live here so the catalog is never exposed to or tamperable by the
 * client. Mirrors the tier labels in web-ui/src/lib/token-scopes.ts.
 */

export type ScopeTier = 'minimal' | 'recommended' | 'advanced';

/** Coerce an untrusted `tier` query value to a known tier (default: recommended). */
export function normalizeScopeTier(tier: string | null | undefined): ScopeTier {
  return tier === 'minimal' || tier === 'advanced' ? tier : 'recommended';
}

/**
 * GitHub OAuth-App classic scopes per tier. Applies ONLY to the OAuth-App provider;
 * a GitHub App's permissions are fixed at install time, so the App provider ignores
 * the scope param entirely.
 */
const GITHUB_OAUTH_SCOPES: Record<ScopeTier, string> = {
  minimal: 'repo',
  recommended: 'repo read:org workflow',
  advanced: 'repo read:org workflow admin:repo_hook read:user',
};

export function githubScopeForTier(tier: string | null | undefined): string {
  return GITHUB_OAUTH_SCOPES[normalizeScopeTier(tier)];
}

/**
 * Cloudflare OAuth scopes per tier, using the real scope IDs from Cloudflare's OAuth
 * catalog (`GET /client/v4/oauth/scopes`) — the `<resource>.<read|write>` form, NOT the
 * API-token permission-group keys or the `:`-style guesses. These map the capabilities
 * the old token-creation deeplink granted onto their OAuth-scope equivalents. The
 * operator's OAuth client must be registered with (at least) the advanced superset, since
 * the per-connect request can only narrow within the client's registered scopes.
 * `offline_access` (appended by cloudflareScopeForTier) is required for a refresh token.
 */
const CF_MINIMAL = [
  'workers-scripts.write',
  'workers-kv-storage.write',
  'workers-r2.write',
  'd1.write',
  'workers-routes.write',
  'account-settings.read',
  'user-details.read',
  'zone.read',
];
const CF_RECOMMENDED = [...CF_MINIMAL, 'dns.write', 'zone-access.write', 'access-acct.write'];
const CF_ADVANCED = [
  ...CF_RECOMMENDED,
  'page.write',
  'containers.write',
  'queues.write',
  'ai.write',
  'browser-rendering.write',
  'vectorize.write',
  'workers-ci.write',
  'workers-observability.write',
  'r2-catalog.write',
  'agw.write',
];

const CLOUDFLARE_OAUTH_SCOPES: Record<ScopeTier, string[]> = {
  minimal: CF_MINIMAL,
  recommended: CF_RECOMMENDED,
  advanced: CF_ADVANCED,
};

export function cloudflareScopeForTier(tier: string | null | undefined): string {
  return [...CLOUDFLARE_OAUTH_SCOPES[normalizeScopeTier(tier)], 'offline_access'].join(' ');
}
