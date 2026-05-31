/**
 * Deploy credential management routes
 * Handles GET/PUT/DELETE for user-scoped GitHub and Cloudflare deploy tokens
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, DeployKeys } from '../types';
import { getDeployKeysKey } from '../lib/kv-keys';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { ValidationError } from '../lib/error-types';
import { getAndDecrypt, encryptAndStore, getOrImportKey } from '../lib/kv-crypto';
import { maskSecret, parseJsonBody, firstZodError } from '../lib/request-helpers';

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

/**
 * GET /api/deploy-keys
 * Returns masked tokens (never full tokens) + plain account ID
 */
app.get('/', async (c) => {
  const bucketName = c.get('bucketName');
  const kvKey = getDeployKeysKey(bucketName);
  const cryptoKey = await getOrImportKey(c.env);
  const stored = await getAndDecrypt<DeployKeys>(c.env.KV, kvKey, cryptoKey);

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
app.put('/', async (c) => {
  const bucketName = c.get('bucketName');
  const raw = await parseJsonBody(c);
  const parsed = UpdateDeployKeysBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(firstZodError(parsed.error));
  }

  const kvKey = getDeployKeysKey(bucketName);
  const cryptoKey = await getOrImportKey(c.env);
  const existing = await getAndDecrypt<DeployKeys>(c.env.KV, kvKey, cryptoKey) || {};
  const updated: DeployKeys = { ...existing };
  let cloudflareAccounts: CloudflareAccount[] | undefined;

  // GitHub token: null = delete, undefined = no change, string = validate + set
  if (parsed.data.githubToken === null) {
    delete updated.githubToken;
  } else if (typeof parsed.data.githubToken === 'string') {
    await validateGithubToken(parsed.data.githubToken);
    updated.githubToken = parsed.data.githubToken;
  }

  // Cloudflare token: null = delete, undefined = no change, string = validate + set
  if (parsed.data.cloudflareApiToken === null) {
    delete updated.cloudflareApiToken;
    delete updated.cloudflareAccountId;
  } else if (typeof parsed.data.cloudflareApiToken === 'string') {
    const accounts = await validateCloudflareToken(parsed.data.cloudflareApiToken);
    updated.cloudflareApiToken = parsed.data.cloudflareApiToken;
    if (accounts.length === 1) {
      updated.cloudflareAccountId = accounts[0].id;
    } else if (accounts.length > 1) {
      cloudflareAccounts = accounts;
      // Don't auto-set account ID - frontend will send it via cloudflareAccountId field
    }
  }

  // Cloudflare account ID: explicit selection (only valid when token is set).
  // Re-validate the supplied ID against the token's account list so an
  // arbitrary value can't be stored without proving the token can access it
  // (avoids SSRF-like probing - REQ-AGENT-029 AC2 / REQ-AGENT-020 AC2).
  if (parsed.data.cloudflareAccountId === null) {
    delete updated.cloudflareAccountId;
  } else if (typeof parsed.data.cloudflareAccountId === 'string') {
    if (!updated.cloudflareApiToken) {
      throw new ValidationError('Cannot set a Cloudflare account ID without a Cloudflare token');
    }
    // Reuse the validation already performed above when the token was
    // co-submitted this request; otherwise validate the stored token now.
    const accounts = cloudflareAccounts ?? await validateCloudflareToken(updated.cloudflareApiToken);
    if (!accounts.some((account) => account.id === parsed.data.cloudflareAccountId)) {
      throw new ValidationError('Cloudflare account ID is not accessible with the stored token');
    }
    updated.cloudflareAccountId = parsed.data.cloudflareAccountId;
  }

  // If all keys are cleared, remove the KV entry entirely
  if (!updated.githubToken && !updated.cloudflareApiToken) {
    await c.env.KV.delete(kvKey);
  } else {
    await encryptAndStore(c.env.KV, kvKey, updated, cryptoKey);
  }

  return c.json({
    githubToken: maskSecret(updated.githubToken),
    cloudflareApiToken: maskSecret(updated.cloudflareApiToken),
    // Emit explicit null on clear so the absence of a value is unambiguous to
    // the client rather than dropped by JSON serialization (REQ-AGENT-029 AC2).
    cloudflareAccountId: updated.cloudflareAccountId ?? null,
    ...(cloudflareAccounts && { cloudflareAccounts }),
  });
});

/**
 * DELETE /api/deploy-keys
 * Remove all deploy keys from KV
 */
app.delete('/', async (c) => {
  const bucketName = c.get('bucketName');
  const kvKey = getDeployKeysKey(bucketName);
  await c.env.KV.delete(kvKey);

  return c.json({ success: true });
});

export default app;
