import type { Env, SessionMode } from '../types';
import { createR2Client, getR2Url } from './r2-client';
import { SEEDED_DOCUMENTS } from './tutorial-seed.generated';
import { AGENTS_SEEDED_CONFIGS } from './agent-seed.generated';
import { createLogger } from './logger';

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
        const res = await r2Client.fetch(url, { method: 'HEAD' });
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
          headers: { 'Content-Type': doc.contentType },
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
          headers: { 'Content-Type': doc.contentType },
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

/**
 * Return only the seed documents that belong to the given session mode.
 * Throws if duplicate keys exist within the same mode (indicates generator bug).
 */
export function getConfigsForMode(mode: SessionMode): SeedDocument[] {
  const docs = AGENTS_SEEDED_CONFIGS.filter((doc) => doc.modes.includes(mode));
  const seen = new Set<string>();
  for (const doc of docs) {
    if (seen.has(doc.key)) throw new Error(`Duplicate key "${doc.key}" in mode "${mode}"`);
    seen.add(doc.key);
  }
  return docs;
}

/**
 * Return the R2 keys of preseed-managed files that are NOT in the given mode.
 * These are candidates for cleanup on mode switch.
 *
 * Keys that have a variant in the target mode (same key, different content per mode)
 * are excluded — they were just seeded and must not be deleted.
 */
export function getPreseedKeysNotInMode(mode: SessionMode): string[] {
  const keysInMode = new Set(
    AGENTS_SEEDED_CONFIGS.filter((doc) => doc.modes.includes(mode)).map((doc) => doc.key)
  );
  return AGENTS_SEEDED_CONFIGS
    .filter((doc) => !doc.modes.includes(mode))
    .map((doc) => doc.key)
    .filter((k) => !keysInMode.has(k));
}

/**
 * Delete preseed-managed files that don't belong to the current mode.
 * Only deletes keys from the known generated set — never lists or scans the bucket.
 */
export async function deleteNonModeConfigs(
  env: Env,
  bucketName: string,
  endpoint: string,
  mode: SessionMode
): Promise<{ deleted: string[]; warnings: string[] }> {
  const keysToDelete = getPreseedKeysNotInMode(mode);
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
      // 204 = deleted, 404 = already gone — both are success
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
  options: { overwrite: boolean; cleanup: boolean }
): Promise<{ written: string[]; skipped: string[]; deleted: string[]; warnings: string[] }> {
  const docs = getConfigsForMode(mode);
  const seedResult = await seedDocuments(env, bucketName, endpoint, docs, { overwrite: options.overwrite });

  let deleted: string[] = [];
  let warnings: string[] = [];

  if (options.cleanup) {
    const cleanupResult = await deleteNonModeConfigs(env, bucketName, endpoint, mode);
    deleted = cleanupResult.deleted;
    warnings = cleanupResult.warnings;
  }

  logger.info('Reconciled agent configs', {
    bucketName,
    mode,
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
  options: { overwrite?: boolean; mode?: SessionMode } = {}
): Promise<SeedDocsResult> {
  const mode = options.mode ?? 'default';
  const docs = getConfigsForMode(mode);
  const result = await seedDocuments(env, bucketName, endpoint, docs, options);

  logger.info('Seeded agent configs', {
    bucketName,
    mode,
    overwrite: options.overwrite === true,
    writtenCount: result.written.length,
    skippedCount: result.skipped.length,
  });

  return result;
}
