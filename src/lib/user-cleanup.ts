/**
 * Centralized user data cleanup logic.
 *
 * Extracted from the DELETE /api/users/:email handler so it can be
 * reused by setup/configure (stale user removal) and any future
 * user-deletion code paths.
 */
import type { Env, Session } from '../types';
import { getBucketName } from './access';
import { getSessionPrefix, listAllKvKeys, getPresetsKey, getPreferencesKey, getLlmKeysKey, getDeployKeysKey, getTimekeeperKey, SETUP_KEYS } from './kv-keys';
import { getContainerId } from './container-helpers';
import { getContainer } from '@cloudflare/containers';
import { createR2Client, emptyR2Bucket } from './r2-client';
import { getR2Config } from './r2-config';
import { deleteScopedR2Token } from './r2-admin';
import { CF_API_BASE } from './constants';
import { createLogger } from './logger';
import { toError } from './error-types';
import { getAndDecrypt, getOrImportKey } from './kv-crypto';
import { disconnectGithub } from './github-token';

const logger = createLogger('user-cleanup');

interface CleanupResult {
  deletedSessions: number;
  bucketDeleted: boolean;
  tokenDeleted: boolean;
}

/** Normalize defensively — callers should already normalize, but KV keys must match. */
function normalizeCleanupEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Resolve the user's R2 bucket name from their normalized email. */
function resolveCleanupBucket(normalizedEmail: string, env: Env): string {
  return getBucketName(normalizedEmail, env.CLOUDFLARE_WORKER_NAME);
}

/**
 * Block A: destroy every session container and delete its KV entry.
 * Returns the number of session entries deleted.
 */
async function deleteSessionsAndContainers(bucketName: string, env: Env): Promise<number> {
  const sessionPrefix = getSessionPrefix(bucketName);
  const sessionKeys = await listAllKvKeys(env.KV, sessionPrefix);

  let deletedSessions = 0;
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
    deletedSessions++;
  }
  return deletedSessions;
}

/** Blocks B + B2: delete the user record and all bucket-keyed KV entries. */
async function deleteUserKvEntries(normalizedEmail: string, bucketName: string, env: Env): Promise<void> {
  // --- Block B: User KV deletion ---
  await env.KV.delete(`user:${normalizedEmail}`);

  // --- Block B2: Bucket-keyed KV cleanup ---
  await Promise.all([
    env.KV.delete(`storage-stats:${bucketName}`),
    env.KV.delete(getPresetsKey(bucketName)),
    env.KV.delete(getPreferencesKey(bucketName)),
    env.KV.delete(getLlmKeysKey(bucketName)),
    env.KV.delete(getDeployKeysKey(bucketName)),
    env.KV.delete(getTimekeeperKey(bucketName)),
  ]);
}

/**
 * Block C: revoke the scoped R2 token via CF API and delete its KV entry.
 * Returns true when a scoped token was revoked.
 */
async function deleteR2Token(
  normalizedEmail: string,
  accountId: string | null,
  r2TokenData: { tokenId?: string; accessKeyId?: string; secretAccessKey?: string } | null,
  email: string,
  env: Env,
): Promise<boolean> {
  let tokenDeleted = false;
  try {
    if (r2TokenData?.tokenId && accountId && env.CLOUDFLARE_API_TOKEN) {
      await deleteScopedR2Token(accountId, env.CLOUDFLARE_API_TOKEN, r2TokenData.tokenId);
      tokenDeleted = true;
    }
  } catch (err) {
    logger.warn('Failed to delete scoped R2 token during user deletion', { email, error: String(err) });
  }
  try {
    await env.KV.delete(`r2token:${normalizedEmail}`);
  } catch (err) {
    logger.warn('Failed to delete r2token KV entry', { email, error: String(err) });
  }
  return tokenDeleted;
}

/**
 * Block D: empty the user's R2 bucket then delete it via CF API.
 * Returns true when the bucket was deleted.
 */
async function deleteR2Bucket(
  bucketName: string,
  accountId: string | null,
  email: string,
  env: Env,
): Promise<boolean> {
  let bucketDeleted = false;
  try {
    if (accountId && env.CLOUDFLARE_API_TOKEN) {
      // Try to empty bucket via S3 API using worker-level R2 credentials
      let objectsDeleted = 0;
      try {
        if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
          const r2Client = createR2Client(env);
          const { endpoint } = await getR2Config(env);
          objectsDeleted = await emptyR2Bucket(r2Client, endpoint, bucketName);
          if (objectsDeleted > 0) {
            logger.info('Emptied R2 bucket before deletion', { bucketName, deletedCount: objectsDeleted });
          }
        }
      } catch (err) {
        logger.debug('R2 bucket empty attempt failed (non-fatal)', { email, error: String(err) });
      }

      // Delete the empty bucket via CF API (retry with delay for R2 eventual consistency)
      const maxAttempts = objectsDeleted > 0 ? 3 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Wait for R2 to propagate empty state (skip on first attempt or if bucket was already empty)
        if (attempt > 1) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }

        const res = await fetch(`${CF_API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        });

        if (res.ok) {
          bucketDeleted = true;
          logger.info('Deleted R2 bucket', { bucketName, attempt });
          break;
        }

        const body = await res.text().catch(() => '');
        const notEmpty = body.includes('not empty') || body.includes('BucketNotEmpty');

        if (notEmpty && attempt < maxAttempts) {
          logger.debug('R2 bucket not yet empty, retrying', { bucketName, attempt, maxAttempts });
          continue;
        }

        if (notEmpty) {
          logger.warn('R2 bucket still not empty after retries', { bucketName, email, attempts: maxAttempts });
        } else {
          logger.error('Failed to delete R2 bucket', new Error(`HTTP ${res.status}: ${body}`), { bucketName });
        }
      }
    }
  } catch (err) {
    logger.error('Failed to delete R2 bucket', toError(err));
  }
  return bucketDeleted;
}

/**
 * Remove all data associated with a user: sessions, containers, KV entries,
 * scoped R2 token, and R2 bucket.
 *
 * Does NOT handle auth checks, rate limiting, or Access policy sync —
 * callers are responsible for those concerns.
 */
export async function cleanupUserData(email: string, env: Env): Promise<CleanupResult> {
  const normalizedEmail = normalizeCleanupEmail(email);
  const bucketName = resolveCleanupBucket(normalizedEmail, env);

  // --- Block A: Session + Container cleanup ---
  const deletedSessions = await deleteSessionsAndContainers(bucketName, env);

  // --- Block A2: GitHub token revoke (REQ-GITHUB-005 offboarding) ---
  // Revoke the user's GitHub token AT GitHub (for app/oauth sources) BEFORE the
  // deploy-keys KV entry that holds it is deleted in Block B2 below. Offboarding
  // applies the same revoke+clear contract as POST /api/github/disconnect, so a
  // leaked-but-not-yet-deleted token cannot outlive the account. Best-effort:
  // disconnectGithub already swallows GitHub-side revoke errors, and this guard
  // ensures a decrypt/lookup failure never blocks account deletion.
  try {
    await disconnectGithub(env, bucketName);
  } catch (err) {
    logger.warn('Failed to revoke GitHub token during user deletion', { email, error: String(err) });
  }

  // --- Blocks B + B2: User + bucket-keyed KV deletion ---
  await deleteUserKvEntries(normalizedEmail, bucketName, env);

  // --- Read R2 token data ONCE before cleanup (used by Block C and D) ---
  // Must use getAndDecrypt — r2token values are encrypted when ENCRYPTION_KEY is set.
  // Raw KV.get('json') throws SyntaxError on the "v1:..." ciphertext prefix.
  const accountId = await env.KV.get(SETUP_KEYS.ACCOUNT_ID);
  const cryptoKey = await getOrImportKey(env);
  const r2TokenData = await getAndDecrypt<{ tokenId?: string; accessKeyId?: string; secretAccessKey?: string }>(env.KV, `r2token:${normalizedEmail}`, cryptoKey);

  // --- Block C: R2 scoped token cleanup ---
  const tokenDeleted = await deleteR2Token(normalizedEmail, accountId, r2TokenData, email, env);

  // --- Block D: R2 bucket empty + delete ---
  const bucketDeleted = await deleteR2Bucket(bucketName, accountId, email, env);

  return { deletedSessions, bucketDeleted, tokenDeleted };
}
