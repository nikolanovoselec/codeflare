import type { Env, ManagedResourcePolicy, SessionMode } from '../types';
import {
  streamManagedReleaseDocuments,
  type ManagedReleaseDocument,
  type ManagedReleaseIndex,
} from './remote-curation';
import { createR2Client, getR2Url, parseListObjectsXml } from './r2-client';
import { SEEDED_DOCUMENTS } from './tutorial-seed.generated';
import { AGENTS_SEEDED_CONFIGS, PRESEED_CONTENT_HASH, RETIRED_PRESEED_KEYS } from './agent-seed.generated';
import { createLogger } from './logger';
import { getSseHeaders } from './r2-sse';
import { escapeXml } from './xml-utils';
import { readBoundedResponse } from './bounded-stream';
import {
  buildManagedR2Policy,
  MANAGED_R2_POLICY_KEY,
  readVerifiedManagedR2Policy,
  type BuiltManagedR2Policy,
} from './managed-r2-policy';

const logger = createLogger('r2-seed');

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Provenance marker stamped on every object this module writes. Its presence is
 * the only thing that distinguishes a file codeflare seeded from one the user
 * created: an S3 PUT replaces metadata wholesale, and rclone does not copy custom
 * metadata, so any edit through the file browser or inside the container drops
 * the marker and the file silently becomes the user's own. Those semantics were
 * probed against a real bucket rather than assumed -- see AD118 in
 * documentation/decisions/README.md.
 *
 * The value is the build that wrote it. Cleanup uses it to find objects this
 * build did NOT write: a reconcile overwrites every key the current build owns
 * before cleaning, so after that pass a marker from an older build means the key
 * is no longer part of the product.
 */
const PRESEED_MARKER_HEADER = 'x-amz-meta-codeflare-preseed';

const markerHeaders = (marker = PRESEED_CONTENT_HASH): Record<string, string> => ({ [PRESEED_MARKER_HEADER]: marker });

/**
 * Ceiling and fan-out width for the stale-marker sweep.
 *
 * The cap is what bounds total requests: each candidate costs a HEAD and at most
 * a DELETE, so it is set to half the headroom the sweep is allowed to spend on
 * top of the reconcile's one PUT per live key. The batch bounds CONCURRENCY
 * only -- it does not reduce the total, it stops the whole candidate set being
 * issued at once.
 */
const MAX_STALE_MARKER_CANDIDATES = 200;
const STALE_MARKER_BATCH = 25;

/**
 * Paths under a seeded prefix that the agent runtime writes and owns.
 *
 * They can never be a retirement: nothing here was ever in the seed, so no
 * object carries our marker and the sweep would keep every one of them anyway.
 * Excluding them before the count is what stops a large plugin cache from
 * tripping the candidate cap and disabling the sweep on exactly the buckets
 * that have accumulated the most. The same two paths were reviewed out of the
 * frozen pre-marker list for the same reason.
 */
const RUNTIME_MANAGED_KEYS = ['.claude/plugins/cache/', '.claude/plugins/installed_plugins.json'];

const isRuntimeManagedKey = (key: string): boolean =>
  RUNTIME_MANAGED_KEYS.some((path) => (path.endsWith('/') ? key.startsWith(path) : key === path));

/**
 * CF-013: the only env bindings the seed helpers touch are the R2 credentials
 * (forwarded to createR2Client) and ENCRYPTION_KEY (forwarded to getSseHeaders
 * for SSE-C). Narrow the param to make that surface explicit.
 */
type SeedEnv = Pick<Env, 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'ENCRYPTION_KEY'>;

type SeedDocument = {
  key: string;
  contentType: string;
  content: string;
  modes?: ('default' | 'advanced')[];
};

type SeedDocsResult = {
  written: string[];
  skipped: string[];
};

const R2_SEED_CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(R2_SEED_CONCURRENCY, values.length) }, async () => {
    while (firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await worker(values[index], index);
      } catch (error) {
        firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

async function seedDocuments(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  documents: SeedDocument[],
  options: { overwrite?: boolean; r2SseDisabled?: boolean; marker?: string } = {}
): Promise<SeedDocsResult> {
  const overwrite = options.overwrite === true;
  // REQ-ENTERPRISE-018: in Governed Mode the bucket stores plaintext objects, so the
  // seed must write/read WITHOUT SSE-C headers to match. Caller resolves the bucket's
  // effective regime; default false keeps SSE-C on (byte-identical to pre-feature).
  const sseHeaders = getSseHeaders(env, options.r2SseDisabled);
  const r2Client = createR2Client(env);
  const written: string[] = [];
  const skipped: string[] = [];

  if (!overwrite) {
    // Phase 1: bounded HEAD checks determine which docs need writing.
    const headResults = await mapWithConcurrency(documents, async (doc) => {
      const url = getR2Url(endpoint, bucketName, doc.key);
      const res = await r2Client.fetch(url, { method: 'HEAD', headers: sseHeaders });
      return { doc, exists: res.ok, status: res.status };
    });

    const toWrite: SeedDocument[] = [];
    for (const { doc, exists, status } of headResults) {
      if (exists) {
        skipped.push(doc.key);
      } else if (status === 404) {
        toWrite.push(doc);
      } else {
        throw new Error(`Failed to check existing object ${doc.key}: HTTP ${status}`);
      }
    }

    // Phase 2: bounded PUTs write only missing docs.
    written.push(...await mapWithConcurrency(toWrite, async (doc) => {
      const url = getR2Url(endpoint, bucketName, doc.key);
      const res = await r2Client.fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': doc.contentType, ...markerHeaders(options.marker), ...sseHeaders },
        body: doc.content,
      });
      if (!res.ok) throw new Error(`Failed to seed object ${doc.key}: HTTP ${res.status}`);
      return doc.key;
    }));
  } else {
    // overwrite=true: bounded PUTs for all documents.
    written.push(...await mapWithConcurrency(documents, async (doc) => {
      const url = getR2Url(endpoint, bucketName, doc.key);
      const res = await r2Client.fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': doc.contentType, ...markerHeaders(options.marker), ...sseHeaders },
        body: doc.content,
      });
      if (!res.ok) throw new Error(`Failed to seed object ${doc.key}: HTTP ${res.status}`);
      return doc.key;
    }));
  }

  return { written, skipped };
}

async function seedManagedDocuments(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  mode: SessionMode,
  selection: ManagedReleaseSelection,
  options: { overwrite: boolean; r2SseDisabled?: boolean },
): Promise<SeedDocsResult> {
  const eligibleKeys = selection.release.documents
    .filter((document) => document.modes.includes(mode))
    .map((document) => document.key);
  const eligible = new Set(eligibleKeys);
  const written = new Set<string>();
  const skipped = new Set<string>();
  const sseHeaders = getSseHeaders(env, options.r2SseDisabled);
  const client = createR2Client(env);

  await streamManagedReleaseDocuments(selection.compressed, async (document: ManagedReleaseDocument) => {
    if (!eligible.has(document.key) || !document.modes.includes(mode)) return;
    const url = getR2Url(endpoint, bucketName, document.key);
    if (!options.overwrite) {
      const head = await client.fetch(url, { method: 'HEAD', headers: sseHeaders });
      if (head.ok) {
        skipped.add(document.key);
        return;
      }
      if (head.status !== 404) throw new Error(`Failed to check existing object ${document.key}: HTTP ${head.status}`);
    }
    const response = await client.fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': document.contentType,
        ...markerHeaders(selection.digest),
        ...sseHeaders,
      },
      body: document.content,
    });
    if (!response.ok) throw new Error(`Failed to seed object ${document.key}: HTTP ${response.status}`);
    written.add(document.key);
  });

  return {
    written: eligibleKeys.filter((key) => written.has(key)),
    skipped: eligibleKeys.filter((key) => skipped.has(key)),
  };
}

export async function seedGettingStartedDocs(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  options: { overwrite?: boolean; maxAttempts?: number; retryDelayMs?: number; r2SseDisabled?: boolean } = {}
): Promise<SeedDocsResult> {
  // A bucket created via the control-plane API is not always immediately
  // writable on the S3 data plane, and R2 credentials written as Worker
  // secrets during setup can still be propagating on the first session. The
  // create-time seed runs once inside the caller's swallowing try/catch, so a
  // single transient failure used to leave the bucket permanently unseeded —
  // the new-bucket gate never fires again, and the user had to re-seed by hand.
  // Retry with backoff so a fresh bucket reliably ends up seeded
  // (REQ-STOR-009 AC5). Non-overwrite seeding is idempotent, so a retry only
  // writes the docs a prior attempt missed.
  const maxAttempts = options.maxAttempts ?? 4;
  const retryDelayMs = options.retryDelayMs ?? 300;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await seedDocuments(env, bucketName, endpoint, SEEDED_DOCUMENTS, options);
      logger.info('Seeded getting started docs', {
        bucketName,
        overwrite: options.overwrite === true,
        attempt,
        writtenCount: result.written.length,
        skippedCount: result.skipped.length,
      });
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = retryDelayMs * 2 ** (attempt - 1);
        logger.warn('Getting-started seed attempt failed; retrying', {
          bucketName,
          attempt,
          maxAttempts,
          delayMs: delay,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(delay);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Tier-gated preseed key prefix. Files under this prefix are only deployed
 * to user buckets when contextModeEnabled is true (Pro tier + Pro session
 * mode). See REQ-AGENT-076 and the context-mode preseed plugin README.
 */
const CONTEXT_MODE_KEY_PREFIX = '.claude/plugins/context-mode/';
const PI_CONTEXT_MODE_EXTENSION_KEY = '.pi/agent/extensions/context-mode-enforcement.ts';

function isContextModeKey(key: string): boolean {
  return key.startsWith(CONTEXT_MODE_KEY_PREFIX);
}

function isPiContextModeKey(key: string): boolean {
  return key === PI_CONTEXT_MODE_EXTENSION_KEY;
}

function normalizePiSeedDocument(doc: SeedDocument): SeedDocument | null {
  if (isPiContextModeKey(doc.key)) return null;

  // Pi agents keep the context-mode tool declarations remapped from the shared agent
  // frontmatter: inert when context-mode is off (the ctx_* tools are absent and Pi
  // drops them), usable when /ctx enables it. No Pi-specific stripping.
  //
  // Pi has no MCP client: graphify and context-mode reach Pi as first-party native
  // extensions (graphify-native.ts) and tool declarations, never via a seeded mcp.json,
  // so there is no mcp.json server list to strip here.

  return doc;
}

/**
 * Return only the seed documents that belong to the given session mode and
 * tier. The optional `contextModeEnabled` flag, when false, strips the
 * context-mode plugin subtree from the deploy set - used to enforce the
 * unlimited-tier-only gate before we ship the plugin to the user's bucket.
 *
 * Throws if duplicate keys exist within the same mode (indicates generator bug).
 */
export function getConfigsForMode(
  mode: SessionMode,
  contextModeEnabled = false,
): SeedDocument[] {
  const docs = AGENTS_SEEDED_CONFIGS.filter((doc) => {
    if (!doc.modes.includes(mode)) return false;
    if (isPiContextModeKey(doc.key)) return false;
    if (!contextModeEnabled && isContextModeKey(doc.key)) return false;
    return true;
  }).map(normalizePiSeedDocument).filter((doc): doc is SeedDocument => doc !== null);
  const seen = new Set<string>();
  for (const doc of docs) {
    if (seen.has(doc.key)) throw new Error(`Duplicate key "${doc.key}" in mode "${mode}"`);
    seen.add(doc.key);
  }
  return docs;
}

/**
 * Delete objects a previous build seeded that this build no longer ships.
 *
 * A reconcile rewrites every key the current build owns before cleaning, so by
 * the time this runs, anything of ours still carrying a different build's marker
 * is a file the product has dropped. That marker is the entire record -- nothing
 * has to be enumerated at build time and no list has to be maintained.
 *
 * Two bounds keep it safe. Listing is confined to the prefixes the seed actually
 * writes, which is what keeps the getting-started docs (REQ-STOR-009, at
 * `Getting Started.md`, `Documentation/`, `Examples/`) out of scope even though
 * they are stamped by the same helper; and deletion still requires our marker,
 * so a user's file is untouchable whether or not it sits under those prefixes.
 *
 * A listing does NOT return custom metadata -- verified against R2 -- so the
 * marker can only be read with a HEAD, and the reconcile that calls this has
 * already spent a PUT on every live key. Both bounds below therefore exist to
 * keep the HEAD count near zero rather than near the size of the bucket:
 *
 *   - listing is issued per two-segment prefix (`.claude/skills/`, `.pi/agent/`,
 *     14 of them) rather than per runtime root, which keeps the large runtime
 *     trees -- `.claude/projects/` session transcripts, `.claude/todos/` -- out
 *     of the pages entirely;
 *   - the fan-out is batched, and a candidate count past the cap skips the sweep
 *     with a warning instead of issuing the requests.
 *
 * Narrowing stops there deliberately. A retired skill is a whole DIRECTORY, so
 * any filter keyed to "a directory the seed still populates" would discard the
 * common case. The one exception is runtime state that shares a seeded prefix,
 * which RUNTIME_MANAGED_KEYS drops before the count and which is therefore never
 * HEADed. What remains is the user's own files: they are HEADed once per
 * upgrade, return no marker, and are kept. On a bucket with nothing retired the
 * candidate set is whatever the user added, and no DELETE is ever issued for it.
 */
async function deleteStaleMarkedConfigs(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  seededKeys: ReadonlySet<string>,
  r2SseDisabled?: boolean
): Promise<{ deleted: string[]; warnings: string[] }> {
  const r2Client = createR2Client(env);
  const sseHeaders = getSseHeaders(env, r2SseDisabled);
  const deleted: string[] = [];
  const warnings: string[] = [];

  // Derived from the seed itself, so a new runtime directory is covered without
  // anyone remembering to add it here. A key shallower than three segments has
  // no directory to group by, and listing it would return only itself -- which
  // is seeded, so it can never be a candidate. Skipped rather than listed.
  const prefixes = new Set<string>();
  for (const key of seededKeys) {
    const segments = key.split('/');
    if (segments.length > 2) prefixes.add(`${segments[0]}/${segments[1]}/`);
  }

  const candidates: string[] = [];
  for (const prefix of prefixes) {
    // Collected per prefix and merged only when the prefix listed completely. A
    // failure on page two leaves a partial view, and deleting from a partial
    // view is deleting on the strength of not having looked.
    const found: string[] = [];
    let continuationToken: string | undefined;
    let complete = false;
    do {
      const params = new URLSearchParams({ 'list-type': '2', prefix });
      if (continuationToken) params.set('continuation-token', continuationToken);
      const res = await r2Client.fetch(`${getR2Url(endpoint, bucketName)}?${params}`);
      if (!res.ok) {
        // A prefix we could not list completely is a prefix we do not clean.
        warnings.push(`LIST ${prefix}: HTTP ${res.status}`);
        break;
      }
      const parsed = parseListObjectsXml(await res.text());
      for (const object of parsed.objects) {
        if (seededKeys.has(object.key)) continue;
        if (isRuntimeManagedKey(object.key)) continue;
        found.push(object.key);
      }
      // Derived from the flag, never from the token: the parser sets the two
      // independently, so a truncated page whose token did not parse would
      // otherwise read as a finished listing and its partial view would be
      // swept -- the case this per-prefix merge exists to prevent.
      if (parsed.isTruncated && !parsed.nextContinuationToken) {
        warnings.push(`LIST ${prefix}: truncated without a continuation token`);
        break;
      }
      continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : undefined;
      complete = !parsed.isTruncated;

      // Checked while paging, not after. The caller has already spent one PUT
      // per live key in this same request, so continuing to page a large tree
      // would exhaust the subrequest budget before the guard could refuse to
      // spend it.
      if (found.length > MAX_STALE_MARKER_CANDIDATES) {
        warnings.push(
          `stale-marker sweep skipped: more than ${MAX_STALE_MARKER_CANDIDATES} candidates under ${prefix}`
        );
        return { deleted, warnings };
      }
    } while (continuationToken);

    if (!complete) continue;
    candidates.push(...found);
    // Counted against what has actually been merged. Counting a prefix that
    // then turns out incomplete would abort the sweep over keys it was never
    // going to touch.
    if (candidates.length > MAX_STALE_MARKER_CANDIDATES) {
      warnings.push(
        `stale-marker sweep skipped: more than ${MAX_STALE_MARKER_CANDIDATES} candidates across the seed prefixes`
      );
      return { deleted, warnings };
    }
  }

  if (candidates.length === 0) return { deleted, warnings };

  for (let i = 0; i < candidates.length; i += STALE_MARKER_BATCH) {
    const results = await Promise.allSettled(
      candidates.slice(i, i + STALE_MARKER_BATCH).map(async (key) => {
        const url = getR2Url(endpoint, bucketName, key);
        const head = await r2Client.fetch(url, { method: 'HEAD', headers: sseHeaders });
        if (head.status === 404) return null;
        if (!head.ok) throw new Error(`HEAD ${key}: HTTP ${head.status}`);

        // No marker means the user owns it -- either they created it, or they
        // edited ours and the rewrite dropped the metadata. This build's own
        // marker means we just wrote it under a key this mode does not list,
        // which is the by-name path's business, not this one's.
        const marker = head.headers.get(PRESEED_MARKER_HEADER);
        if (!marker || marker === PRESEED_CONTENT_HASH) return null;

        const res = await r2Client.fetch(url, { method: 'DELETE' });
        if (res.ok || res.status === 404) return key;
        throw new Error(`DELETE ${key}: HTTP ${res.status}`);
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value !== null) deleted.push(result.value);
      } else {
        warnings.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }
  }

  return { deleted, warnings };
}

/**
 * Keys earlier builds seeded that no build produces any more, recovered by
 * walking every revision of the generated seed.
 *
 * They predate the provenance marker, so nothing stored in R2 identifies them
 * and no per-object check can. They are deleted unconditionally: a one-time
 * clean slate that clears the accumulated history in one pass. From then on the
 * marker carries provenance, and this list is inert.
 *
 * Frozen. Nothing is ever appended -- a key retired from here on is identified
 * by the stale marker it carries, not by being enumerated here.
 */

/**
 * Return the R2 keys of preseed-managed files that are NOT in the given mode
 * (or are tier-gated context-mode files when contextModeEnabled is false).
 * These are candidates for cleanup on mode switch or tier downgrade.
 *
 * Keys that have a variant in the target deploy set (same key, different
 * content per mode) are excluded - they were just seeded and must not be
 * deleted.
 */
export function getPreseedKeysNotInMode(
  mode: SessionMode,
  contextModeEnabled = false,
): string[] {
  const keysInMode = new Set(
    AGENTS_SEEDED_CONFIGS
      .filter((doc) => {
        if (!doc.modes.includes(mode)) return false;
        if (isPiContextModeKey(doc.key)) return false;
        if (!contextModeEnabled && isContextModeKey(doc.key)) return false;
        return true;
      })
      .map((doc) => doc.key)
  );
  return AGENTS_SEEDED_CONFIGS
    .filter((doc) => isPiContextModeKey(doc.key) || !doc.modes.includes(mode) || (!contextModeEnabled && isContextModeKey(doc.key)))
    .map((doc) => doc.key)
    .filter((k) => !keysInMode.has(k));
}

/**
 * Delete preseed-managed files that don't belong in the bucket any more, from
 * three sources: keys outside the current mode (or tier-gated context-mode files
 * when contextModeEnabled is false), the frozen pre-marker list, and finally any
 * object still carrying an older build's provenance marker.
 *
 * Only the last one looks at the bucket, and only within the seed's own prefixes.
 * A user's file is never deleted by any of the three: the first two name keys the
 * product itself shipped, and the third requires our marker.
 */
export async function deleteNonModeConfigs(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  mode: SessionMode,
  contextModeEnabled = false,
  r2SseDisabled?: boolean,
  protectedKeys: ReadonlySet<string> = new Set(),
): Promise<{ deleted: string[]; warnings: string[] }> {
  // The generated set is the authority on what is live; nothing it seeds may be
  // deleted right after being written. A managed-disable reconcile additionally
  // protects its prior document set from baked by-name/stale cleanup; the exact
  // prior-digest pass below is the only owner allowed to remove those keys.
  const seededKeys = new Set([
    ...getConfigsForMode(mode, contextModeEnabled).map((doc) => doc.key),
    ...protectedKeys,
  ]);
  const keysToDelete = [
    ...getPreseedKeysNotInMode(mode, contextModeEnabled),
    ...RETIRED_PRESEED_KEYS.filter((key) => !seededKeys.has(key)),
  ].filter((key) => !protectedKeys.has(key));

  const r2Client = createR2Client(env);
  const deleted: string[] = [];
  const warnings: string[] = [];

  const results = await Promise.allSettled(
    keysToDelete.map(async (key) => {
      const url = getR2Url(endpoint, bucketName, key);
      const response = await r2Client.fetch(url, { method: 'DELETE' });
      // 204 = deleted, 404 = already gone - both are success
      if (response.ok || response.status === 404) {
        return key;
      }
      throw new Error(`DELETE ${key}: HTTP ${response.status}`);
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      deleted.push(result.value);
    } else {
      warnings.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  // Last, so a key already removed by name above simply HEADs 404 here and is
  // not counted twice.
  const stale = await deleteStaleMarkedConfigs(env, bucketName, endpoint, seededKeys, r2SseDisabled);
  deleted.push(...stale.deleted);
  warnings.push(...stale.warnings);

  return { deleted, warnings };
}

/**
 * Orchestrate seeding + cleanup of agent configs for a given mode.
 * - New bucket: { overwrite: false, cleanup: false }
 * - Recreate button: { overwrite: true, cleanup: true }
 */
export interface ManagedReleaseSelection {
  digest: string;
  compressed: Uint8Array;
  release: ManagedReleaseIndex;
}

export interface PriorManagedReleaseSelection extends ManagedReleaseSelection {
  mode: SessionMode;
}

function getManagedDocumentKeysForMode(release: ManagedReleaseIndex, mode: SessionMode): string[] {
  const keys = release.documents
    .filter((document) => document.modes.includes(mode))
    .map((document) => document.key);
  if (new Set(keys).size !== keys.length) throw new Error(`Duplicate managed key in mode "${mode}"`);
  return keys;
}

export function managedExtensionsDocumentContent(selection: ManagedReleaseSelection): string {
  return JSON.stringify({
    schemaVersion: 1,
    release: { digest: selection.digest, sequence: selection.release.sequence },
    extensions: selection.release.managedExtensions,
  });
}

export async function managedExtensionsDocumentDigest(selection: ManagedReleaseSelection): Promise<string> {
  const bytes = new TextEncoder().encode(managedExtensionsDocumentContent(selection));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function managedExtensionsDocument(selection: ManagedReleaseSelection): SeedDocument {
  return {
    key: '.codeflare/managed-extensions.json',
    contentType: 'application/json; charset=utf-8',
    content: managedExtensionsDocumentContent(selection),
  };
}

async function deleteManagedConfigsByDigest(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  candidates: readonly string[],
  digest: string,
  r2SseDisabled?: boolean,
): Promise<{ deleted: string[]; warnings: string[] }> {
  const client = createR2Client(env);
  const sseHeaders = getSseHeaders(env, r2SseDisabled);
  const deleted: string[] = [];
  const warnings: string[] = [];

  const outcomes = await mapWithConcurrency(candidates, async (key) => {
    const url = getR2Url(endpoint, bucketName, key);
    try {
      const head = await client.fetch(url, { method: 'HEAD', headers: sseHeaders });
      if (head.status === 404) return {};
      if (!head.ok) throw new Error(`HEAD ${key}: HTTP ${head.status}`);
      if (head.headers.get(PRESEED_MARKER_HEADER) !== digest) return {};
      const response = await client.fetch(url, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new Error(`DELETE ${key}: HTTP ${response.status}`);
      return { deleted: key };
    } catch (error) {
      return { warning: error instanceof Error ? error.message : String(error) };
    }
  });
  for (const outcome of outcomes) {
    if (outcome.deleted) deleted.push(outcome.deleted);
    if (outcome.warning) warnings.push(outcome.warning);
  }
  return { deleted, warnings };
}

async function deletePriorManagedConfigs(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  prior: PriorManagedReleaseSelection,
  current: ManagedReleaseSelection | null,
  mode: SessionMode,
  r2SseDisabled?: boolean,
): Promise<{ deleted: string[]; warnings: string[] }> {
  const priorKeys = new Set([
    ...getManagedDocumentKeysForMode(prior.release, prior.mode),
    '.codeflare/managed-extensions.json',
  ]);
  const currentKeys = new Set(current
    ? [...getManagedDocumentKeysForMode(current.release, mode), '.codeflare/managed-extensions.json']
    : []);
  const candidates = [...priorKeys].filter((key) => !currentKeys.has(key));
  return deleteManagedConfigsByDigest(env, bucketName, endpoint, candidates, prior.digest, r2SseDisabled);
}

async function deleteRetiredManagedConfigs(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  release: ManagedReleaseIndex,
  r2SseDisabled?: boolean,
  deleteWithoutProvenance = false,
): Promise<{ deleted: string[]; warnings: string[] }> {
  const client = createR2Client(env);
  const sseHeaders = getSseHeaders(env, r2SseDisabled);
  const deleted: string[] = [];
  const warnings: string[] = [];
  const outcomes = await mapWithConcurrency(release.retiredPaths, async (key) => {
    const url = getR2Url(endpoint, bucketName, key);
    try {
      if (!deleteWithoutProvenance) {
        const head = await client.fetch(url, { method: 'HEAD', headers: sseHeaders });
        if (head.status === 404) return {};
        if (!head.ok) throw new Error(`HEAD ${key}: HTTP ${head.status}`);
        // Mutable mode retains AD118 ownership transfer when provenance is absent.
        if (!head.headers.get(PRESEED_MARKER_HEADER)) return {};
      }
      const response = await client.fetch(url, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new Error(`DELETE ${key}: HTTP ${response.status}`);
      return { deleted: key };
    } catch (error) {
      return { warning: error instanceof Error ? error.message : String(error) };
    }
  });
  for (const outcome of outcomes) {
    if (outcome.deleted) deleted.push(outcome.deleted);
    if (outcome.warning) warnings.push(outcome.warning);
  }
  return { deleted, warnings };
}

const MAX_EXCLUSIVE_OBJECTS = 10_000;
const MAX_EXCLUSIVE_LIST_BYTES = 1024 * 1024 * 1024;
const MAX_EXCLUSIVE_OBJECT_BYTES = 1024 * 1024 * 1024;
const MAX_EXCLUSIVE_LIST_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_EXCLUSIVE_LIST_PAGES = 10_001;
const MAX_EXCLUSIVE_DELETE_RESPONSE_BYTES = 8 * 1024 * 1024;

function parseExclusiveListPage(xml: string, root: string): ReturnType<typeof parseListObjectsXml> {
  const listRoots = xml.match(/<ListBucketResult(?:\s[^>]*)?>/g) ?? [];
  const listRootEnds = xml.match(/<\/ListBucketResult>/g) ?? [];
  if (listRoots.length !== 1 || listRootEnds.length !== 1 || !/^\s*(?:<\?xml[^?]*\?>\s*)?<ListBucketResult(?:\s[^>]*)?>[\s\S]*<\/ListBucketResult>\s*$/.test(xml)) {
    throw new Error('Exclusive managed-resource listing response has an invalid root');
  }
  const truncatedMatches = [...xml.matchAll(/<IsTruncated>(true|false)<\/IsTruncated>/g)];
  if (truncatedMatches.length !== 1) throw new Error('Exclusive managed-resource listing response has invalid truncation state');
  const rawContents = xml.match(/<Contents(?:\s[^>]*)?>/g) ?? [];
  const rawContentEnds = xml.match(/<\/Contents>/g) ?? [];
  const parsed = parseListObjectsXml(xml);
  if (rawContents.length !== rawContentEnds.length || parsed.objects.length !== rawContents.length) {
    throw new Error('Exclusive managed-resource listing response contains malformed objects');
  }
  if (parsed.objects.some(object => (
    !object.key.startsWith(root)
    || !Number.isFinite(object.size)
    || object.size < 0
    || Number.isNaN(Date.parse(object.lastModified))
  ))) {
    throw new Error('Exclusive managed-resource listing response contains an invalid object');
  }
  const tokenMatches = [...xml.matchAll(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/g)];
  const isTruncated = truncatedMatches[0]![1] === 'true';
  if (isTruncated !== parsed.isTruncated || (isTruncated ? tokenMatches.length !== 1 || !parsed.nextContinuationToken : tokenMatches.length !== 0)) {
    throw new Error('Exclusive managed-resource listing response has invalid continuation state');
  }
  return parsed;
}

async function listExclusiveCleanupCandidates(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  policy: BuiltManagedR2Policy,
  r2SseDisabled?: boolean,
): Promise<string[]> {
  const client = createR2Client(env);
  const candidates = new Set<string>();
  const protectedPaths = new Set(policy.value.paths);
  const sseHeaders = getSseHeaders(env, r2SseDisabled);
  let listedObjects = 0;
  let listBytes = 0;
  let objectBytes = 0;
  let listPages = 0;

  for (const root of policy.value.resourceRoots) {
    const rootObject = root.slice(0, -1);
    const rootHead = await client.fetch(getR2Url(endpoint, bucketName, rootObject), { method: 'HEAD', headers: sseHeaders });
    if (rootHead.ok) {
      const contentLength = rootHead.headers.get('content-length');
      if (!contentLength || !/^(?:0|[1-9]\d*)$/.test(contentLength)) {
        throw new Error('Exclusive managed-resource root object size is invalid');
      }
      const rootObjectBytes = Number(contentLength);
      if (!Number.isSafeInteger(rootObjectBytes)) {
        throw new Error('Exclusive managed-resource root object size is invalid');
      }
      listedObjects += 1;
      objectBytes += rootObjectBytes;
      if (listedObjects > MAX_EXCLUSIVE_OBJECTS) throw new Error('Exclusive managed-resource cleanup exceeds 10,000 objects');
      if (objectBytes > MAX_EXCLUSIVE_OBJECT_BYTES) throw new Error('Exclusive managed-resource cleanup exceeds 1 GiB of object size');
      if (!protectedPaths.has(rootObject)) candidates.add(rootObject);
    } else if (rootHead.status !== 404) {
      throw new Error(`Exclusive managed-resource root check failed: HTTP ${rootHead.status}`);
    }

    let continuationToken: string | undefined;
    const seenContinuationTokens = new Set<string>();
    do {
      const url = new URL(getR2Url(endpoint, bucketName));
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', root);
      url.searchParams.set('max-keys', '1000');
      if (continuationToken) url.searchParams.set('continuation-token', continuationToken);
      listPages += 1;
      if (listPages > MAX_EXCLUSIVE_LIST_PAGES) throw new Error('Exclusive managed-resource cleanup exceeds listing page limit');
      const response = await client.fetch(url.toString(), { method: 'GET' });
      if (!response.ok) throw new Error(`Exclusive managed-resource listing failed: HTTP ${response.status}`);
      const bytes = await readBoundedResponse(
        response,
        Math.min(MAX_EXCLUSIVE_LIST_PAGE_BYTES, MAX_EXCLUSIVE_LIST_BYTES - listBytes),
        'Exclusive managed-resource listing metadata',
      );
      listBytes += bytes.byteLength;
      let xml: string;
      try {
        xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      } catch {
        throw new Error('Exclusive managed-resource listing response is not valid UTF-8');
      }
      const parsed = parseExclusiveListPage(xml, root);
      listedObjects += parsed.objects.length;
      objectBytes += parsed.objects.reduce((sum, object) => sum + object.size, 0);
      if (listedObjects > MAX_EXCLUSIVE_OBJECTS) {
        throw new Error('Exclusive managed-resource cleanup exceeds 10,000 objects');
      }
      if (objectBytes > MAX_EXCLUSIVE_OBJECT_BYTES) {
        throw new Error('Exclusive managed-resource cleanup exceeds 1 GiB of object size');
      }
      for (const object of parsed.objects) {
        if (!protectedPaths.has(object.key)) candidates.add(object.key);
      }
      if (parsed.isTruncated && !parsed.nextContinuationToken) {
        throw new Error('Exclusive managed-resource listing omitted its continuation token');
      }
      if (parsed.nextContinuationToken && seenContinuationTokens.has(parsed.nextContinuationToken)) {
        throw new Error('Exclusive managed-resource listing repeated its continuation token');
      }
      if (parsed.nextContinuationToken) seenContinuationTokens.add(parsed.nextContinuationToken);
      continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : undefined;
    } while (continuationToken);
  }
  return [...candidates].sort();
}

function verifyExclusiveDeleteResponse(xml: string): void {
  const result = xml.match(/^\s*(?:<\?xml(?:\s+[A-Za-z_][\w:.-]*=(?:"[^"]*"|'[^']*'))*\s*\?>\s*)?<DeleteResult(?:\s+[A-Za-z_][\w:.-]*=(?:"[^"]*"|'[^']*'))*\s*(?:\/>|>([\s\S]*)<\/DeleteResult>)\s*$/);
  if (!result) throw new Error('Exclusive managed-resource DeleteObjects response is malformed');
  const body = result[1] ?? '';
  if (/<Error(?:\s|\/?>)/.test(body)) {
    throw new Error('Exclusive managed-resource DeleteObjects response reported per-object errors');
  }
  if (body.trim().length > 0) {
    throw new Error('Exclusive managed-resource DeleteObjects response is malformed');
  }
}

async function deleteExclusiveCleanupCandidates(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  candidates: readonly string[],
): Promise<string[]> {
  const client = createR2Client(env);
  const batches = Array.from({ length: Math.ceil(candidates.length / 1_000) }, (_, index) => (
    candidates.slice(index * 1_000, (index + 1) * 1_000)
  ));
  await mapWithConcurrency(batches, async (batch) => {
    const body = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${batch
      .map(key => `<Object><Key>${escapeXml(key)}</Key></Object>`).join('')}</Delete>`;
    const response = await client.fetch(`${getR2Url(endpoint, bucketName)}?delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });
    if (!response.ok) throw new Error(`DeleteObjects: HTTP ${response.status}`);
    const bytes = await readBoundedResponse(
      response,
      MAX_EXCLUSIVE_DELETE_RESPONSE_BYTES,
      'Exclusive managed-resource DeleteObjects response',
    );
    let xml: string;
    try {
      xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      throw new Error('Exclusive managed-resource DeleteObjects response is not valid UTF-8');
    }
    verifyExclusiveDeleteResponse(xml);
  });
  return [...candidates];
}

async function writeAndVerifyManagedPolicy(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  policy: BuiltManagedR2Policy,
  r2SseDisabled?: boolean,
): Promise<void> {
  const client = createR2Client(env);
  const url = getR2Url(endpoint, bucketName, MANAGED_R2_POLICY_KEY);
  const sseHeaders = getSseHeaders(env, r2SseDisabled);
  const write = await client.fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...markerHeaders(policy.value.releaseDigest), ...sseHeaders },
    body: policy.bytes,
  });
  if (!write.ok) throw new Error(`Managed policy write failed: HTTP ${write.status}`);
  await readVerifiedManagedR2Policy({
    fetchPolicyObject: () => client.fetch(url, { method: 'GET', headers: sseHeaders }),
    releaseDigest: policy.value.releaseDigest,
    pathsDigest: policy.digest,
    expectedPolicy: policy.value.resourcePolicy,
    bypassMemoryCache: true,
  });
}

/** @impl REQ-STOR-021 AC3, AC5 */
/** @impl REQ-STOR-029 AC1, AC2, AC3, AC4, AC5, AC6 */
export async function reconcileAgentConfigs(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  mode: SessionMode,
  options: {
    overwrite: boolean;
    cleanup: boolean;
    contextModeEnabled?: boolean;
    r2SseDisabled?: boolean;
    /** undefined = ordinary baked behavior; null = disable curation and restore baked behavior. */
    managedRelease?: ManagedReleaseSelection | null;
    priorManagedRelease?: PriorManagedReleaseSelection;
    /** Prior applied ownership marker used only for bounded current-release paths. */
    priorManagedDigest?: string;
    /** Explicit only for managed-environment reconciliation; omission preserves legacy seed behavior. */
    resourcePolicy?: ManagedResourcePolicy;
  }
): Promise<{ written: string[]; skipped: string[]; deleted: string[]; warnings: string[]; managedPathsDigest?: string }> {
  const contextModeEnabled = options.contextModeEnabled === true;
  const managedRelease = options.managedRelease;
  const policy = options.resourcePolicy && options.resourcePolicy !== 'mutable'
    ? managedRelease
      ? await buildManagedR2Policy(managedRelease.digest, managedRelease.release, options.resourcePolicy)
      : (() => { throw new Error('Protected managed-resource policy requires a verified active release'); })()
    : undefined;
  const exclusiveCandidates = policy?.value.resourcePolicy === 'exclusive'
    ? await listExclusiveCleanupCandidates(env, bucketName, endpoint, policy, options.r2SseDisabled)
    : [];
  const seedResult = managedRelease
    ? await seedManagedDocuments(env, bucketName, endpoint, mode, managedRelease, {
        overwrite: options.overwrite,
        r2SseDisabled: options.r2SseDisabled,
      })
    : await seedDocuments(env, bucketName, endpoint, getConfigsForMode(mode, contextModeEnabled), {
        overwrite: options.overwrite,
        r2SseDisabled: options.r2SseDisabled,
      });
  if (managedRelease) {
    const extensionResult = await seedDocuments(
      env,
      bucketName,
      endpoint,
      [managedExtensionsDocument(managedRelease)],
      { overwrite: options.overwrite, r2SseDisabled: options.r2SseDisabled, marker: managedRelease.digest },
    );
    seedResult.written.push(...extensionResult.written);
    seedResult.skipped.push(...extensionResult.skipped);
  }

  let deleted: string[] = [];
  let warnings: string[] = [];

  if (options.cleanup) {
    if (managedRelease === undefined || managedRelease === null) {
      const protectedKeys = managedRelease === null && options.priorManagedRelease
        ? new Set([
            ...getManagedDocumentKeysForMode(options.priorManagedRelease.release, options.priorManagedRelease.mode),
            '.codeflare/managed-extensions.json',
          ])
        : new Set<string>();
      const cleanupResult = await deleteNonModeConfigs(
        env,
        bucketName,
        endpoint,
        mode,
        contextModeEnabled,
        options.r2SseDisabled,
        protectedKeys,
      );
      deleted = cleanupResult.deleted;
      warnings = cleanupResult.warnings;
    }
    if (options.priorManagedRelease) {
      const cleanupResult = await deletePriorManagedConfigs(
        env,
        bucketName,
        endpoint,
        options.priorManagedRelease,
        managedRelease ?? null,
        mode,
        options.r2SseDisabled,
      );
      deleted.push(...cleanupResult.deleted);
      warnings.push(...cleanupResult.warnings);
    } else if (managedRelease && options.priorManagedDigest) {
      const currentModeKeys = new Set(getManagedDocumentKeysForMode(managedRelease.release, mode));
      const candidates = managedRelease.release.documents
        .map((document) => document.key)
        .filter((key) => !currentModeKeys.has(key));
      const cleanupResult = await deleteManagedConfigsByDigest(
        env,
        bucketName,
        endpoint,
        candidates,
        options.priorManagedDigest,
        options.r2SseDisabled,
      );
      deleted.push(...cleanupResult.deleted);
      warnings.push(...cleanupResult.warnings);
    }
    if (managedRelease) {
      const cleanupResult = await deleteRetiredManagedConfigs(
        env,
        bucketName,
        endpoint,
        managedRelease.release,
        options.r2SseDisabled,
        options.resourcePolicy !== undefined && options.resourcePolicy !== 'mutable',
      );
      deleted.push(...cleanupResult.deleted);
      warnings.push(...cleanupResult.warnings);
    }
  }

  if (exclusiveCandidates.length > 0) {
    deleted.push(...await deleteExclusiveCleanupCandidates(env, bucketName, endpoint, exclusiveCandidates));
  }

  if (policy) {
    await writeAndVerifyManagedPolicy(env, bucketName, endpoint, policy, options.r2SseDisabled);
  } else if (options.resourcePolicy === 'mutable') {
    const response = await createR2Client(env).fetch(
      getR2Url(endpoint, bucketName, MANAGED_R2_POLICY_KEY),
      { method: 'DELETE' },
    );
    if (!response.ok && response.status !== 404) throw new Error(`Managed policy delete failed: HTTP ${response.status}`);
  }

  logger.info('Reconciled agent configs', {
    bucketName,
    mode,
    contextModeEnabled,
    managedReleaseDigest: managedRelease?.digest,
    writtenCount: seedResult.written.length,
    skippedCount: seedResult.skipped.length,
    deletedCount: deleted.length,
    warningCount: warnings.length,
  });

  return {
    written: seedResult.written,
    skipped: seedResult.skipped,
    deleted,
    warnings,
    ...(policy ? { managedPathsDigest: policy.digest } : {}),
  };
}

export async function seedAgentConfigs(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  options: { overwrite?: boolean; mode?: SessionMode; contextModeEnabled?: boolean; r2SseDisabled?: boolean } = {}
): Promise<SeedDocsResult> {
  const mode = options.mode ?? 'default';
  const contextModeEnabled = options.contextModeEnabled === true;
  const docs = getConfigsForMode(mode, contextModeEnabled);
  const result = await seedDocuments(env, bucketName, endpoint, docs, { overwrite: options.overwrite, r2SseDisabled: options.r2SseDisabled });

  logger.info('Seeded agent configs', {
    bucketName,
    mode,
    contextModeEnabled,
    overwrite: options.overwrite === true,
    writtenCount: result.written.length,
    skippedCount: result.skipped.length,
  });

  return result;
}

/**
 * The context-mode plugin subtree is Worker-authoritative: its plugin.json,
 * hooks.json, and README ship inside the Worker bundle and must always
 * reflect the deployed code on every session start. Existing buckets seeded
 * before a plugin manifest change (e.g. before the mcpServers block was
 * added) would otherwise keep the stale manifest forever, since the regular
 * seed paths use overwrite:false on first-bucket creation.
 *
 * Always-overwrite the 3-file subtree on every session start when
 * contextModeEnabled is true. The cost is 3 small R2 PUTs per session.
 * When contextModeEnabled is false, do nothing - the cleanup path in
 * deleteNonModeConfigs handles tier-downgrade.
 */
export async function reseedContextModePlugin(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  contextModeEnabled: boolean,
  r2SseDisabled = false,
): Promise<SeedDocsResult> {
  if (!contextModeEnabled) {
    return { written: [], skipped: [] };
  }
  const contextModeDocs = AGENTS_SEEDED_CONFIGS.filter((doc) => isContextModeKey(doc.key));
  const result = await seedDocuments(env, bucketName, endpoint, contextModeDocs, { overwrite: true, r2SseDisabled });
  logger.info('Reseeded context-mode plugin subtree', {
    bucketName,
    writtenCount: result.written.length,
  });
  return result;
}
