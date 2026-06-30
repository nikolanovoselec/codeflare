/**
 * Governed Mode (REQ-ENTERPRISE-018) lossless R2 encryption-regime migration engine.
 *
 * The regime decision + state live in src/lib/r2-regime-state.ts (the `r2-regime:<bucket>`
 * state object). THIS module is the copy engine + the chunked, resumable, self-verifying
 * driver that reconciles a bucket to the deployment policy in BOTH directions
 * (sse-c↔plain) without ever leaving the bucket unreadable.
 *
 * Design (see the ADR): a same-key in-place S3 CopyObject with MetadataDirective=REPLACE
 * (COPY is rejected by R2 for a self-copy) re-supplying the source's system + user
 * metadata; an idempotent target-regime HEAD skip-probe makes every pass resumable; the
 * regime marker advances ONLY after a full verification HEAD-scan. Reads use a dual-regime
 * fallback (resolveReadRegime) so a partially-migrated bucket stays readable, and any
 * stray cross-regime object self-heals via the `mixed-recovery` status.
 *
 * Concurrency: advanceMigration runs in waitUntil on every dashboard poll, so overlapping
 * invocations are expected. `leaseExpiresAt` is a per-chunk in-flight lock claimed at chunk
 * start and released on completion; a crashed chunk's lease expires after MIGRATION_LEASE_MS
 * and the next poll takes over. The lock is best-effort (KV has no CAS) — the idempotent
 * skip-probe + verify-rescan make concurrent advances converge correctly regardless.
 */
import type { Env } from '../types';
import { createR2Client, getR2Url, parseListObjectsXml } from './r2-client';
import { decodeXmlEntities } from './xml-utils';
import { getR2Config } from './r2-config';
import { getSseHeaders, getSseCopyHeaders, computeKeyMd5 } from './r2-sse';
import { createLogger } from './logger';
import {
  type R2SseRegime,
  type RegimeState,
  MIGRATION_LEASE_MS,
  getRegimeState,
  setRegimeState,
  getBucketR2Regime,
  isR2SseDisabledForBucket,
  isBucketMigrating,
  resolveBucketSseOnEnsure,
  getR2SsePolicyDisabled,
  regimeForPolicy,
  resolveReadRegime,
} from './r2-regime-state';

// Re-export the regime helpers so existing importers (storage routes) keep their import path.
export {
  getRegimeState,
  setRegimeState,
  getBucketR2Regime,
  isR2SseDisabledForBucket,
  isBucketMigrating,
  resolveBucketSseOnEnsure,
  resolveReadRegime,
  regimeForPolicy,
  getR2SsePolicyDisabled,
};
export type { R2SseRegime, RegimeState } from './r2-regime-state';

const logger = createLogger('r2-migration');

type MigrateR2Env = Pick<Env, 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'ENCRYPTION_KEY'>;
type DriverEnv = MigrateR2Env & Pick<Env, 'KV' | 'R2_ACCOUNT_ID' | 'R2_ENDPOINT' | 'CLOUDFLARE_API_TOKEN'>;

/** S3 single-request CopyObject caps at 5 GB; larger objects need UploadPartCopy. Agent config/vault/transcripts are tiny, so we record + skip an oversized object rather than wedge the whole migration. */
const COPY_OBJECT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
/** Objects processed per chunk invocation. Small enough that one chunk's R2 round-trips stay well within the Workers subrequest budget and waitUntil wall-clock; the cursor resumes the rest on the next poll. */
const MIGRATION_PAGE_SIZE = 200;
/** Max consecutive verify-phase failures before the migration halts (gated, with lastError) instead of looping. A healthy migration verifies on the first pass (0 failures); a non-zero count means an un-migratable poison/corrupt object that re-migration cannot fix. */
const MAX_VERIFY_RETRIES = 3;
/** System metadata headers preserved across a REPLACE copy (REPLACE drops anything not re-supplied). */
const PRESERVED_HEADERS = ['content-type', 'cache-control', 'content-disposition', 'content-encoding', 'content-language', 'expires'];

function opposite(regime: R2SseRegime): R2SseRegime {
  return regime === 'plain' ? 'sse-c' : 'plain';
}

/** The SSE-C read headers required to READ an object stored in the given regime (plain ⇒ none). */
function regimeReadHeaders(env: MigrateR2Env, regime: R2SseRegime): Record<string, string> {
  return getSseHeaders(env, regime === 'plain');
}

/** Per-segment percent-encode an object key for the x-amz-copy-source header (preserving '/'). */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}
function encodeCopySource(bucketName: string, key: string): string {
  return `/${bucketName}/${encodeKey(key)}`;
}
/** Object URL with the key per-segment-encoded so keys containing #/?/space/unicode resolve correctly. */
function objectUrl(endpoint: string, bucketName: string, key: string): string {
  return `${getR2Url(endpoint, bucketName)}/${encodeKey(key)}`;
}

/** Capture the source object's preservable metadata so a REPLACE copy stays lossless. */
function capturePreservedMetadata(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of PRESERVED_HEADERS) {
    const v = headers.get(h);
    if (v) out[h] = v;
  }
  headers.forEach((v, k) => {
    if (k.toLowerCase().startsWith('x-amz-meta-')) out[k] = v;
  });
  return out;
}

/** Strip the in-flight lease from a state so the next poll proceeds immediately (chunk released). */
function release(state: RegimeState): RegimeState {
  const { leaseExpiresAt: _drop, ...rest } = state;
  return rest;
}

/**
 * Re-encrypt ONE object in place from `from`→`to`. Idempotent: an object already readable
 * under the TARGET regime is skipped. Otherwise: source HEAD (capture metadata + ETag) →
 * same-key PUT with MetadataDirective=REPLACE, copy-source-if-match, the preserved metadata,
 * source-decrypt headers iff from=sse-c, dest-encrypt headers iff to=sse-c. The CopyObject
 * 200 body is parsed for an embedded <Error> (S3 returns 200 with an error body on failure).
 */
async function reEncryptObject(
  client: ReturnType<typeof createR2Client>,
  env: MigrateR2Env,
  endpoint: string,
  bucketName: string,
  key: string,
  from: R2SseRegime,
  to: R2SseRegime,
): Promise<'migrated' | 'skipped'> {
  const url = objectUrl(endpoint, bucketName, key);

  const probe = await client.fetch(url, { method: 'HEAD', headers: regimeReadHeaders(env, to) });
  if (probe.ok) return 'skipped';

  const srcHead = await client.fetch(url, { method: 'HEAD', headers: regimeReadHeaders(env, from) });
  if (!srcHead.ok) {
    throw new Error(`reEncryptObject: source HEAD "${key}" failed: HTTP ${srcHead.status}`);
  }
  const etag = srcHead.headers.get('etag');

  const copyRes = await client.fetch(url, {
    method: 'PUT',
    headers: {
      'x-amz-copy-source': encodeCopySource(bucketName, key),
      ...(etag ? { 'x-amz-copy-source-if-match': etag } : {}),
      'x-amz-metadata-directive': 'REPLACE',
      ...capturePreservedMetadata(srcHead.headers),
      ...getSseCopyHeaders(env, from === 'plain'),
      ...getSseHeaders(env, to === 'plain'),
    },
  });
  if (!copyRes.ok) {
    throw new Error(`reEncryptObject: CopyObject "${key}" failed: HTTP ${copyRes.status}`);
  }
  // CopyObject can return 200 with an embedded <Error> — require a CopyObjectResult + ETag and no Error.
  const body = await copyRes.text();
  if (/<Error[ >]/i.test(body) || !/<CopyObjectResult/i.test(body) || !/<ETag>/i.test(body)) {
    throw new Error(`reEncryptObject: CopyObject "${key}" returned 200 with an error/invalid body`);
  }
  return 'migrated';
}

/**
 * Best-effort abort of every in-flight multipart upload before a migration. Their parts were
 * written in the pre-flip regime; left dangling, a post-migration /complete (or the client's
 * retry) would assemble a stray object in the wrong regime. Failures are swallowed — the verify
 * pass + read self-heal are the correctness backstop; this is defense-in-depth.
 */
async function abortInFlightMultiparts(env: MigrateR2Env, bucketName: string, endpoint: string): Promise<void> {
  const client = createR2Client(env);
  const listRes = await client.fetch(`${getR2Url(endpoint, bucketName)}?uploads`, { method: 'GET' });
  if (!listRes.ok) return;
  const xml = await listRes.text();
  const uploads: Array<{ key: string; uploadId: string }> = [];
  const re = /<Upload>([\s\S]*?)<\/Upload>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const uploadId = m[1].match(/<UploadId>([\s\S]*?)<\/UploadId>/)?.[1];
    if (key && uploadId) uploads.push({ key: decodeXmlEntities(key), uploadId: decodeXmlEntities(uploadId) });
  }
  for (const u of uploads) {
    await client
      .fetch(`${objectUrl(endpoint, bucketName, u.key)}?uploadId=${encodeURIComponent(u.uploadId)}`, { method: 'DELETE' })
      .catch(() => {});
  }
}

/** One bounded page of re-encryption from `cursor`. Returns the next cursor (null ⇒ pass complete) and any oversized keys skipped. */
async function migrateChunk(
  env: MigrateR2Env,
  bucketName: string,
  endpoint: string,
  from: R2SseRegime,
  to: R2SseRegime,
  cursor: string | null,
): Promise<{ migrated: number; skipped: number; nextCursor: string | null; oversized: string[] }> {
  const client = createR2Client(env);
  const listUrl = new URL(getR2Url(endpoint, bucketName));
  listUrl.searchParams.set('list-type', '2');
  listUrl.searchParams.set('max-keys', String(MIGRATION_PAGE_SIZE));
  if (cursor) listUrl.searchParams.set('continuation-token', cursor);
  const listRes = await client.fetch(listUrl.toString(), { method: 'GET' });
  if (!listRes.ok) throw new Error(`migrateChunk: ListObjectsV2 failed: HTTP ${listRes.status}`);
  const parsed = parseListObjectsXml(await listRes.text());

  let migrated = 0;
  let skipped = 0;
  const oversized: string[] = [];
  const failed: string[] = [];
  for (const obj of parsed.objects) {
    if (obj.size > COPY_OBJECT_MAX_BYTES) {
      oversized.push(obj.key);
      continue;
    }
    // Per-object isolation: a single poison/corrupt object (or a key racing a delete) must not
    // abort the whole chunk. It stays unconverted → the verify pass catches it; the bounded
    // verify-retry (MAX_VERIFY_RETRIES) is the backstop against an un-fixable object looping.
    try {
      const r = await reEncryptObject(client, env, endpoint, bucketName, obj.key, from, to);
      if (r === 'migrated') migrated++;
      else skipped++;
    } catch {
      failed.push(obj.key);
    }
  }
  const nextCursor = parsed.isTruncated ? parsed.nextContinuationToken ?? null : null;
  return { migrated, skipped, nextCursor, oversized, failed };
}

/** One bounded page of verification: every object must read 200 under the TARGET regime's headers. */
async function verifyChunk(
  env: MigrateR2Env,
  bucketName: string,
  endpoint: string,
  to: R2SseRegime,
  cursor: string | null,
): Promise<{ ok: boolean; failedKey?: string; nextCursor: string | null }> {
  const client = createR2Client(env);
  const readHeaders = regimeReadHeaders(env, to);
  const listUrl = new URL(getR2Url(endpoint, bucketName));
  listUrl.searchParams.set('list-type', '2');
  listUrl.searchParams.set('max-keys', String(MIGRATION_PAGE_SIZE));
  if (cursor) listUrl.searchParams.set('continuation-token', cursor);
  const listRes = await client.fetch(listUrl.toString(), { method: 'GET' });
  if (!listRes.ok) throw new Error(`verifyChunk: ListObjectsV2 failed: HTTP ${listRes.status}`);
  const parsed = parseListObjectsXml(await listRes.text());

  for (const obj of parsed.objects) {
    // Oversized objects are intentionally skipped by migrateChunk (single CopyObject caps at 5 GB),
    // so verify must skip them too — otherwise an un-migratable object HEAD-fails here and bounces
    // the migration into an endless migrate↔verify loop. They remain readable via the dual-regime
    // read fallback (a known stray, surfaced in lastError, not a wedge).
    if (obj.size > COPY_OBJECT_MAX_BYTES) continue;
    const h = await client.fetch(objectUrl(endpoint, bucketName, obj.key), { method: 'HEAD', headers: readHeaders });
    if (!h.ok) return { ok: false, failedKey: obj.key, nextCursor: cursor };
  }
  const nextCursor = parsed.isTruncated ? parsed.nextContinuationToken ?? null : null;
  return { ok: true, nextCursor };
}

/**
 * Read (GET/HEAD) an object trying the bucket's committed regime first, falling back to the
 * opposite regime once on a 400/403 SSE-mismatch (D2 — a partially-migrated bucket holds
 * objects in both regimes, so reads must try both). `stray` is true when the fallback regime
 * succeeded on a READY bucket: the caller should `waitUntil(markMixedRecovery(...))` so the
 * cross-regime outlier self-heals. Returns the raw R2 Response (streamable body intact).
 */
export async function fetchObjectWithRegimeFallback(
  env: DriverEnv,
  bucketName: string,
  objectUrl: string,
  opts: { method: 'GET' | 'HEAD'; extraHeaders?: Record<string, string> },
): Promise<{ response: Response; stray: boolean; sseDisabled: boolean }> {
  const state = await getRegimeState(env, bucketName);
  const { primary, fallback, selfHealOnFallbackHit } = resolveReadRegime(state);
  const client = createR2Client(env);
  const fetchRegime = (sseDisabled: boolean) =>
    client.fetch(objectUrl, { method: opts.method, headers: { ...opts.extraHeaders, ...getSseHeaders(env, sseDisabled) } });

  const first = await fetchRegime(primary);
  if (first.ok || (first.status !== 400 && first.status !== 403)) {
    return { response: first, stray: false, sseDisabled: primary };
  }
  const second = await fetchRegime(fallback);
  return { response: second, stray: second.ok && selfHealOnFallbackHit, sseDisabled: fallback };
}

/**
 * Full re-encrypt of a bucket (loops chunks to completion). Used by tests and any caller
 * that wants a single blocking pass; the resumable driver below uses migrateChunk directly.
 */
export async function migrateBucketEncryption(
  env: MigrateR2Env,
  bucketName: string,
  endpoint: string,
  from: R2SseRegime,
  to: R2SseRegime,
): Promise<{ migrated: number; skipped: number; oversized: string[] }> {
  if (from === to) return { migrated: 0, skipped: 0, oversized: [] };
  let migrated = 0;
  let skipped = 0;
  const oversized: string[] = [];
  const failed: string[] = [];
  let cursor: string | null = null;
  do {
    const r = await migrateChunk(env, bucketName, endpoint, from, to, cursor);
    migrated += r.migrated;
    skipped += r.skipped;
    oversized.push(...r.oversized);
    failed.push(...r.failed);
    cursor = r.nextCursor;
  } while (cursor);
  // The blocking helper fails loudly so a single-pass caller/test sees the error; the chunked
  // driver (advanceMigration) instead records failures and bounds the retry.
  if (failed.length) throw new Error(`migrateBucketEncryption: ${failed.length} object(s) failed to re-encrypt: ${failed.join(', ')}`);
  return { migrated, skipped, oversized };
}

/**
 * SYNCHRONOUS reconcile decision, run inline in the dashboard batch-status handler so the
 * SAME response reports `migrating`. Continues an in-flight migration, starts a new one
 * (flipping status→migrating), or defers when a container is healthy (D1: no force-kill).
 * The heavy copy work is then run by advanceMigration() in waitUntil.
 */
export async function planRegimeReconcile(
  env: DriverEnv,
  bucketName: string,
  hasHealthyContainer: () => Promise<boolean>,
): Promise<{ state: RegimeState; migrating: boolean; pending: boolean }> {
  const state = await getRegimeState(env, bucketName);
  if (state.status !== 'ready') return { state, migrating: true, pending: false };

  const target = regimeForPolicy(await getR2SsePolicyDisabled(env));
  if (state.regime === target) return { state, migrating: false, pending: false };

  // Migration wanted. D1: never force-kill a running session from a background poll.
  if (await hasHealthyContainer()) return { state, migrating: false, pending: true };

  // Flip to migrating with NO lease — advanceMigration claims the in-flight lease per chunk.
  const next: RegimeState = {
    status: 'migrating',
    regime: state.regime,
    from: state.regime,
    to: target,
    generation: state.generation,
    cursor: null,
    phase: 'migrate',
    drained: false,
    startedAt: new Date().toISOString(),
    // Capture the key fingerprint for rotation detection (D3); omit the field entirely if unset
    // rather than store `undefined` (JSON.stringify would strip it anyway).
    ...(env.ENCRYPTION_KEY ? { keyMd5: computeKeyMd5(env.ENCRYPTION_KEY) } : {}),
  };
  await setRegimeState(env, bucketName, next);
  return { state: next, migrating: true, pending: false };
}

/**
 * Advance an in-flight migration by ONE chunk (run in waitUntil; never throws). Claims the
 * in-flight lease, drains running containers once before the first chunk (the in-container
 * rclone daemon writes R2 directly and cannot be header-gated), runs one migrate or verify
 * page, then releases the lease. The regime marker flips to the target — and generation
 * bumps — only after a full migrate pass AND a full verify pass.
 */
export async function advanceMigration(
  env: DriverEnv,
  bucketName: string,
  deps: { drainContainers: () => Promise<void>; hasHealthyContainer: () => Promise<boolean> },
): Promise<void> {
  try {
    const state = await getRegimeState(env, bucketName);
    if (state.status === 'ready') return;

    // H2 backstop: an un-migratable (poison/corrupt) object exhausted the verify-retry budget.
    // Halt — stay gated with lastError — instead of burning a chunk every poll. (Admin clears the
    // offending object / resets the state object to recover.)
    if ((state.stuckCount ?? 0) >= MAX_VERIFY_RETRIES) return;

    const now = Date.now();
    // In-flight lock: another chunk holds a live lease — let it finish (best-effort; KV has no CAS).
    if (state.leaseExpiresAt && state.leaseExpiresAt > now) return;

    // D3 detect-only: the SSE-C key rotated since the migration started — every copy/HEAD would
    // fail. Halt with a clear error rather than loop forever; old-key fallback is out of scope.
    if (state.keyMd5 && env.ENCRYPTION_KEY && state.keyMd5 !== computeKeyMd5(env.ENCRYPTION_KEY)) {
      await setRegimeState(env, bucketName, release({ ...state, stuckCount: MAX_VERIFY_RETRIES, lastError: 'ENCRYPTION_KEY rotated mid-migration; halted (rotation is detect-only)' }));
      return;
    }

    // D1 (no force-kill): never drain a running session from a background poll. Guards both a normal
    // migration (a container could have raced /start before the gate engaged) AND a read-triggered
    // mixed-recovery (which bypasses planRegimeReconcile's health check). If a container is healthy
    // and we have not drained yet, defer — a later poll runs once the session stops.
    if (!(state.drained ?? false) && await deps.hasHealthyContainer()) return;

    // Claim the lease for this chunk; `myLease` is the optimistic-lock value re-checked at commit.
    const myLease = now + MIGRATION_LEASE_MS;
    await setRegimeState(env, bucketName, { ...state, leaseExpiresAt: myLease });

    const { endpoint } = await getR2Config(env);

    // mixed-recovery heals stray outliers TO the committed regime; a normal migration goes from→to.
    const to: R2SseRegime = state.status === 'mixed-recovery' ? state.regime : state.to ?? state.regime;
    const from: R2SseRegime = state.status === 'mixed-recovery' ? opposite(state.regime) : state.from ?? opposite(to);
    const phase = state.phase ?? 'migrate';

    let drained = state.drained ?? false;
    if (!drained) {
      await deps.drainContainers();
      await abortInFlightMultiparts(env, bucketName, endpoint);
      drained = true;
    }

    let next: RegimeState;
    if (phase === 'migrate') {
      const { nextCursor, oversized, failed } = await migrateChunk(env, bucketName, endpoint, from, to, state.cursor ?? null);
      const notes = [
        oversized.length ? `oversized skipped (need UploadPartCopy): ${oversized.join(', ')}` : '',
        failed.length ? `failed to re-encrypt: ${failed.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      const lastError = notes || state.lastError;
      const base: RegimeState = { ...state, drained, ...(lastError ? { lastError } : {}) };
      next = nextCursor ? { ...base, cursor: nextCursor } : { ...base, phase: 'verify', cursor: null };
    } else {
      const { ok, failedKey, nextCursor } = await verifyChunk(env, bucketName, endpoint, to, state.cursor ?? null);
      if (!ok) {
        // A stray object is not in the target regime — re-run a migrate pass to heal it, but BOUND
        // the bounces: an object that re-migration cannot fix (poison/corrupt) must not loop forever.
        const stuckCount = (state.stuckCount ?? 0) + 1;
        next = {
          ...state, drained, stuckCount, phase: 'migrate', cursor: null,
          lastError: stuckCount >= MAX_VERIFY_RETRIES
            ? `verify failed at ${failedKey} after ${stuckCount} attempts; halting (un-migratable object — admin review)`
            : `verify failed at ${failedKey}; re-migrating`,
        };
      } else if (nextCursor) {
        next = { ...state, drained, cursor: nextCursor };
      } else {
        // Verified clean → flip to ready (drops stuckCount/cursor/phase). A real migration advances
        // the regime + generation; a mixed-recovery only heals.
        next = state.status === 'mixed-recovery'
          ? { status: 'ready', regime: state.regime, generation: state.generation }
          : { status: 'ready', regime: to, generation: state.generation + 1 };
      }
    }

    // M1 optimistic lock: only commit if we STILL hold the lease we claimed. If our lease expired
    // mid-chunk and another poll took over (possibly already finishing the migration), writing our
    // stale snapshot would clobber it — e.g. revert a completed `ready`/gen+1 back to `migrating`.
    const current = await getRegimeState(env, bucketName);
    if (current.leaseExpiresAt !== myLease) return;
    await setRegimeState(env, bucketName, release(next));
    if (next.status === 'ready') {
      logger.info('Governed Mode migration complete', { bucketName, regime: next.regime, generation: next.generation });
    }
  } catch (err) {
    logger.error('advanceMigration chunk failed; will retry next poll', err instanceof Error ? err : new Error(String(err)), { bucketName });
    // Release the lease so the next poll retries soon (idempotent skip-probe re-does only unfinished work).
    const s = await getRegimeState(env, bucketName).catch(() => null);
    if (s && s.status !== 'ready') {
      await setRegimeState(env, bucketName, release({ ...s, lastError: String(err) })).catch(() => {});
    }
  }
}

/**
 * Force a one-time mixed-recovery scan (heals stray cross-regime outliers without changing the
 * committed regime). Triggered opportunistically from the read-path self-heal and the one-time
 * bucket recovery. D1 (no force-kill): if a session container is healthy this defers — flipping to
 * mixed-recovery would gate that live session's writes (and a later poll would drain it). The stray
 * stays readable via the dual-regime fallback; the recovery runs on the next read once quiescent.
 */
export async function markMixedRecovery(
  env: DriverEnv,
  bucketName: string,
  hasHealthyContainer: () => Promise<boolean>,
): Promise<void> {
  const state = await getRegimeState(env, bucketName);
  if (state.status !== 'ready') return; // a migration is already in flight
  if (await hasHealthyContainer()) return; // D1: do not gate/drain a running session for an opportunistic self-heal
  await setRegimeState(env, bucketName, release({
    ...state, status: 'mixed-recovery', phase: 'migrate', cursor: null, drained: false, startedAt: new Date().toISOString(),
  }));
}
