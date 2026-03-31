/**
 * R2 SSE-C (Server-Side Encryption with Customer-Provided Keys) header generation.
 *
 * When ENCRYPTION_KEY is set, generates the required S3-compatible headers
 * for encrypting/decrypting R2 objects at rest. Used by storage routes and r2-seed.
 */

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** Cache computed MD5 to avoid recomputation on repeated calls */
let cachedMd5Source: string | null = null;
let cachedMd5B64: string | null = null;

function computeKeyMd5(base64Key: string): string {
  if (cachedMd5Source === base64Key && cachedMd5B64) return cachedMd5B64;

  const rawKey = Buffer.from(base64Key, 'base64');
  if (rawKey.byteLength !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to exactly 32 bytes for SSE-C, got ${rawKey.byteLength}`);
  }
  const md5 = createHash('md5').update(rawKey).digest('base64');
  cachedMd5B64 = md5;
  cachedMd5Source = base64Key;
  return md5;
}

/**
 * Generate SSE-C headers for R2 PUT/GET/HEAD operations.
 * Returns empty object when ENCRYPTION_KEY is not set.
 */
export function getSseHeaders(
  env: { ENCRYPTION_KEY?: string },
): Record<string, string> {
  if (!env.ENCRYPTION_KEY) return {};

  return {
    'x-amz-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-server-side-encryption-customer-key': env.ENCRYPTION_KEY,
    'x-amz-server-side-encryption-customer-key-MD5': computeKeyMd5(env.ENCRYPTION_KEY),
  };
}

/**
 * Generate SSE-C copy-source headers for S3 CopyObject operations.
 * Required when copying an SSE-C encrypted object (e.g., move.ts).
 */
export function getSseCopyHeaders(
  env: { ENCRYPTION_KEY?: string },
): Record<string, string> {
  if (!env.ENCRYPTION_KEY) return {};

  return {
    'x-amz-copy-source-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-copy-source-server-side-encryption-customer-key': env.ENCRYPTION_KEY,
    'x-amz-copy-source-server-side-encryption-customer-key-MD5': computeKeyMd5(env.ENCRYPTION_KEY),
  };
}
