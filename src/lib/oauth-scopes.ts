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
 * Cloudflare OAuth scopes per tier, in the Wrangler-style `<resource>:<read|write>`
 * form Cloudflare's OAuth uses. `offline_access` (added by cloudflareScopeForTier)
 * is required to receive a refresh token. The exact scope set must be granted on the
 * operator's OAuth client — confirm against `GET /client/v4/oauth/scopes` during
 * integration before relying on the advanced tier.
 */
const CF_MINIMAL = [
  'account:read',
  'user:read',
  'workers_scripts:write',
  'workers_kv:write',
  'workers_routes:write',
  'd1:write',
  'zone:read',
];
const CF_RECOMMENDED = [...CF_MINIMAL, 'workers:write', 'workers_tail:read', 'pages:write', 'ssl_certs:write'];
const CF_ADVANCED = [
  ...CF_RECOMMENDED,
  'ai:write',
  'queues:write',
  'containers:write',
  'pipelines:write',
  'secrets_store:write',
  'cloudchamber:write',
];

const CLOUDFLARE_OAUTH_SCOPES: Record<ScopeTier, string[]> = {
  minimal: CF_MINIMAL,
  recommended: CF_RECOMMENDED,
  advanced: CF_ADVANCED,
};

export function cloudflareScopeForTier(tier: string | null | undefined): string {
  return [...CLOUDFLARE_OAUTH_SCOPES[normalizeScopeTier(tier)], 'offline_access'].join(' ');
}
