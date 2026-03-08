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

  for (const doc of documents) {
    const url = getR2Url(endpoint, bucketName, doc.key);

    if (!overwrite) {
      const headResponse = await r2Client.fetch(url, { method: 'HEAD' });
      if (headResponse.ok) {
        skipped.push(doc.key);
        continue;
      }
      if (headResponse.status !== 404) {
        throw new Error(`Failed to check existing object ${doc.key}: HTTP ${headResponse.status}`);
      }
    }

    const putResponse = await r2Client.fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': doc.contentType,
      },
      body: doc.content,
    });

    if (!putResponse.ok) {
      throw new Error(`Failed to seed object ${doc.key}: HTTP ${putResponse.status}`);
    }

    written.push(doc.key);
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
 */
export function getConfigsForMode(mode: SessionMode): SeedDocument[] {
  return AGENTS_SEEDED_CONFIGS.filter((doc) => doc.modes.includes(mode));
}

/**
 * Return the R2 keys of preseed-managed files that are NOT in the given mode.
 * These are candidates for cleanup on mode switch.
 */
export function getPreseedKeysNotInMode(mode: SessionMode): string[] {
  return AGENTS_SEEDED_CONFIGS
    .filter((doc) => !doc.modes.includes(mode))
    .map((doc) => doc.key);
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
