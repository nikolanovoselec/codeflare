import type { Env, SessionMode } from '../types';
import { createR2Client, getR2Url, parseListObjectsXml } from './r2-client';
import { SEEDED_DOCUMENTS } from './tutorial-seed.generated';
import { AGENTS_SEEDED_CONFIGS, PRESEED_CONTENT_HASH, RETIRED_PRESEED_KEYS } from './agent-seed.generated';
import { createLogger } from './logger';
import { getSseHeaders } from './r2-sse';

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

const markerHeaders = (): Record<string, string> => ({ [PRESEED_MARKER_HEADER]: PRESEED_CONTENT_HASH });

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

async function seedDocuments(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  documents: SeedDocument[],
  options: { overwrite?: boolean; r2SseDisabled?: boolean } = {}
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
    // Phase 1: parallel HEAD checks to determine which docs need writing
    const headResults = await Promise.allSettled(
      documents.map(async (doc) => {
        const url = getR2Url(endpoint, bucketName, doc.key);
        const res = await r2Client.fetch(url, { method: 'HEAD', headers: sseHeaders });
        return { doc, exists: res.ok, status: res.status };
      })
    );

    const toWrite: SeedDocument[] = [];
    for (const result of headResults) {
      if (result.status === 'rejected') throw new Error(`HEAD check failed: ${result.reason}`);
      const { doc, exists, status } = result.value;
      if (exists) {
        skipped.push(doc.key);
      } else if (status === 404) {
        toWrite.push(doc);
      } else {
        throw new Error(`Failed to check existing object ${doc.key}: HTTP ${status}`);
      }
    }

    // Phase 2: parallel PUTs for docs that need writing
    const putResults = await Promise.allSettled(
      toWrite.map(async (doc) => {
        const url = getR2Url(endpoint, bucketName, doc.key);
        const res = await r2Client.fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': doc.contentType, ...markerHeaders(), ...sseHeaders },
          body: doc.content,
        });
        if (!res.ok) throw new Error(`Failed to seed object ${doc.key}: HTTP ${res.status}`);
        return doc.key;
      })
    );
    for (const result of putResults) {
      if (result.status === 'rejected') throw new Error(String(result.reason));
      written.push(result.value);
    }
  } else {
    // overwrite=true: parallel PUTs for all documents
    const putResults = await Promise.allSettled(
      documents.map(async (doc) => {
        const url = getR2Url(endpoint, bucketName, doc.key);
        const res = await r2Client.fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': doc.contentType, ...markerHeaders(), ...sseHeaders },
          body: doc.content,
        });
        if (!res.ok) throw new Error(`Failed to seed object ${doc.key}: HTTP ${res.status}`);
        return doc.key;
      })
    );
    for (const result of putResults) {
      if (result.status === 'rejected') throw new Error(String(result.reason));
      written.push(result.value);
    }
  }

  return { written, skipped };
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
): Promise<{ deleted: string[]; warnings: string[] }> {
  // The generated set is the authority on what is live; nothing it seeds may be
  // deleted right after being written.
  const seededKeys = new Set(getConfigsForMode(mode, contextModeEnabled).map((doc) => doc.key));
  const keysToDelete = [
    ...getPreseedKeysNotInMode(mode, contextModeEnabled),
    ...RETIRED_PRESEED_KEYS.filter((key) => !seededKeys.has(key)),
  ];

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
export async function reconcileAgentConfigs(
  env: SeedEnv,
  bucketName: string,
  endpoint: string,
  mode: SessionMode,
  options: { overwrite: boolean; cleanup: boolean; contextModeEnabled?: boolean; r2SseDisabled?: boolean }
): Promise<{ written: string[]; skipped: string[]; deleted: string[]; warnings: string[] }> {
  const contextModeEnabled = options.contextModeEnabled === true;
  const docs = getConfigsForMode(mode, contextModeEnabled);
  const seedResult = await seedDocuments(env, bucketName, endpoint, docs, { overwrite: options.overwrite, r2SseDisabled: options.r2SseDisabled });

  let deleted: string[] = [];
  let warnings: string[] = [];

  if (options.cleanup) {
    const cleanupResult = await deleteNonModeConfigs(
      env,
      bucketName,
      endpoint,
      mode,
      contextModeEnabled,
      options.r2SseDisabled,
    );
    deleted = cleanupResult.deleted;
    warnings = cleanupResult.warnings;
  }

  logger.info('Reconciled agent configs', {
    bucketName,
    mode,
    contextModeEnabled,
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
