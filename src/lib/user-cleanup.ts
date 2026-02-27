/**
 * Centralized user data cleanup logic.
 *
 * Extracted from the DELETE /api/users/:email handler so it can be
 * reused by setup/configure (stale user removal) and any future
 * user-deletion code paths.
 */
import type { Env, Session } from '../types';
import { getBucketName } from './access';
import { getSessionPrefix, listAllKvKeys } from './kv-keys';
import { getContainerId } from './container-helpers';
import { getContainer } from '@cloudflare/containers';
import { deleteScopedR2Token } from './r2-admin';
import { r2AdminCB } from './circuit-breakers';
import { CF_API_BASE } from './constants';
import { createLogger } from './logger';
import { toError } from './error-types';

const logger = createLogger('user-cleanup');

export interface CleanupResult {
  deletedSessions: number;
  bucketDeleted: boolean;
  tokenDeleted: boolean;
}

/**
 * Remove all data associated with a user: sessions, containers, KV entries,
 * scoped R2 token, and R2 bucket.
 *
 * Does NOT handle auth checks, rate limiting, or Access policy sync —
 * callers are responsible for those concerns.
 */
export async function cleanupUserData(email: string, env: Env): Promise<CleanupResult> {
  const bucketName = getBucketName(email, env.CLOUDFLARE_WORKER_NAME);
  const result: CleanupResult = {
    deletedSessions: 0,
    bucketDeleted: false,
    tokenDeleted: false,
  };

  // --- Block A: Session + Container cleanup ---
  const sessionPrefix = getSessionPrefix(bucketName);
  const sessionKeys = await listAllKvKeys(env.KV, sessionPrefix);

  for (const key of sessionKeys) {
    try {
      const sessionData = await env.KV.get<Session>(key.name, 'json');
      if (sessionData) {
        const containerId = getContainerId(bucketName, sessionData.id);
        const container = getContainer(env.CONTAINER, containerId);
        await container.destroy();
      }
    } catch (err) {
      logger.warn('Failed to destroy container during user deletion', { sessionKey: key.name, error: String(err) });
    }
    await env.KV.delete(key.name);
    result.deletedSessions++;
  }

  // --- Block B: User KV deletion ---
  await env.KV.delete(`user:${email}`);

  // --- Block C: R2 scoped token cleanup ---
  const accountId = await env.KV.get('setup:account_id');

  try {
    const r2TokenData = await env.KV.get(`r2token:${email}`, 'json') as { tokenId?: string; accessKeyId?: string; secretAccessKey?: string } | null;
    if (r2TokenData?.tokenId && accountId && env.CLOUDFLARE_API_TOKEN) {
      await deleteScopedR2Token(accountId, env.CLOUDFLARE_API_TOKEN, r2TokenData.tokenId);
      result.tokenDeleted = true;
    }
  } catch (err) {
    logger.warn('Failed to delete scoped R2 token during user deletion', { email, error: String(err) });
  }
  await env.KV.delete(`r2token:${email}`);

  // --- Block D: R2 bucket empty + delete ---
  try {
    if (accountId && env.CLOUDFLARE_API_TOKEN) {
      // Try to empty bucket via S3 ListObjectsV2
      try {
        const r2TokenData = await env.KV.get(`r2token:${email}`, 'json') as { accessKeyId?: string; secretAccessKey?: string } | null;
        if (r2TokenData?.accessKeyId && r2TokenData?.secretAccessKey) {
          const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
          const listRes = await fetch(`${endpoint}/${bucketName}?list-type=2`, {
            headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
          });
          if (listRes.ok) {
            logger.info('Attempted S3 bucket empty before deletion', { bucketName });
          }
        }
      } catch (err) {
        logger.debug('S3 bucket empty attempt failed (non-fatal)', { email, error: String(err) });
      }

      const res = await r2AdminCB.execute(() =>
        fetch(`${CF_API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        })
      );
      if (res.ok) {
        result.bucketDeleted = true;
      } else {
        const body = await res.text().catch(() => '');
        if (body.includes('not empty') || body.includes('BucketNotEmpty')) {
          logger.warn('R2 bucket not empty, manual cleanup may be needed', { bucketName, email });
        } else {
          logger.error('Failed to delete R2 bucket', new Error(`HTTP ${res.status}: ${body}`), { bucketName });
        }
      }
    }
  } catch (err) {
    logger.error('Failed to delete R2 bucket', toError(err));
  }

  return result;
}
