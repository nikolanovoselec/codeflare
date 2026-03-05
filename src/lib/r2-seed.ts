import type { Env } from '../types';
import { createR2Client, getR2Url } from './r2-client';
import { SEEDED_DOCUMENTS } from './tutorial-seed.generated';
import { AGENTS_SEEDED_CONFIGS } from './agent-seed.generated';
import { createLogger } from './logger';

const logger = createLogger('r2-seed');

type SeedDocument = {
  key: string;
  contentType: string;
  content: string;
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

export async function seedAgentConfigs(
  env: Env,
  bucketName: string,
  endpoint: string,
  options: { overwrite?: boolean } = {}
): Promise<SeedDocsResult> {
  const result = await seedDocuments(env, bucketName, endpoint, AGENTS_SEEDED_CONFIGS, options);

  logger.info('Seeded agent configs', {
    bucketName,
    overwrite: options.overwrite === true,
    writtenCount: result.written.length,
    skippedCount: result.skipped.length,
  });

  return result;
}
