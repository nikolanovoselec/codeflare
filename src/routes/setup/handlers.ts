import { Hono } from 'hono';
import type { Env } from '../../types';
import { toError } from '../../lib/error-types';
import { parseCfResponse } from '../../lib/cf-api';
import { cfApiCB } from '../../lib/circuit-breakers';
import { createRateLimiter } from '../../middleware/rate-limit';
import { CF_API_BASE, logger, getWorkerNameFromHostname } from './shared';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { getAccessGroupNames } from './access';
import { parseAccessGroups } from '../../lib/access';
import { isEnterpriseMode } from '../../lib/subscription';

const statusRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'setup-status' });
const detectTokenRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10, keyPrefix: 'setup-detect-token' });
const prefillRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10, keyPrefix: 'setup-prefill' });

const handlers = new Hono<{ Bindings: Env }>();

/**
 * GET /api/setup/status
 * Check if setup is complete and return configuration (public endpoint)
 * Returns: { configured: boolean, customDomain?: string, saasMode: boolean }
 */
handlers.get('/status', statusRateLimiter, async (c) => {
  const setupComplete = await c.env.KV.get(SETUP_KEYS.COMPLETE);
  const configured = setupComplete === 'true';
  const customDomain = configured ? await c.env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN) : null;
  // saasMode reflects env var, not KV (set at deploy time, not runtime)
  const saasMode = c.env.SAAS_MODE === 'active';
  const enterpriseMode = isEnterpriseMode(c.env);

  return c.json({ configured, ...(customDomain && { customDomain }), saasMode, enterpriseMode });
});

/**
 * GET /api/setup/detect-token
 * Detect whether CLOUDFLARE_API_TOKEN is present in the environment (secret binding),
 * verify it against the Cloudflare API, and return account info.
 * Returns: { detected: boolean, valid?: boolean, account?: { id, name }, error?: string }
 */
handlers.get('/detect-token', detectTokenRateLimiter, async (c) => {
  const token = c.env.CLOUDFLARE_API_TOKEN;

  if (!token) {
    return c.json({ detected: false, error: 'CLOUDFLARE_API_TOKEN not found (set as GitHub Actions secret)' });
  }

  try {
    // Verify token
    const verifyRes = await cfApiCB.execute(() => fetch(`${CF_API_BASE}/user/tokens/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    const verifyData = await parseCfResponse<{ id: string; status: string }>(verifyRes);

    if (!verifyData.success) {
      return c.json({ detected: true, valid: false, error: 'Token is invalid or expired' });
    }

    // Get account info
    const accountsRes = await cfApiCB.execute(() => fetch(`${CF_API_BASE}/accounts`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    const accountsData = await parseCfResponse<Array<{ id: string; name: string }>>(accountsRes);

    if (!accountsData.success || !accountsData.result?.length) {
      return c.json({ detected: true, valid: false, error: 'No accounts found for this token' });
    }

    const account = accountsData.result[0];
    return c.json({
      detected: true,
      valid: true,
      account: { id: account.id, name: account.name },
    });
  } catch (error) {
    logger.error('Token detection error', toError(error));
    return c.json({ detected: true, valid: false, error: 'Failed to verify token' });
  }
});

interface AccessGroupForPrefill {
  name: string;
  include?: unknown[];
}

function extractEmailsFromIncludeRules(includeRules: unknown[]): string[] {
  const emails = includeRules
    .map((rule) => {
      const email = (rule as { email?: { email?: string } })?.email?.email;
      return typeof email === 'string' ? email.trim().toLowerCase() : null;
    })
    .filter((email): email is string => Boolean(email));
  return Array.from(new Set(emails));
}

async function resolveAccountId(token: string, kv: KVNamespace): Promise<string | null> {
  const fromKv = await kv.get(SETUP_KEYS.ACCOUNT_ID);
  if (fromKv) {
    return fromKv;
  }
  const accountsRes = await cfApiCB.execute(() => fetch(`${CF_API_BASE}/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  }));
  const accountsData = await parseCfResponse<Array<{ id: string }>>(accountsRes);
  if (!accountsData.success || !accountsData.result?.length) {
    return null;
  }
  return accountsData.result[0].id;
}

/**
 * GET /api/setup/prefill
 * Best-effort prefill for setup wizard when setup is not completed yet.
 * Pulls admin/user lists from Cloudflare Access groups (non-SaaS mode only).
 * SaaS mode: skipped (admin enters users manually via User Management).
 * Intentionally does NOT prefill custom domain.
 * Returns: { adminUsers: string[], allowedUsers: string[] }
 */
handlers.get('/prefill', prefillRateLimiter, async (c) => {
  const token = c.env.CLOUDFLARE_API_TOKEN;
  // REQ-GITHUB-008: the admin provider config prefill applies in ANY mode (the Setup
  // wizard is admin-gated everywhere). Surface the provider type + non-secret client
  // ids and whether each client secret is set (masked — never return the secrets).
  // Covers the GitHub provider AND the Connect-to-Cloudflare OAuth client.
  const githubProviderType = (await c.env.KV.get(SETUP_KEYS.GITHUB_PROVIDER_TYPE)) ?? null;
  const githubAppClientId = (await c.env.KV.get(SETUP_KEYS.GITHUB_APP_CLIENT_ID)) ?? '';
  const githubAppClientSecretSet = Boolean(await c.env.KV.get(SETUP_KEYS.GITHUB_APP_CLIENT_SECRET));
  const githubOauthClientId = (await c.env.KV.get(SETUP_KEYS.GITHUB_OAUTH_CLIENT_ID)) ?? '';
  const githubOauthClientSecretSet = Boolean(await c.env.KV.get(SETUP_KEYS.GITHUB_OAUTH_CLIENT_SECRET));
  const cloudflareOauthClientId = (await c.env.KV.get(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID)) ?? '';
  const cloudflareOauthClientSecretSet = Boolean(await c.env.KV.get(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET));

  // Enterprise: additionally surface the stored Access groups / route catalog /
  // default route / per-group routing / browser-render token so the wizard round-
  // trips on re-run. parseAccessGroups splits the CSV-joined groups value back into
  // the chip array the UI expects. These fields are enterprise-only.
  let enterpriseExtras: Record<string, unknown> = {
    githubProviderType, githubAppClientId, githubAppClientSecretSet, githubOauthClientId, githubOauthClientSecretSet,
    cloudflareOauthClientId, cloudflareOauthClientSecretSet,
  };
  if (isEnterpriseMode(c.env)) {
    const enterpriseAccessGroup = parseAccessGroups(await c.env.KV.get(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP));
    // REQ-ENTERPRISE-014: surface the stored admin Access groups so the wizard
    // round-trips on re-run (same CSV→chip parse as the user-access groups).
    const adminAccessGroup = parseAccessGroups(await c.env.KV.get(SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP));
    // KV.get(...,'json') throws on malformed stored JSON; degrade to empty/null like
    // the runtime route-config reader does (loadEnterpriseRouteConfig in lib/access).
    let dynamicRoutes: string[] = [];
    let defaultRoute: { route: string; reasoning: string } | null = null;
    try {
      dynamicRoutes = (await c.env.KV.get<string[]>(SETUP_KEYS.DYNAMIC_ROUTES, 'json')) ?? [];
      defaultRoute = (await c.env.KV.get<{ route: string; reasoning: string }>(SETUP_KEYS.DEFAULT_ROUTE, 'json')) ?? null;
    } catch { /* malformed stored JSON → wizard starts from empty */ }
    // REQ-BROWSER-007: surface whether the admin Browser Rendering token is set
    // (masked — never return the token itself) + the non-secret account id so the
    // wizard round-trips on re-run.
    const browserRenderTokenSet = Boolean(await c.env.KV.get(SETUP_KEYS.BROWSER_RENDER_TOKEN));
    const browserRenderAccountId = (await c.env.KV.get(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID)) ?? '';
    // REQ-ENTERPRISE-013: surface the per-group routing map (route names only, no secrets).
    let groupRouting: Record<string, { routes: string[]; defaultRoute: string; reasoning: string }> = {};
    try {
      groupRouting = (await c.env.KV.get<Record<string, { routes: string[]; defaultRoute: string; reasoning: string }>>(SETUP_KEYS.GROUP_ROUTING, 'json')) ?? {};
    } catch { /* malformed stored JSON → wizard starts from empty */ }
    enterpriseExtras = {
      ...enterpriseExtras,
      enterpriseAccessGroup, adminAccessGroup, dynamicRoutes, defaultRoute, browserRenderTokenSet, browserRenderAccountId,
      groupRouting,
    };
  }
  if (!token) {
    return c.json({ adminUsers: [], allowedUsers: [], ...enterpriseExtras });
  }

  // SaaS mode: admin enters everything manually, no prefill from CF Access groups
  if (c.env.SAAS_MODE === 'active') {
    return c.json({ adminUsers: [], allowedUsers: [], ...enterpriseExtras });
  }

  try {
    const workerName = getWorkerNameFromHostname(c.req.url, c.env.CLOUDFLARE_WORKER_NAME);
    const groupNames = getAccessGroupNames(workerName);
    const accountId = await resolveAccountId(token, c.env.KV);
    if (!accountId) {
      return c.json({ adminUsers: [], allowedUsers: [], ...enterpriseExtras });
    }

    const groupsRes = await cfApiCB.execute(() => fetch(`${CF_API_BASE}/accounts/${accountId}/access/groups`, {
      headers: { Authorization: `Bearer ${token}` },
    }));

    const groupsData = await parseCfResponse<AccessGroupForPrefill[]>(groupsRes);
    const groups = groupsData.success && Array.isArray(groupsData.result) ? groupsData.result : [];
    const adminGroup = groups.find((group) => group.name === groupNames.admin);
    const userGroup = groups.find((group) => group.name === groupNames.user);

    const adminUsers = adminGroup?.include ? extractEmailsFromIncludeRules(adminGroup.include) : [];
    const allowedUsers = userGroup?.include ? extractEmailsFromIncludeRules(userGroup.include) : [];

    return c.json({
      adminUsers,
      allowedUsers,
      ...enterpriseExtras,
    });
  } catch (error) {
    logger.warn('Setup prefill failed', { error: toError(error).message });
    return c.json({ adminUsers: [], allowedUsers: [], ...enterpriseExtras });
  }
});

export default handlers;
