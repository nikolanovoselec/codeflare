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

export function computeKeyMd5(base64Key: string): string {
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
 *
 * REQ-ENTERPRISE-018 (Governed Mode): when `r2SseDisabled` is true the SSE-C
 * headers are suppressed even though ENCRYPTION_KEY is set, so the bucket's
 * objects use R2's default at-rest encryption and stay readable/scannable by
 * the company's security tooling. ENCRYPTION_KEY keeps serving the vault HKDF
 * master and secret-at-rest crypto (those paths never call this) — only R2
 * SSE-C is gated here.
 */
export function getSseHeaders(
  env: { ENCRYPTION_KEY?: string },
  r2SseDisabled = false,
): Record<string, string> {
  if (r2SseDisabled || !env.ENCRYPTION_KEY) return {};

  return {
    'x-amz-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-server-side-encryption-customer-key': env.ENCRYPTION_KEY,
    'x-amz-server-side-encryption-customer-key-MD5': computeKeyMd5(env.ENCRYPTION_KEY),
  };
}

/**
 * Generate SSE-C copy-source headers for S3 CopyObject operations.
 * Required when copying an SSE-C encrypted source object — the primitive the
 * Governed Mode re-encrypt migration uses to decrypt the source on a server-side
 * copy (REQ-ENTERPRISE-020, src/lib/r2-migration.ts). `r2SseDisabled` suppresses
 * them for the same reason as getSseHeaders.
 */
export function getSseCopyHeaders(
  env: { ENCRYPTION_KEY?: string },
  r2SseDisabled = false,
): Record<string, string> {
  if (r2SseDisabled || !env.ENCRYPTION_KEY) return {};

  return {
    'x-amz-copy-source-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-copy-source-server-side-encryption-customer-key': env.ENCRYPTION_KEY,
    'x-amz-copy-source-server-side-encryption-customer-key-MD5': computeKeyMd5(env.ENCRYPTION_KEY),
  };
}
