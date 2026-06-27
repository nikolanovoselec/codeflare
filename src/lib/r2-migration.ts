/**
 * Governed Mode (REQ-ENTERPRISE-018) R2 encryption-regime resolution + lossless
 * re-encrypt migration.
 *
 * Two distinct values drive the SSE-C decision:
 *
 *   - The **deployment policy** (`SETUP_KEYS.R2_SSE_DISABLED`): a single enterprise
 *     wizard toggle. `'active'` ⇒ Governed Mode (SSE-C off bucket-wide); absent ⇒
 *     SSE-C on (the default).
 *   - The **per-bucket regime marker** (`UserPreferences.r2SseRegime`): the regime
 *     a bucket's objects are *actually* stored in right now. The migration below
 *     reconciles the marker to the policy; until it runs, the marker is the truth.
 *
 * Every R2 header choice for a bucket keys off the marker (not the policy) so reads
 * stay correct during the rollout window between an admin flipping the toggle and
 * each bucket being migrated on its next session start.
 */
import type { Env, UserPreferences } from '../types';
import { SETUP_KEYS, getPreferencesKey } from './kv-keys';
import { createR2Client, getR2Url, parseListObjectsXml } from './r2-client';
import { getSseHeaders, getSseCopyHeaders } from './r2-sse';
import { createLogger } from './logger';

const logger = createLogger('r2-migration');

export type R2SseRegime = 'sse-c' | 'plain';

type MigrationEnv = Pick<Env, 'KV'>;

/** R2 credentials + ENCRYPTION_KEY — all the re-encrypt copy loop needs. */
type MigrateR2Env = Pick<Env, 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'ENCRYPTION_KEY'>;

/**
 * S3 CopyObject is a single-request copy capped at 5 GB; larger objects need
 * multipart UploadPartCopy. Agent config / vault / transcripts are tiny, so we
 * fail loud on an oversized object rather than silently skip it (which would
 * leave it in the old regime and break reads once the marker flips).
 */
const COPY_OBJECT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/** The SSE-C read headers required to READ an object stored in the given regime. */
function regimeReadHeaders(env: MigrateR2Env, regime: R2SseRegime): Record<string, string> {
  return getSseHeaders(env, regime === 'plain');
}

/** Percent-encode an object key for the x-amz-copy-source header, preserving '/'. */
function encodeCopySource(bucketName: string, key: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `/${bucketName}/${encodedKey}`;
}

/**
 * Deployment-wide Governed Mode policy. `true` ⇒ R2 SSE-C is disabled for this
 * deployment (new + migrated buckets store objects with R2 default at-rest
 * encryption). Reads the wizard toggle; absent key ⇒ `false` (SSE-C on).
 */
export async function getR2SsePolicyDisabled(env: MigrationEnv): Promise<boolean> {
  return (await env.KV.get(SETUP_KEYS.R2_SSE_DISABLED)) === 'active';
}

/** Translate a policy boolean into the regime a bucket should be in. */
export function regimeForPolicy(policyDisabled: boolean): R2SseRegime {
  return policyDisabled ? 'plain' : 'sse-c';
}

/**
 * The bucket's current encryption regime. Absent marker ⇒ `'sse-c'` (legacy
 * buckets predate Governed Mode and are SSE-C encrypted).
 */
export async function getBucketR2Regime(env: MigrationEnv, bucketName: string): Promise<R2SseRegime> {
  const prefs = await env.KV.get<UserPreferences>(getPreferencesKey(bucketName), 'json');
  return prefs?.r2SseRegime === 'plain' ? 'plain' : 'sse-c';
}

/**
 * Whether SSE-C headers must be suppressed for this bucket right now — i.e. its
 * regime marker is `'plain'`. This is the value every R2 call site threads into
 * getSseHeaders / getSseCopyHeaders for the bucket.
 */
export async function isR2SseDisabledForBucket(env: MigrationEnv, bucketName: string): Promise<boolean> {
  return (await getBucketR2Regime(env, bucketName)) === 'plain';
}

/**
 * Persist the bucket's regime marker, merging into existing preferences so no
 * other field is clobbered (read-modify-write — preferences are small).
 */
export async function setBucketR2Regime(env: MigrationEnv, bucketName: string, regime: R2SseRegime): Promise<void> {
  const key = getPreferencesKey(bucketName);
  const existing = (await env.KV.get<UserPreferences>(key, 'json')) ?? {};
  // An absent marker already means 'sse-c', so stamping 'sse-c' is a no-op — avoids a
  // redundant KV write on every new bucket in the default (non-Governed) path.
  const current: R2SseRegime = existing.r2SseRegime === 'plain' ? 'plain' : 'sse-c';
  if (current === regime) return;
  await env.KV.put(key, JSON.stringify({ ...existing, r2SseRegime: regime }));
}

/**
 * Resolve the SSE-C-disabled flag a seed/write path should use right after
 * ensuring a bucket exists. A freshly created bucket has no objects, so it
 * adopts the current deployment policy and its marker is stamped here; an
 * existing bucket keeps its current marker (session-start migration reconciles
 * it to the policy later). Shared by the lazy-create seed paths.
 */
export async function resolveBucketSseOnEnsure(
  env: MigrationEnv,
  bucketName: string,
  created: boolean,
): Promise<boolean> {
  if (created) {
    const policyDisabled = await getR2SsePolicyDisabled(env);
    await setBucketR2Regime(env, bucketName, regimeForPolicy(policyDisabled));
    return policyDisabled;
  }
  return isR2SseDisabledForBucket(env, bucketName);
}

/**
 * Reconcile a bucket's encryption regime to the deployment policy at session
 * start, returning the resolved SSE-C-disabled flag (the policy) for the seed
 * writes + container env.
 *
 *   - New bucket (just created): adopts the policy; marker stamped, no migration.
 *   - Existing bucket whose marker already matches the policy: no-op.
 *   - Existing bucket whose marker differs: losslessly re-encrypted to the policy,
 *     THEN the marker is flipped — so the marker only ever advances after the
 *     objects are actually in the new regime (reads stay correct).
 *
 * Runs before the container DO is configured, so there is no concurrent writer.
 */
export async function reconcileBucketRegimeOnStart(
  env: MigrationEnv & MigrateR2Env,
  bucketName: string,
  endpoint: string,
  created: boolean,
): Promise<boolean> {
  const policyDisabled = await getR2SsePolicyDisabled(env);
  const targetRegime = regimeForPolicy(policyDisabled);

  if (created) {
    await setBucketR2Regime(env, bucketName, targetRegime);
    return policyDisabled;
  }

  const currentRegime = await getBucketR2Regime(env, bucketName);
  if (currentRegime !== targetRegime) {
    try {
      await migrateBucketEncryption(env, bucketName, endpoint, currentRegime, targetRegime);
    } catch (err) {
      // Migration itself failed — a transient R2/ListObjects error, subrequest-budget
      // exhaustion, an object > 5 GB, or > MAX_PAGES. The objects are still wholly in the
      // CURRENT regime, so boot there (read-correct), do NOT flip the marker, and let the
      // idempotent migration retry next session. Never brick /start over a migration failure.
      logger.error(
        'Governed Mode migration failed; booting in current regime, will retry next session',
        err instanceof Error ? err : new Error(String(err)),
        { bucketName, from: currentRegime, to: targetRegime },
      );
      return currentRegime === 'plain';
    }
    // Migration succeeded — the objects ARE in the target regime now. Advance the marker;
    // if only the marker write fails, the objects are still in target, so boot the TARGET
    // regime (the idempotent migration re-confirms + re-stamps the marker next session).
    try {
      await setBucketR2Regime(env, bucketName, targetRegime);
    } catch (err) {
      logger.warn('Governed Mode regime marker write failed post-migration; objects already in target regime', {
        bucketName,
        to: targetRegime,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return policyDisabled;
}

/**
 * Losslessly re-encrypt every object in a bucket from one regime to the other
 * via in-place server-side CopyObject — the object bytes never leave R2.
 *
 *   - `sse-c` → `plain`: decrypt the source with copy-source SSE-C headers; write
 *     the destination with no SSE-C (R2 default at-rest encryption).
 *   - `plain` → `sse-c`: read the plaintext source; write the destination with
 *     SSE-C headers.
 *
 * `MetadataDirective=COPY` preserves Content-Type and the other system metadata
 * (verified R2-supported), so the copy is lossless; the encryption-attribute
 * change is what makes the same-key self-copy legal.
 *
 * Idempotent and resumable: each object is first probed with a HEAD using the
 * TARGET regime's read headers — a 200 means it is already migrated (a prior
 * partial run, or a completed run whose marker write failed) and is skipped, so
 * re-running after any failure converges instead of erroring on the already-done
 * objects. The caller flips the bucket marker only after this resolves.
 *
 * Bound: one HEAD + one PUT per not-yet-migrated object, capped by the Workers
 * 10,000-subrequest budget (≈4,500 objects) shared with the rest of /start.
 * Oversized objects (>5 GB, beyond single CopyObject) fail loud.
 */
export async function migrateBucketEncryption(
  env: MigrateR2Env,
  bucketName: string,
  endpoint: string,
  from: R2SseRegime,
  to: R2SseRegime,
): Promise<{ migrated: number; skipped: number }> {
  if (from === to) return { migrated: 0, skipped: 0 };

  const r2Client = createR2Client(env);
  const targetReadHeaders = regimeReadHeaders(env, to);
  // Copy headers are identical for every object: decrypt source (only when the
  // source is SSE-C) + encrypt destination (only when the target is SSE-C).
  const copyHeaders: Record<string, string> = {
    'x-amz-metadata-directive': 'COPY',
    ...getSseCopyHeaders(env, from === 'plain'),
    ...getSseHeaders(env, to === 'plain'),
  };

  let migrated = 0;
  let skipped = 0;
  let continuationToken: string | undefined;
  const MAX_PAGES = 100;
  let pages = 0;

  do {
    const listUrl = new URL(getR2Url(endpoint, bucketName));
    listUrl.searchParams.set('list-type', '2');
    listUrl.searchParams.set('max-keys', '1000');
    if (continuationToken) listUrl.searchParams.set('continuation-token', continuationToken);

    const listRes = await r2Client.fetch(listUrl.toString(), { method: 'GET' });
    if (!listRes.ok) {
      throw new Error(`migrateBucketEncryption: ListObjectsV2 failed: HTTP ${listRes.status}`);
    }
    const parsed = parseListObjectsXml(await listRes.text());

    for (const obj of parsed.objects) {
      if (obj.size > COPY_OBJECT_MAX_BYTES) {
        throw new Error(
          `migrateBucketEncryption: object "${obj.key}" is ${obj.size} bytes (> 5 GB single-CopyObject limit); `
          + 'Governed Mode migration cannot re-encrypt it. Remove or shrink it and retry.'
        );
      }
      const url = getR2Url(endpoint, bucketName, obj.key);

      // Idempotence probe: already in the target regime ⇒ readable with target headers.
      const head = await r2Client.fetch(url, { method: 'HEAD', headers: targetReadHeaders });
      if (head.ok) {
        skipped++;
        continue;
      }

      const copyRes = await r2Client.fetch(url, {
        method: 'PUT',
        headers: { 'x-amz-copy-source': encodeCopySource(bucketName, obj.key), ...copyHeaders },
      });
      if (!copyRes.ok) {
        throw new Error(`migrateBucketEncryption: CopyObject "${obj.key}" failed: HTTP ${copyRes.status}`);
      }
      migrated++;
    }

    continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : undefined;
    pages++;
  } while (continuationToken && pages < MAX_PAGES);

  // Fail loud if pagination was truncated with objects still unlisted: the caller
  // flips the regime marker only on a clean return, so returning here would advance
  // the marker over an incompletely-migrated bucket (the unmigrated tail would become
  // unreadable). Throwing keeps the marker un-advanced (and the caller boots in the
  // current regime — see reconcileBucketRegimeOnStart).
  if (continuationToken) {
    throw new Error(
      `migrateBucketEncryption: bucket "${bucketName}" exceeds MAX_PAGES (${MAX_PAGES}); migration incomplete — marker must not advance`
    );
  }

  logger.info('Migrated bucket encryption regime', { bucketName, from, to, migrated, skipped });
  return { migrated, skipped };
}
