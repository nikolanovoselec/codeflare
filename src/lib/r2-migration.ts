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
 * metadata; a single source-regime HEAD (a 400/403 SSE-mismatch ⇒ already in the target
 * regime ⇒ skip) makes every object idempotent and a `start-after` key cursor makes every
 * pass resumable; the regime marker advances ONLY after a full verification HEAD-scan. Reads
 * use a dual-regime fallback (resolveReadRegime) so a partially-migrated bucket stays
 * readable, and any stray cross-regime object self-heals via the `mixed-recovery` status.
 *
 * Concurrency: advanceMigration runs in waitUntil on every dashboard poll, so overlapping
 * invocations are expected. `leaseExpiresAt` is a per-chunk in-flight lock claimed at chunk
 * start and released on completion; a crashed chunk's lease expires after MIGRATION_LEASE_MS
 * and the next poll takes over. The lock is best-effort (KV has no CAS) — the idempotent
 * source-HEAD skip + verify-rescan make concurrent advances converge correctly regardless.
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
/** Concurrent R2 ops per slice (Cloudflare caps simultaneous outgoing connections per invocation at 6). */
const MIGRATION_CONCURRENCY = 6;
/** Objects requested per ListObjectsV2. Large: a poll's work is bounded per-SLICE by the wall-clock
 * deadline below, NOT by page size, so a single list call can feed an entire small bucket in one poll. */
const LIST_PAGE_SIZE = 1_000;
/** Max list pages the one-time progress-% object count will scan (≈ COUNT_LIST_CAP × LIST_PAGE_SIZE objects).
 * A bucket larger than this reports no % (the migration still runs); keeps the count cheap for realistic
 * hundreds-to-low-thousands buckets while capping the one-time cost on a pathologically large one. */
const COUNT_LIST_CAP = 50;
/** Per-op R2 timeouts (fetchWithTimeout also AbortController-cancels a timed-out op so its connection
 * frees immediately). Sized for the tiny objects this migrates — generous but realistic. */
const LIST_TIMEOUT_MS = 2_000;
const HEAD_TIMEOUT_MS = 2_000;
const COPY_TIMEOUT_MS = 4_000;
/** Worst-case wall-clock of ONE concurrent slice: a migrate slice is HEAD-then-CopyObject per object;
 * a verify slice is one HEAD. The gate reserves this so the LAST slice it starts still finishes before
 * the platform kill. */
export const MIGRATE_SLICE_MS = HEAD_TIMEOUT_MS + COPY_TIMEOUT_MS; // 6s
const VERIFY_SLICE_MS = HEAD_TIMEOUT_MS; // 2s
/** Bound the one-time container drain (an injected dep with no internal timeout) so a hung
 * container.destroy() can't consume the whole waitUntil window and strand the lease via a force-kill. */
const DRAIN_TIMEOUT_MS = 10_000;
/** Stop STARTING R2 work at this point in the ~30s ctx.waitUntil window. The last started slice
 * (≤ MIGRATE_SLICE_MS) plus the final KV release then land with room to spare before the kill, so the
 * lease is always released voluntarily (a force-kill would skip the release and stall the migration). */
export const WORK_DEADLINE_MS = 22_000;
/** Hard per-invocation R2 subrequest cap (Workers' platform limit is higher; this keeps a wide margin).
 * Bounds objects/invocation only when R2 is fast enough to outrun the time gate; exceeding it would
 * throw (catchable) and release the lease, so it is a backstop, not the primary bound. */
const MAX_SUBREQUESTS = 900;
/** Max consecutive verify-phase failures before the migration halts (gated, with lastError) instead of looping. A healthy migration verifies on the first pass (0 failures); a non-zero count means an un-migratable poison/corrupt object that re-migration cannot fix. */
const MAX_VERIFY_RETRIES = 3;
/** System metadata headers preserved across a REPLACE copy (REPLACE drops anything not re-supplied). */
const PRESERVED_HEADERS = ['content-type', 'cache-control', 'content-disposition', 'content-encoding', 'content-language', 'expires'];

function opposite(regime: R2SseRegime): R2SseRegime {
  return regime === 'plain' ? 'sse-c' : 'plain';
}

/** Run `fn` over `items` in bounded-concurrency batches (mirrors sync-fanout's slice + Promise.all). Preserves input order. */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

/**
 * Process `items` in MIGRATION_CONCURRENCY-sized slices, stopping early once `maxObjects` is reached or
 * `timeOk()` goes false. The FIRST slice always runs (forward progress is guaranteed even right at the
 * deadline); the gate is checked only before each SUBSEQUENT slice. Returns the results of exactly the
 * items processed (in order), so `results.length < items.length` signals a mid-page bail and the last
 * result's key is the resume checkpoint.
 */
async function processSlices<T, R>(items: T[], maxObjects: number, timeOk: () => boolean, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += MIGRATION_CONCURRENCY) {
    if (i > 0 && (out.length >= maxObjects || !timeOk())) break;
    out.push(...(await Promise.all(items.slice(i, i + MIGRATION_CONCURRENCY).map(fn))));
  }
  return out;
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
/**
 * Race an R2 op against a timeout so a single hung request can't hold the migration lease until the
 * isolate is force-killed (a kill skips the lease-release path, stalling the migration). On timeout
 * the op rejects; migrateChunk records the key as `failed` and the verify pass heals it next round.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * R2 fetch with a hard per-op timeout. On timeout `withTimeout` rejects AND we `AbortController.abort()`
 * the in-flight request so its outgoing connection is released immediately (rather than lingering until
 * it settles and piling up against the 6-connection-per-invocation cap). The signal is passed into the
 * request so a runtime that honors it cancels the socket; the race is the guaranteed-reject backstop.
 */
async function fetchWithTimeout(
  client: ReturnType<typeof createR2Client>,
  url: string,
  init: RequestInit,
  ms: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  try {
    return await withTimeout(client.fetch(url, { ...init, signal: controller.signal }), ms, label);
  } catch (err) {
    controller.abort();
    throw err;
  }
}

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

  // ONE source-regime HEAD does both jobs (capture metadata AND decide skip): 200 ⇒ readable as the
  // source regime ⇒ migrate it; 400/403 ⇒ SSE-regime mismatch ⇒ already in the TARGET regime ⇒ skip
  // (the same discriminator resolveReadRegime uses). The verify pass is authoritative — a mis-skip is
  // re-migrated, never committed — so the skip never needs a separate probe HEAD. Any other status is a
  // real error: throw so migrateChunk records it `failed` and the verify pass heals it.
  const srcHead = await fetchWithTimeout(client, url, { method: 'HEAD', headers: regimeReadHeaders(env, from) }, HEAD_TIMEOUT_MS, `source HEAD ${key}`);
  if (srcHead.status === 400 || srcHead.status === 403) return 'skipped';
  if (!srcHead.ok) {
    throw new Error(`reEncryptObject: source HEAD "${key}" failed: HTTP ${srcHead.status}`);
  }
  const etag = srcHead.headers.get('etag');

  const copyRes = await fetchWithTimeout(client, url, {
    method: 'PUT',
    headers: {
      'x-amz-copy-source': encodeCopySource(bucketName, key),
      ...(etag ? { 'x-amz-copy-source-if-match': etag } : {}),
      'x-amz-metadata-directive': 'REPLACE',
      ...capturePreservedMetadata(srcHead.headers),
      ...getSseCopyHeaders(env, from === 'plain'),
      ...getSseHeaders(env, to === 'plain'),
    },
  }, COPY_TIMEOUT_MS, `CopyObject ${key}`);
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
  // Bounded in BOTH per-op AND aggregate wall-clock: this runs inside the same waitUntil window (before
  // the first page on the first invocation), so it must not consume the budget and strand the lease.
  // The list is capped (`max-uploads`) and the aborts run with the same bounded concurrency as a page
  // (not a sequential await-loop), so the whole drain is ≈ list + one concurrent batch. Any uploads
  // beyond the cap are left for the verify-rescan + read self-heal (a stray assembled by a late
  // /complete reads back via the dual-regime fallback) — this is defense-in-depth, not the backstop.
  // Failures are swallowed.
  const listRes = await fetchWithTimeout(client, `${getR2Url(endpoint, bucketName)}?uploads&max-uploads=100`, { method: 'GET' }, LIST_TIMEOUT_MS, 'abortMultiparts list').catch(() => null);
  if (!listRes || !listRes.ok) return;
  const xml = await listRes.text();
  const uploads: Array<{ key: string; uploadId: string }> = [];
  const re = /<Upload>([\s\S]*?)<\/Upload>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const uploadId = m[1].match(/<UploadId>([\s\S]*?)<\/UploadId>/)?.[1];
    if (key && uploadId) uploads.push({ key: decodeXmlEntities(key), uploadId: decodeXmlEntities(uploadId) });
  }
  await mapConcurrent(uploads, MIGRATION_CONCURRENCY, async (u) => {
    await fetchWithTimeout(client, `${objectUrl(endpoint, bucketName, u.key)}?uploadId=${encodeURIComponent(u.uploadId)}`, { method: 'DELETE' }, HEAD_TIMEOUT_MS, `abortMultipart ${u.key}`)
      .catch(() => {});
  });
}

/**
 * One re-encrypt page from `startAfter` (a key; null ⇒ start of pass). Lists up to LIST_PAGE_SIZE objects
 * and re-encrypts them in concurrency-sized slices, stopping early once the per-slice time/object budget
 * in `limits` is hit. Returns counts, the resume key (last object processed), and `done` (the whole pass
 * is complete: this list page finished AND nothing remains beyond it).
 */
async function migrateChunk(
  env: MigrateR2Env,
  bucketName: string,
  endpoint: string,
  from: R2SseRegime,
  to: R2SseRegime,
  startAfter: string | null,
  limits: { deadline: number; maxObjects: number },
): Promise<{ migrated: number; skipped: number; oversized: string[]; failed: string[]; processed: number; lastKey: string | null; done: boolean }> {
  const client = createR2Client(env);
  const listUrl = new URL(getR2Url(endpoint, bucketName));
  listUrl.searchParams.set('list-type', '2');
  listUrl.searchParams.set('max-keys', String(LIST_PAGE_SIZE));
  if (startAfter) listUrl.searchParams.set('start-after', startAfter);
  const listRes = await fetchWithTimeout(client, listUrl.toString(), { method: 'GET' }, LIST_TIMEOUT_MS, 'migrateChunk list');
  if (!listRes.ok) throw new Error(`migrateChunk: ListObjectsV2 failed: HTTP ${listRes.status}`);
  const parsed = parseListObjectsXml(await listRes.text());

  // Per-object isolation: a poison/corrupt object (or a key racing a delete) is recorded in `failed`
  // and never aborts the slice — the verify pass catches it; the bounded verify-retry is the backstop.
  const results = await processSlices(parsed.objects, limits.maxObjects, () => Date.now() + MIGRATE_SLICE_MS <= limits.deadline, async (obj) => {
    if (obj.size > COPY_OBJECT_MAX_BYTES) return { kind: 'oversized' as const, key: obj.key };
    try {
      // Carry the key on every result so the union is uniform — otherwise migrated/skipped lacks `key`
      // and the `failed` branch widens r.key to `string | undefined` (tsc TS2345).
      return { kind: await reEncryptObject(client, env, endpoint, bucketName, obj.key, from, to), key: obj.key };
    } catch {
      return { kind: 'failed' as const, key: obj.key };
    }
  });

  let migrated = 0;
  let skipped = 0;
  const oversized: string[] = [];
  const failed: string[] = [];
  for (const r of results) {
    if (r.kind === 'migrated') migrated++;
    else if (r.kind === 'skipped') skipped++;
    else if (r.kind === 'oversized') oversized.push(r.key);
    else failed.push(r.key);
  }
  const processed = results.length;
  const lastKey = processed > 0 ? results[processed - 1].key : startAfter ?? null;
  // done only when this list page was fully processed AND nothing remains beyond it; a mid-page bail
  // (processed < parsed.objects.length) leaves `lastKey` as the resume point for the next poll.
  const done = processed === parsed.objects.length && !parsed.isTruncated;
  return { migrated, skipped, oversized, failed, processed, lastKey, done };
}

/** Count every object via list-only ListObjectsV2 pages (no per-object ops) — the denominator for the
 * migration progress %. Cheap: one request per LIST_PAGE_SIZE keys. Bounded to `maxPages`; a larger bucket
 * (or a failed list, or running out of the wall-clock `deadline`) returns `total: null` so the caller
 * shows no % rather than burning the invocation budget. `pages` is returned so the caller can charge the
 * subrequests against its budget. */
async function countObjects(
  env: MigrateR2Env,
  bucketName: string,
  endpoint: string,
  maxPages: number,
  deadline: number,
): Promise<{ total: number | null; pages: number }> {
  const client = createR2Client(env);
  let cursor: string | null = null;
  let total = 0;
  let pages = 0;
  do {
    // Runs BEFORE the one-time drained-commit, so it must not consume the whole ~30s waitUntil window
    // (which would strand that commit → the drain re-triggers next poll). Bail to `total: null` (⇒ no %)
    // once another list would not finish within the shared work deadline.
    if (Date.now() + LIST_TIMEOUT_MS > deadline) return { total: null, pages };
    const listUrl = new URL(getR2Url(endpoint, bucketName));
    listUrl.searchParams.set('list-type', '2');
    listUrl.searchParams.set('max-keys', String(LIST_PAGE_SIZE));
    if (cursor) listUrl.searchParams.set('start-after', cursor);
    const res = await fetchWithTimeout(client, listUrl.toString(), { method: 'GET' }, LIST_TIMEOUT_MS, 'countObjects list');
    pages++;
    if (!res.ok) return { total: null, pages };
    const parsed = parseListObjectsXml(await res.text());
    total += parsed.objects.length;
    if (!parsed.isTruncated) return { total, pages };
    cursor = parsed.objects.length ? parsed.objects[parsed.objects.length - 1].key : null;
  } while (cursor && pages < maxPages);
  return { total: null, pages }; // exceeded maxPages ⇒ no %
}

/** One verification page from `startAfter`: every object must read 200 under the TARGET regime's
 *  headers. Slice-gated like migrateChunk; returns the resume key and `done` (whole bucket verified). */
async function verifyChunk(
  env: MigrateR2Env,
  bucketName: string,
  endpoint: string,
  to: R2SseRegime,
  startAfter: string | null,
  limits: { deadline: number; maxObjects: number },
): Promise<{ ok: boolean; failedKey?: string; processed: number; lastKey: string | null; done: boolean }> {
  const client = createR2Client(env);
  const readHeaders = regimeReadHeaders(env, to);
  const listUrl = new URL(getR2Url(endpoint, bucketName));
  listUrl.searchParams.set('list-type', '2');
  listUrl.searchParams.set('max-keys', String(LIST_PAGE_SIZE));
  if (startAfter) listUrl.searchParams.set('start-after', startAfter);
  const listRes = await fetchWithTimeout(client, listUrl.toString(), { method: 'GET' }, LIST_TIMEOUT_MS, 'verifyChunk list');
  if (!listRes.ok) throw new Error(`verifyChunk: ListObjectsV2 failed: HTTP ${listRes.status}`);
  const parsed = parseListObjectsXml(await listRes.text());

  // Process over the FULL object list so the resume key advances past skipped objects too. Oversized
  // objects are intentionally skipped by migrateChunk (single CopyObject caps at 5 GB), so verify
  // treats them as ok — otherwise an un-migratable object HEAD-fails here and bounces the migration
  // into an endless migrate↔verify loop. They remain readable via the dual-regime read fallback.
  const results = await processSlices(parsed.objects, limits.maxObjects, () => Date.now() + VERIFY_SLICE_MS <= limits.deadline, async (obj) => {
    if (obj.size > COPY_OBJECT_MAX_BYTES) return { key: obj.key, ok: true };
    const h = await fetchWithTimeout(client, objectUrl(endpoint, bucketName, obj.key), { method: 'HEAD', headers: readHeaders }, HEAD_TIMEOUT_MS, `verify HEAD ${obj.key}`);
    return { key: obj.key, ok: h.ok };
  });

  const processed = results.length;
  const lastKey = processed > 0 ? results[processed - 1].key : startAfter ?? null;
  const bad = results.find((r) => !r.ok);
  if (bad) return { ok: false, failedKey: bad.key, processed, lastKey, done: false };
  const done = processed === parsed.objects.length && !parsed.isTruncated;
  return { ok: true, processed, lastKey, done };
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
  // An oversized object is intentionally never migrated (single CopyObject caps at 5 GB), so a
  // mixed-recovery scan would re-skip it and re-flag it on every read — a pointless loop. Don't
  // self-heal a known-oversized stray (best-effort: a range read reports a partial length, which
  // just falls back to the prior behavior).
  const oversized = Number(second.headers.get('content-length') ?? '0') > COPY_OBJECT_MAX_BYTES;
  return { response: second, stray: second.ok && selfHealOnFallbackHit && !oversized, sseDisabled: fallback };
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
  // Unbounded (no time/object limit): process every page to completion for the single-pass callers/tests.
  for (;;) {
    const r = await migrateChunk(env, bucketName, endpoint, from, to, cursor, { deadline: Number.MAX_SAFE_INTEGER, maxObjects: Number.MAX_SAFE_INTEGER });
    migrated += r.migrated;
    skipped += r.skipped;
    oversized.push(...r.oversized);
    failed.push(...r.failed);
    cursor = r.lastKey;
    if (r.done) break;
  }
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
  // Hoisted so the catch can release ONLY our own lease (mirrors commit's identity check).
  let myLease: number | undefined;
  try {
    let state = await getRegimeState(env, bucketName);
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
    // Re-read immediately before claiming: another poll may have finished (→ ready) or claimed the
    // lease during the awaits above (e.g. hasHealthyContainer). Bail rather than revert a completed
    // migration back to `migrating`; the rest of the chunk works from this fresh snapshot.
    myLease = now + MIGRATION_LEASE_MS;
    state = await getRegimeState(env, bucketName);
    if (state.status === 'ready' || (state.leaseExpiresAt && state.leaseExpiresAt > now)) return;
    await setRegimeState(env, bucketName, { ...state, leaseExpiresAt: myLease });

    const { endpoint } = await getR2Config(env);

    // mixed-recovery heals stray outliers TO the committed regime; a normal migration goes from→to.
    const to: R2SseRegime = state.status === 'mixed-recovery' ? state.regime : state.to ?? state.regime;
    const from: R2SseRegime = state.status === 'mixed-recovery' ? opposite(state.regime) : state.from ?? opposite(to);
    const phase = state.phase ?? 'migrate';

    let drained = state.drained ?? false;
    if (!drained) {
      // Bound the drain so a hung destroy can't blow the waitUntil window. D1 already ensured no
      // container is healthy, so a timed-out drain is safe to proceed past — the verify-rescan +
      // read self-heal are the backstop for any straggler.
      await withTimeout(deps.drainContainers(), DRAIN_TIMEOUT_MS, 'drainContainers').catch((e) =>
        logger.warn('drainContainers did not finish in time; proceeding (verify-rescan is the backstop)', { bucketName, error: String(e) }),
      );
      await abortInFlightMultiparts(env, bucketName, endpoint);
      drained = true;
    }

    // Commit under our lease: re-read + M1 optimistic-lock check, then persist. Returns false if we
    // lost the lease (its expiry let another poll take over) so the caller stops — writing a stale
    // snapshot could clobber a migration another poll already finished. `hold` keeps the lease for
    // the next page; otherwise it is released so the very next poll resumes immediately.
    const commit = async (s: RegimeState, hold: boolean): Promise<boolean> => {
      const current = await getRegimeState(env, bucketName);
      if (current.leaseExpiresAt !== myLease) return false;
      await setRegimeState(env, bucketName, hold ? { ...s, leaseExpiresAt: myLease } : release(s));
      return true;
    };

    let usedSubreq = 0;
    const deadline = now + WORK_DEADLINE_MS;
    // Persist the one-time drain durably BEFORE the first page, so a kill during or after the first page
    // can never re-trigger the (R2-op-heavy) drain on the next poll — it sees drained=true and goes
    // straight to pages. In the SAME one-time write we record `total`, an object count for the progress %
    // (list-only scan under the SAME work deadline so it can't strand this commit); a bucket larger than
    // COUNT_LIST_CAP pages (or a count that runs out of budget) stores `total: 0` ("counted, no %") so it
    // never re-counts. (commit re-checks the lease; bail if we lost it.)
    let total = state.total;
    if (!state.drained) {
      if (total === undefined) {
        const counted = await countObjects(env, bucketName, endpoint, COUNT_LIST_CAP, deadline);
        usedSubreq += counted.pages;
        total = counted.total ?? 0;
      }
      if (!(await commit({ ...state, drained: true, total }, true))) return;
    }
    total = total ?? 0;

    // Scan the bucket in concurrency-sized slices, checkpointing the start-after key after each chunk.
    // Each invocation STOPS VOLUNTARILY before the ~30s waitUntil force-kill — once another list+slice
    // would not finish before WORK_DEADLINE_MS, or the subrequest backstop is near — and RELEASES the
    // lease so the next poll resumes from the cursor. A force-kill is not catchable and would leave the
    // lease held; the deadline (+ the unconditional first slice in processSlices) is what prevents that.
    const opsPerObject = (p: 'migrate' | 'verify') => (p === 'migrate' ? 2 : 1);
    const sliceMs = (p: 'migrate' | 'verify') => (p === 'migrate' ? MIGRATE_SLICE_MS : VERIFY_SLICE_MS);
    // Objects this chunk may process before the subrequest backstop — the time gate is usually binding.
    const objBudget = (p: 'migrate' | 'verify') => Math.max(0, Math.floor((MAX_SUBREQUESTS - usedSubreq) / opsPerObject(p)));
    // Can we afford another list plus at least one slice (time AND subrequests)?
    const canStartChunk = (p: 'migrate' | 'verify') =>
      Date.now() + LIST_TIMEOUT_MS + sliceMs(p) <= deadline && usedSubreq + 1 + MIGRATION_CONCURRENCY * opsPerObject(p) <= MAX_SUBREQUESTS;
    let curPhase = phase;
    let cursor = state.cursor ?? null;
    let processed = state.processed ?? 0;
    let lastError = state.lastError;

    for (;;) {
      if (curPhase === 'migrate') {
        const r = await migrateChunk(env, bucketName, endpoint, from, to, cursor, { deadline, maxObjects: objBudget('migrate') });
        usedSubreq += 1 + r.processed * opsPerObject('migrate');
        processed += r.processed;
        const notes = [
          r.oversized.length ? `oversized skipped (need UploadPartCopy): ${r.oversized.join(', ')}` : '',
          r.failed.length ? `failed to re-encrypt: ${r.failed.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        lastError = notes || lastError;
        if (r.done) {
          // Migrate pass complete → verify (continue in this invocation if budget remains).
          curPhase = 'verify';
          cursor = null;
          const s: RegimeState = { ...state, drained, total, processed, phase: 'verify', cursor: null, ...(lastError ? { lastError } : {}) };
          if (!canStartChunk('verify')) { await commit(s, false); return; }
          if (!(await commit(s, true))) return;
          continue;
        }
        cursor = r.lastKey;
        const s: RegimeState = { ...state, drained, total, processed, phase: 'migrate', cursor, ...(lastError ? { lastError } : {}) };
        if (canStartChunk('migrate')) { if (!(await commit(s, true))) return; continue; }
        await commit(s, false);
        return;
      }

      const r = await verifyChunk(env, bucketName, endpoint, to, cursor, { deadline, maxObjects: objBudget('verify') });
      usedSubreq += 1 + r.processed * opsPerObject('verify');
      processed += r.processed;
      if (!r.ok) {
        // A stray object is not in the target regime — re-run a migrate pass to heal it, but BOUND
        // the bounces (MAX_VERIFY_RETRIES): an un-fixable poison/corrupt object must not loop forever.
        // Per-key: only accumulate while the SAME object keeps failing; a different key resets it.
        const stuckCount = (state.lastFailedKey === r.failedKey ? (state.stuckCount ?? 0) : 0) + 1;
        await commit({
          ...state, drained, total, processed, stuckCount, lastFailedKey: r.failedKey, phase: 'migrate', cursor: null,
          // Mark halted at the retry ceiling so the dashboard suppresses the progress % — a wedged
          // migration must not read a misleading "99%" (the H2 backstop then stops advancing until admin).
          ...(stuckCount >= MAX_VERIFY_RETRIES ? { halted: true } : {}),
          lastError: stuckCount >= MAX_VERIFY_RETRIES
            ? `verify failed at ${r.failedKey} after ${stuckCount} attempts; halting (un-migratable object — admin review)`
            : `verify failed at ${r.failedKey}; re-migrating`,
        }, false);
        return;
      }
      if (r.done) {
        // Verified clean → ready (drops stuckCount/cursor/phase). A real migration advances the regime
        // + generation; a mixed-recovery only heals.
        const readyState: RegimeState = state.status === 'mixed-recovery'
          ? { status: 'ready', regime: state.regime, generation: state.generation }
          : { status: 'ready', regime: to, generation: state.generation + 1 };
        if (await commit(readyState, false)) {
          logger.info('Governed Mode migration complete', { bucketName, regime: readyState.regime, generation: readyState.generation });
        }
        return;
      }
      cursor = r.lastKey;
      const s: RegimeState = { ...state, drained, total, processed, phase: 'verify', cursor, ...(lastError ? { lastError } : {}) };
      if (canStartChunk('verify')) { if (!(await commit(s, true))) return; continue; }
      await commit(s, false);
      return;
    }
  } catch (err) {
    logger.error('advanceMigration chunk failed; will retry next poll', err instanceof Error ? err : new Error(String(err)), { bucketName });
    // Release the lease so the next poll retries soon (idempotent skip-probe re-does only unfinished work).
    const s = await getRegimeState(env, bucketName).catch(() => null);
    // Release ONLY if we still own the lease (mirrors commit) — never clobber a successor poll's lease.
    if (s && s.status !== 'ready' && myLease !== undefined && s.leaseExpiresAt === myLease) {
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
