/**
 * Deploy credential management routes
 * Handles GET/PUT/DELETE for user-scoped GitHub and Cloudflare deploy tokens
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { changeDeployKeys, ownedDeployKeys, readDeployKeys } from '../lib/deploy-keys';
import { withoutGithubConnection } from '../lib/github-token';
import { withoutCloudflareConnection } from '../lib/cloudflare-token';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { AppError, ForbiddenError, ValidationError } from '../lib/error-types';
import { isEnterpriseMode } from '../lib/subscription';
import { maskSecret, parseJsonBody } from '../lib/request-helpers';
import { createRateLimiter } from '../middleware/rate-limit';

const UpdateDeployKeysBody = z.object({
  githubToken: z.string().max(256).nullable().optional(),
  cloudflareApiToken: z.string().max(256).nullable().optional(),
  cloudflareAccountId: z.string().max(128).nullable().optional(),
}).strict();

/**
 * Validate a GitHub fine-grained PAT by calling the GitHub API.
 * Throws ValidationError if the token is invalid.
 */
async function validateGithubToken(token: string): Promise<void> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Codeflare',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new ValidationError('Invalid GitHub token - could not authenticate with GitHub API');
  }
}

interface CloudflareAccount {
  id: string;
  name: string;
}

/**
 * Validate a Cloudflare API token and fetch associated accounts.
 * Returns the list of accounts. Throws ValidationError if the token is invalid.
 */
async function validateCloudflareToken(token: string): Promise<CloudflareAccount[]> {
  const res = await fetch('https://api.cloudflare.com/client/v4/accounts', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new ValidationError('Invalid Cloudflare token - could not authenticate with Cloudflare API');
  }
  const body = await res.json() as { success: boolean; result?: CloudflareAccount[] };
  if (!body.success || !Array.isArray(body.result)) {
    throw new ValidationError('Invalid Cloudflare token - API returned an error');
  }
  return body.result;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authMiddleware);

// REQ-ENTERPRISE-306 AC1: deny direct credential management for every Enterprise
// role before parsing, credential I/O or provider validation.
app.use('*', async (c, next) => {
  if (isEnterpriseMode(c.env)) {
    throw new ForbiddenError('Deploy credential management is disabled in enterprise mode.');
  }
  return next();
});

// These routes are mounted without a shared mutation wrapper. Charge both
// mutation methods to one authenticated-user budget before any credential I/O.
const mutationRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  keyPrefix: 'deploy-keys-mutation',
  // Preserve the existing general mutation policy and its in-memory fallback.
  failClosed: false,
});

/**
 * GET /api/deploy-keys
 * Returns masked tokens (never full tokens) + plain account ID
 */
app.get('/', async (c) => {
  const bucketName = c.get('bucketName');
  const stored = await readDeployKeys(c.env, bucketName);

  return c.json({
    githubToken: maskSecret(stored?.githubToken),
    cloudflareApiToken: maskSecret(stored?.cloudflareApiToken),
    cloudflareAccountId: stored?.cloudflareAccountId ?? null,
  });
});

/**
 * PUT /api/deploy-keys
 * Set or clear individual keys.
 * - string value: set the key (validated against provider API)
 * - null: delete the key
 * - undefined/omitted: no change
 * Returns masked keys after update, plus cloudflare accounts if multi-account.
 */
app.put('/', mutationRateLimiter, async (c) => {
  const bucketName = c.get('bucketName');
  const body = await parseJsonBody(c, UpdateDeployKeysBody);

  const store = ownedDeployKeys(c.env, bucketName);
  const snapshot = await store.read();
  const changesGithub = body.githubToken !== undefined;
  const changesCloudflareToken = body.cloudflareApiToken !== undefined;
  if (typeof body.githubToken === 'string') await validateGithubToken(body.githubToken);
  const submittedAccounts = typeof body.cloudflareApiToken === 'string' ? await validateCloudflareToken(body.cloudflareApiToken) : undefined;
  const cloudflareAccounts = submittedAccounts && submittedAccounts.length > 1 ? submittedAccounts : undefined;

  const scope = changesGithub ? (changesCloudflareToken ? 'both' : 'github')
    : changesCloudflareToken ? 'cloudflare' : 'cloudflare-account';
  const result = changesGithub || changesCloudflareToken || body.cloudflareAccountId !== undefined
    ? await changeDeployKeys(store, scope, async existing => {
      let updated = { ...existing };
      if (changesGithub) {
        // Replacing or clearing a grant drops OAuth/App metadata (including login).
        updated = withoutGithubConnection(updated) ?? {};
        if (typeof body.githubToken === 'string') {
          updated.githubToken = body.githubToken;
          updated.githubTokenSource = 'pat';
        }
      }
      if (body.cloudflareApiToken === null) {
        updated = withoutCloudflareConnection(updated) ?? {};
      } else if (typeof body.cloudflareApiToken === 'string') {
        delete updated.cloudflareTokenSource;
        delete updated.cloudflareRefreshToken;
        delete updated.cloudflareTokenExpiresAt;
        updated.cloudflareApiToken = body.cloudflareApiToken;
        if (submittedAccounts?.length === 1) updated.cloudflareAccountId = submittedAccounts[0].id;
      }
      if (body.cloudflareAccountId === null) {
        delete updated.cloudflareAccountId;
      } else if (typeof body.cloudflareAccountId === 'string') {
        if (!updated.cloudflareApiToken) throw new ValidationError('Cannot set a Cloudflare account ID without a Cloudflare token');
        // On a CAS retry, validate against the latest stored token, not a grant
        // that was replaced while validation was in flight.
        const accounts = submittedAccounts ?? await validateCloudflareToken(updated.cloudflareApiToken);
        if (!accounts.some(account => account.id === body.cloudflareAccountId)) {
          throw new ValidationError('Cloudflare account ID is not accessible with the stored token');
        }
        updated.cloudflareAccountId = body.cloudflareAccountId;
      }
      return Object.keys(updated).length ? updated : null;
    }, { snapshot }) : { keys: snapshot.keys };
  if (!result) throw new AppError('DEPLOY_KEYS_RESET', 409, 'Deploy credentials were reset; retry the update');
  const updated = result.keys;

  return c.json({
    githubToken: maskSecret(updated?.githubToken),
    cloudflareApiToken: maskSecret(updated?.cloudflareApiToken),
    // Emit explicit null on clear so the absence of a value is unambiguous to
    // the client rather than dropped by JSON serialization (REQ-AGENT-029 AC2).
    cloudflareAccountId: updated?.cloudflareAccountId ?? null,
    ...(cloudflareAccounts && { cloudflareAccounts }),
  });
});

/**
 * DELETE /api/deploy-keys
 * Remove all deploy credentials and invalidate pending credential writes
 */
app.delete('/', mutationRateLimiter, async (c) => {
  const bucketName = c.get('bucketName');
  await ownedDeployKeys(c.env, bucketName).reset();

  return c.json({ success: true });
});

export default app;
