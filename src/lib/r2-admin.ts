/**
 * R2 bucket management via Cloudflare API
 */

import { createLogger } from './logger';
import { r2AdminCB } from './circuit-breakers';
import { CF_API_BASE } from './constants';
import { parseCfResponse } from './cf-api';

const logger = createLogger('r2-admin');

/**
 * Check if a bucket exists
 */
async function bucketExists(
  accountId: string,
  apiToken: string,
  bucketName: string
): Promise<boolean> {
  const response = await r2AdminCB.execute(() =>
    fetch(
      `${CF_API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      }
    )
  );

  return response.ok;
}

/**
 * Create an R2 bucket if it doesn't exist
 * Returns true if bucket exists or was created, false on error
 */
export async function createBucketIfNotExists(
  accountId: string,
  apiToken: string,
  bucketName: string
): Promise<{ success: boolean; error?: string; created?: boolean }> {
  // Check if bucket already exists
  const exists = await bucketExists(accountId, apiToken, bucketName);
  if (exists) {
    logger.info('Bucket already exists', { bucketName });
    return { success: true, created: false };
  }

  // Create the bucket
  logger.info('Creating bucket', { bucketName });

  const response = await r2AdminCB.execute(() =>
    fetch(
      `${CF_API_BASE}/accounts/${accountId}/r2/buckets`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: bucketName }),
        signal: AbortSignal.timeout(10_000),
      }
    )
  );

  const data = await parseCfResponse<{ name: string; creation_date: string; location: string }>(response);

  if (!response.ok || !data.success) {
    // Treat "already exists" as success (race between bucketExists check and creation)
    const alreadyExists = data.errors?.some(
      e => e.message?.toLowerCase().includes('already exists')
    );
    if (alreadyExists) {
      logger.info('Bucket already exists (detected via create error)', { bucketName });
      return { success: true, created: false };
    }

    const errorMsg = data.errors?.[0]?.message || `HTTP ${response.status}`;
    logger.error('Failed to create bucket', new Error(errorMsg), { bucketName });
    return { success: false, error: errorMsg };
  }

  logger.info('Bucket created successfully', { bucketName });
  return { success: true, created: true };
}

// =========================================================================
// Scoped R2 Tokens
// =========================================================================

interface ScopedR2TokenResult {
  accessKeyId: string;
  secretAccessKey: string;
  tokenId: string;
}

interface CachedR2Token extends ScopedR2TokenResult {
  bucketName: string;
  createdAt: string;
}

const MAX_RETRIES = 2;

function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Create a scoped R2 API token with permission boundary for a specific bucket.
 * Retries 2x with exponential backoff on 5xx/429 errors.
 */
export async function createScopedR2Token(
  accountId: string,
  apiToken: string,
  bucketName: string
): Promise<ScopedR2TokenResult> {
  const url = `${CF_API_BASE}/accounts/${accountId}/tokens`;

  const body = JSON.stringify({
    name: bucketName,
    policies: [
      {
        effect: 'allow',
        permission_groups: [
          { id: '6a018a9f2fc74eb6b293b0c548f38b39' }, // R2 Object Read
          { id: '2efd5506f9c8494dacb1fa10a3e7d5b6' }, // R2 Object Write
        ],
        resources: {
          [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucketName}`]: '*',
        },
      },
    ],
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await r2AdminCB.execute(() =>
        fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(10_000),
        })
      );
    } catch (err) {
      // Network errors are retryable
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= MAX_RETRIES) throw lastError;
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
      continue;
    }

    if (response.ok) {
      const data = await response.json() as {
        success: boolean;
        result: { id: string; value: string };
      };

      if (data.success) {
        // Derive S3-compatible secret from token value via SHA-256
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data.result.value));
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const secretAccessKey = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        return {
          accessKeyId: data.result.id,
          secretAccessKey,
          tokenId: data.result.id,
        };
      }
    }

    // Non-retryable client error (4xx except 429) — throw immediately
    if (!isRetryable(response.status)) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to create scoped R2 token for bucket ${bucketName}: HTTP ${response.status} ${text.slice(0, 200)}`);
    }

    // Retryable — store error for final throw or retry
    lastError = new Error(`Failed to create scoped R2 token for bucket ${bucketName}: HTTP ${response.status}`);
    if (attempt >= MAX_RETRIES) throw lastError;

    await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
  }

  throw lastError!;
}

/**
 * Delete a scoped R2 token. Succeeds silently on 404 (already deleted).
 */
export async function deleteScopedR2Token(
  accountId: string,
  apiToken: string,
  tokenId: string
): Promise<void> {
  const response = await fetch(
    `${CF_API_BASE}/accounts/${accountId}/tokens/${tokenId}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
      },
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(`Failed to delete scoped R2 token ${tokenId}: HTTP ${response.status}`);
  }
}

/**
 * Get cached scoped R2 token from KV, or create a new one.
 * With forceFresh=true, deletes the stale KV entry and creates a fresh token.
 */
export async function getOrCreateScopedR2Token(
  email: string,
  accountId: string,
  apiToken: string,
  bucketName: string,
  kv: KVNamespace,
  options?: { forceFresh?: boolean }
): Promise<ScopedR2TokenResult> {
  const kvKey = `r2token:${email}`;

  if (options?.forceFresh) {
    await kv.delete(kvKey);
  } else {
    const cached = await kv.get(kvKey);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedR2Token;
      return {
        accessKeyId: parsed.accessKeyId,
        secretAccessKey: parsed.secretAccessKey,
        tokenId: parsed.tokenId,
      };
    }
  }

  const result = await createScopedR2Token(accountId, apiToken, bucketName);

  const kvValue: CachedR2Token = {
    ...result,
    bucketName,
    createdAt: new Date().toISOString(),
  };
  await kv.put(kvKey, JSON.stringify(kvValue));

  return result;
}
