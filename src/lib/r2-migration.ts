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
import { getR2Config } from './r2-config';
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

/** KV key for the per-bucket migration lock (dedupes concurrent first-login triggers). */
function migrationLockKey(bucketName: string): string {
  return `r2-migration-lock:${bucketName}`;
}

/** A migration pass for any reasonable bucket finishes well within this; a crashed pass retries after it expires. */
const MIGRATION_LOCK_TTL_S = 600;

/**
 * Reconcile a bucket's encryption regime to the deployment policy on first login
 * (REQ-ENTERPRISE-018) — the dashboard initial-load trigger that mirrors the
 * REQ-AGENT-049 preseed-hash upgrade. The lossless re-encrypt runs HERE, in the
 * BACKGROUND (the caller registers the returned promise with waitUntil), NOT on the
 * container-start path: a slow re-encrypt must never block session creation, and at
 * login no container is running yet so there is no concurrent writer.
 *
 *   - Marker already matches the policy ⇒ no-op (one/two KV reads). The common path
 *     for every non-Governed deployment and every already-migrated bucket.
 *   - Marker differs ⇒ losslessly re-encrypt, then flip the marker ONLY after a fully-
 *     complete pass — so until then every session keeps booting in the CURRENT regime
 *     (reads stay correct). A pass that exhausts the Workers subrequest budget on a huge
 *     bucket simply resumes on the next login (the HEAD-probe skips already-migrated
 *     objects).
 *
 * Never throws — a failure is logged, the marker is left un-advanced, and the migration
 * retries on the next login.
 */
export async function reconcileBucketRegimeOnLogin(
  env: MigrationEnv & MigrateR2Env & Pick<Env, 'R2_ACCOUNT_ID' | 'R2_ENDPOINT' | 'CLOUDFLARE_API_TOKEN'>,
  bucketName: string,
): Promise<void> {
  const targetRegime = regimeForPolicy(await getR2SsePolicyDisabled(env));
  const currentRegime = await getBucketR2Regime(env, bucketName);
  if (currentRegime === targetRegime) return;

  // Dedupe concurrent triggers (multiple tabs, or a reload during a slow pass). KV has no
  // atomic compare-and-set, but the migration is idempotent so a rare double-run is merely
  // wasteful, never incorrect.
  const lockKey = migrationLockKey(bucketName);
  if (await env.KV.get(lockKey)) return;
  await env.KV.put(lockKey, '1', { expirationTtl: MIGRATION_LOCK_TTL_S });

  try {
    const { endpoint } = await getR2Config(env);
    await migrateBucketEncryption(env, bucketName, endpoint, currentRegime, targetRegime);
    // Flip the marker only on a clean, complete pass — the objects ARE in the target regime now.
    await setBucketR2Regime(env, bucketName, targetRegime);
    logger.info('Governed Mode bucket migrated on login', { bucketName, from: currentRegime, to: targetRegime });
  } catch (err) {
    logger.error(
      'Governed Mode login migration failed; marker left un-advanced, will retry next login',
      err instanceof Error ? err : new Error(String(err)),
      { bucketName, from: currentRegime, to: targetRegime },
    );
  } finally {
    await env.KV.delete(lockKey);
  }
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
  // unreadable). Throwing keeps the marker un-advanced (and the bucket keeps booting in
  // the current regime until a later login completes a full pass — see
  // reconcileBucketRegimeOnLogin).
  if (continuationToken) {
    throw new Error(
      `migrateBucketEncryption: bucket "${bucketName}" exceeds MAX_PAGES (${MAX_PAGES}); migration incomplete — marker must not advance`
    );
  }

  logger.info('Migrated bucket encryption regime', { bucketName, from, to, migrated, skipped });
  return { migrated, skipped };
}
