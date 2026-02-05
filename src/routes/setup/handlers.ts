import { Hono } from 'hono';
import type { Env } from '../../types';
import { AuthError, toError } from '../../lib/error-types';
import { parseCfResponse } from '../../lib/cf-api';
import { cfApiCB } from '../../lib/circuit-breakers';
import { createRateLimiter } from '../../middleware/rate-limit';
import { CF_API_BASE, logger, getWorkerNameFromHostname } from './shared';
import { getAccessGroupNames } from './access';

const statusRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'setup-status' });
const detectTokenRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10, keyPrefix: 'setup-detect-token' });
const prefillRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10, keyPrefix: 'setup-prefill' });

const handlers = new Hono<{ Bindings: Env }>();

/**
 * GET /api/setup/status
 * Check if setup is complete (public endpoint)
 */
handlers.get('/status', statusRateLimiter, async (c) => {
  const setupComplete = await c.env.KV.get('setup:complete');
  const configured = setupComplete === 'true';
  const customDomain = configured ? await c.env.KV.get('setup:custom_domain') : null;

  return c.json({ configured, ...(customDomain && { customDomain }) });
});

/**
 * GET /api/setup/detect-token
 * Detect whether CLOUDFLARE_API_TOKEN is present in the environment (secret binding),
 * verify it against the Cloudflare API, and return account info.
 */
handlers.get('/detect-token', detectTokenRateLimiter, async (c) => {
  const token = c.env.CLOUDFLARE_API_TOKEN;

  if (!token) {
    return c.json({ detected: false, error: 'Deploy with GitHub Actions first' });
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
  const fromKv = await kv.get('setup:account_id');
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
 * Pulls admin/user lists from Cloudflare Access groups.
 * Intentionally does NOT prefill custom domain.
 */
handlers.get('/prefill', prefillRateLimiter, async (c) => {
  const token = c.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    return c.json({ adminUsers: [], allowedUsers: [] });
  }

  try {
    const workerName = getWorkerNameFromHostname(c.req.url, c.env.CLOUDFLARE_WORKER_NAME);
    const groupNames = getAccessGroupNames(workerName);
    const accountId = await resolveAccountId(token, c.env.KV);
    if (!accountId) {
      return c.json({ adminUsers: [], allowedUsers: [] });
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
    });
  } catch (error) {
    logger.warn('Setup prefill failed', { error: toError(error).message });
    return c.json({ adminUsers: [], allowedUsers: [] });
  }
});

/**
 * POST /api/setup/reset-for-tests
 * Test-only reset endpoint (DEV_MODE required)
 * Used by E2E tests to reset setup state before test runs
 */
handlers.post('/reset-for-tests', async (c) => {
  if (c.env.DEV_MODE !== 'true') {
    throw new AuthError('Not available in production');
  }

  // Clear setup state
  await c.env.KV.delete('setup:complete');

  return c.json({ success: true, message: 'Setup state reset for tests' });
});

/**
 * POST /api/setup/restore-for-tests
 * Test-only restore endpoint (DEV_MODE required)
 * Used by E2E tests to restore setup:complete after test runs
 * IMPORTANT: Must be called in afterAll of setup-wizard.test.ts
 */
handlers.post('/restore-for-tests', async (c) => {
  if (c.env.DEV_MODE !== 'true') {
    throw new AuthError('Not available in production');
  }

  // Restore setup state
  await c.env.KV.put('setup:complete', 'true');

  return c.json({ success: true, message: 'Setup state restored for tests' });
});

export default handlers;
