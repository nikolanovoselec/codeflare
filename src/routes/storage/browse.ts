import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url, parseListObjectsXml } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { ValidationError, ContainerError } from '../../lib/error-types';
import { createBucketIfNotExists } from '../../lib/r2-admin';
import { seedGettingStartedDocs } from '../../lib/r2-seed';
import { createLogger } from '../../lib/logger';

const logger = createLogger('storage-browse');

const EMPTY_LISTING = { objects: [], prefixes: [], isTruncated: false };

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.get('/', async (c) => {
  const bucketName = c.get('bucketName');
  const prefix = c.req.query('prefix') || '';
  const delimiter = c.req.query('delimiter') || '/';
  const continuationToken = c.req.query('continuationToken');
  const maxKeysParam = c.req.query('maxKeys');

  // Validate prefix - no path traversal
  if (prefix.includes('..')) {
    throw new ValidationError('Invalid prefix: path traversal not allowed');
  }

  // Validate maxKeys
  let maxKeys = 200;
  if (maxKeysParam) {
    maxKeys = parseInt(maxKeysParam, 10);
    if (isNaN(maxKeys) || maxKeys < 1 || maxKeys > 1000) {
      throw new ValidationError('maxKeys must be between 1 and 1000');
    }
  }

  const r2Client = createR2Client(c.env);
  const { accountId, endpoint } = await getR2Config(c.env);

  // Build ListObjectsV2 URL with query params
  const params = new URLSearchParams({
    'list-type': '2',
    'prefix': prefix,
    'delimiter': delimiter,
    'max-keys': maxKeys.toString(),
  });
  if (continuationToken) {
    params.set('continuation-token', continuationToken);
  }

  const url = `${getR2Url(endpoint, bucketName)}?${params.toString()}`;

  const response = await r2Client.fetch(url, { method: 'GET' });

  if (!response.ok) {
    // Bucket doesn't exist yet — auto-create and return empty listing
    if (response.status === 404) {
      logger.info('Bucket not found, auto-creating', { bucketName });
      const result = await createBucketIfNotExists(accountId, c.env.CLOUDFLARE_API_TOKEN, bucketName);
      if (!result.success) {
        throw new ContainerError('create-bucket', result.error || 'Failed to create storage bucket');
      }
      if (result.created) {
        try {
          const seedResult = await seedGettingStartedDocs(c.env, bucketName, endpoint, { overwrite: false });
          logger.info('Seeded initial getting-started docs after auto-create', {
            bucketName,
            writtenCount: seedResult.written.length,
            skippedCount: seedResult.skipped.length,
          });
        } catch (error) {
          logger.warn('Failed to seed getting-started docs after auto-create', {
            bucketName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return c.json(EMPTY_LISTING);
    }

    logger.error('R2 ListObjects failed', undefined, { status: response.status, bucketName, prefix });
    throw new ContainerError('storage-browse', `R2 ListObjects failed: ${response.status}`);
  }

  const xml = await response.text();
  const result = parseListObjectsXml(xml);

  return c.json(result);
});

export default app;
