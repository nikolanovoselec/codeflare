import type { Env, SessionMode } from '../types';
import { createR2Client, getR2Url } from './r2-client';
import { SEEDED_DOCUMENTS } from './tutorial-seed.generated';
import { AGENTS_SEEDED_CONFIGS } from './agent-seed.generated';
import { createLogger } from './logger';
import { getSseHeaders } from './r2-sse';

const logger = createLogger('r2-seed');

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
  env: Env,
  bucketName: string,
  endpoint: string,
  documents: SeedDocument[],
  options: { overwrite?: boolean } = {}
): Promise<SeedDocsResult> {
  const overwrite = options.overwrite === true;
  const r2Client = createR2Client(env);
  const written: string[] = [];
  const skipped: string[] = [];

  if (!overwrite) {
    // Phase 1: parallel HEAD checks to determine which docs need writing
    const headResults = await Promise.allSettled(
      documents.map(async (doc) => {
        const url = getR2Url(endpoint, bucketName, doc.key);
        const res = await r2Client.fetch(url, { method: 'HEAD', headers: getSseHeaders(env) });
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
          headers: { 'Content-Type': doc.contentType, ...getSseHeaders(env) },
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
          headers: { 'Content-Type': doc.contentType, ...getSseHeaders(env) },
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
  env: Env,
  bucketName: string,
  endpoint: string,
  options: { overwrite?: boolean } = {}
): Promise<SeedDocsResult> {
  const result = await seedDocuments(env, bucketName, endpoint, SEEDED_DOCUMENTS, options);

  logger.info('Seeded getting started docs', {
    bucketName,
    overwrite: options.overwrite === true,
    writtenCount: result.written.length,
    skippedCount: result.skipped.length,
  });

  return result;
}

// Implements REQ-AGENT-005
/**
 * Tier-gated preseed key prefix. Files under this prefix are only deployed
 * to user buckets when contextModeEnabled is true (Pro tier + Pro session
 * mode). See REQ-AGENT-005 and the context-mode preseed plugin README.
 */
const CONTEXT_MODE_KEY_PREFIX = '.claude/plugins/context-mode/';

function isContextModeKey(key: string): boolean {
  return key.startsWith(CONTEXT_MODE_KEY_PREFIX);
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
    if (!contextModeEnabled && isContextModeKey(doc.key)) return false;
    return true;
  });
  const seen = new Set<string>();
  for (const doc of docs) {
    if (seen.has(doc.key)) throw new Error(`Duplicate key "${doc.key}" in mode "${mode}"`);
    seen.add(doc.key);
  }
  return docs;
}

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
        if (!contextModeEnabled && isContextModeKey(doc.key)) return false;
        return true;
      })
      .map((doc) => doc.key)
  );
  return AGENTS_SEEDED_CONFIGS
    .filter((doc) => !doc.modes.includes(mode) || (!contextModeEnabled && isContextModeKey(doc.key)))
    .map((doc) => doc.key)
    .filter((k) => !keysInMode.has(k));
}

/**
 * Delete preseed-managed files that don't belong to the current mode (or
 * are tier-gated context-mode files when contextModeEnabled is false).
 * Only deletes keys from the known generated set - never lists or scans the bucket.
 */
export async function deleteNonModeConfigs(
  env: Env,
  bucketName: string,
  endpoint: string,
  mode: SessionMode,
  contextModeEnabled = false,
): Promise<{ deleted: string[]; warnings: string[] }> {
  const keysToDelete = getPreseedKeysNotInMode(mode, contextModeEnabled);
  if (keysToDelete.length === 0) {
    return { deleted: [], warnings: [] };
  }

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

  return { deleted, warnings };
}

/**
 * Orchestrate seeding + cleanup of agent configs for a given mode.
 * - New bucket: { overwrite: false, cleanup: false }
 * - Recreate button: { overwrite: true, cleanup: true }
 */
export async function reconcileAgentConfigs(
  env: Env,
  bucketName: string,
  endpoint: string,
  mode: SessionMode,
  options: { overwrite: boolean; cleanup: boolean; contextModeEnabled?: boolean }
): Promise<{ written: string[]; skipped: string[]; deleted: string[]; warnings: string[] }> {
  const contextModeEnabled = options.contextModeEnabled === true;
  const docs = getConfigsForMode(mode, contextModeEnabled);
  const seedResult = await seedDocuments(env, bucketName, endpoint, docs, { overwrite: options.overwrite });

  let deleted: string[] = [];
  let warnings: string[] = [];

  if (options.cleanup) {
    const cleanupResult = await deleteNonModeConfigs(env, bucketName, endpoint, mode, contextModeEnabled);
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
  env: Env,
  bucketName: string,
  endpoint: string,
  options: { overwrite?: boolean; mode?: SessionMode; contextModeEnabled?: boolean } = {}
): Promise<SeedDocsResult> {
  const mode = options.mode ?? 'default';
  const contextModeEnabled = options.contextModeEnabled === true;
  const docs = getConfigsForMode(mode, contextModeEnabled);
  const result = await seedDocuments(env, bucketName, endpoint, docs, options);

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

// Implements REQ-AGENT-005
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
  env: Env,
  bucketName: string,
  endpoint: string,
  contextModeEnabled: boolean,
): Promise<SeedDocsResult> {
  if (!contextModeEnabled) {
    return { written: [], skipped: [] };
  }
  const contextModeDocs = AGENTS_SEEDED_CONFIGS.filter((doc) => isContextModeKey(doc.key));
  const result = await seedDocuments(env, bucketName, endpoint, contextModeDocs, { overwrite: true });
  logger.info('Reseeded context-mode plugin subtree', {
    bucketName,
    writtenCount: result.written.length,
  });
  return result;
}
