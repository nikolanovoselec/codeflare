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
// R2 S3 Credentials (derived from API token)
// =========================================================================

interface R2CredentialResult {
  accessKeyId: string;
  secretAccessKey: string;
}

interface CachedR2Token extends R2CredentialResult {
  bucketName: string;
  createdAt: string;
}

/**
 * Derive R2 S3-compatible credentials from the Cloudflare API token.
 *
 * Cloudflare R2 S3 API credentials are derived from regular API tokens:
 *   - S3 Access Key ID = API token ID (from /user/tokens/verify)
 *   - S3 Secret Access Key = SHA-256 hash of the API token value
 *
 * This avoids needing "API Tokens Edit" permission to create separate tokens.
 * Same approach as the setup wizard (src/routes/setup/credentials.ts).
 */
export async function deriveR2Credentials(
  apiToken: string
): Promise<R2CredentialResult> {
  // Get the token ID from the verify endpoint
  const response = await r2AdminCB.execute(() =>
    fetch(`${CF_API_BASE}/user/tokens/verify`, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(10_000),
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to verify API token: HTTP ${response.status}`);
  }

  const data = await response.json() as {
    success: boolean;
    result: { id: string; status: string };
  };

  if (!data.success || !data.result?.id) {
    throw new Error('API token verification failed: no token ID returned');
  }

  // Derive S3 Secret Access Key = SHA-256(token value)
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(apiToken));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const secretAccessKey = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    accessKeyId: data.result.id,
    secretAccessKey,
  };
}

/**
 * Get cached R2 credentials from KV, or derive fresh ones from the API token.
 * Results are cached in KV to avoid repeated /user/tokens/verify calls.
 */
export async function getOrCreateR2Credentials(
  email: string,
  apiToken: string,
  bucketName: string,
  kv: KVNamespace
): Promise<R2CredentialResult> {
  const kvKey = `r2token:${email}`;

  const cached = await kv.get(kvKey);
  if (cached) {
    const parsed = JSON.parse(cached) as CachedR2Token;
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
    };
  }

  const result = await deriveR2Credentials(apiToken);

  const kvValue: CachedR2Token = {
    ...result,
    bucketName,
    createdAt: new Date().toISOString(),
  };
  await kv.put(kvKey, JSON.stringify(kvValue));

  return result;
}
