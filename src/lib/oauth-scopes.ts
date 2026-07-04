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
// Advanced tier = a strict superset of Recommended (built from CF_RECOMMENDED) plus the full
// operator-finalized capability set, verified against Cloudflare's live consent screen (every
// scope below was accepted by the OAuth authorize flow with the operator client registered for
// the superset). Advanced KEEPS Recommended's combined Access scopes
// (zone-access.write/access-acct.write, inherited via CF_RECOMMENDED) AND adds the granular ids
// (access-app/access-policy/access-org/access-idp/access-group). `Logs: Edit` resolved to
// `logs.write` (account-logs.write was rejected). Three requested permissions have no OAuth
// scope and are intentionally absent (OAuth Clients: Edit, API Tokens: Edit, Network flow: Admin
// — classic API token only).
const CF_ADVANCED = [
  ...CF_RECOMMENDED,
  // Zone / DNS
  'zone-waf.write',
  // Workers platform
  'page.write',
  'containers.write',
  'queues.write',
  'pipelines.write',
  'r2-catalog.write',
  'workers-ci.write',
  'workers-observability.write',
  'workers-tail.read',
  'cf-agents.write',
  'secrets-store.write',
  // AI — Workers AI, AI Gateway, Agents Gateway, AI Search, AI Audit, Firewall for AI, Websearch
  // (the full AI scope set exposed by Cloudflare's OAuth client; `aig.*` = AI Gateway,
  // `agw.*` = Agents Gateway — distinct products). `aig.run` authenticates the AI Gateway
  // data-plane (cf-aig-authorization), `aig.write` its management.
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
  'browser-rendering.write',
  'challenge-widgets.write',
  // Access / Zero Trust
  'teams.write',
  'access-org.write',
  'access-idp.write',
  'access-group.write',
  'access-app.write',
  'access-policy.write',
  'access-audit-log.read',
  'access-device-posture.write',
  'access-service-token.write',
  // Cloudflare One / networking
  'teams-connectors.write',
  'teams-networks.write',
  'argotunnel.write',
  'magic-wan.write',
  'connectivity-directory.admin',
  'magic-firewall.write',
  'pcaps-api.write',
  'logs.write',
  'mcp-portals.write',
  // Account security
  'account-firewall-access-rules.write',
  'account-waf.write',
  'account-ssl-and-certificates.write',
];

const CLOUDFLARE_OAUTH_SCOPES: Record<ScopeTier, string[]> = {
  minimal: CF_MINIMAL,
  recommended: CF_RECOMMENDED,
  advanced: CF_ADVANCED,
};

export function cloudflareScopeForTier(tier: string | null | undefined): string {
  return [...CLOUDFLARE_OAUTH_SCOPES[normalizeScopeTier(tier)], 'offline_access'].join(' ');
}
