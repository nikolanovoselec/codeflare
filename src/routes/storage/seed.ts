import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createBucketIfNotExists } from '../../lib/r2-admin';
import { getR2Config } from '../../lib/r2-config';
import { seedGettingStartedDocs, seedAgentConfigs } from '../../lib/r2-seed';
import { createRateLimiter } from '../../middleware/rate-limit';
import { ContainerError, toErrorMessage } from '../../lib/error-types';
import { createLogger } from '../../lib/logger';

const logger = createLogger('storage-seed');

const storageSeedRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 3,
  keyPrefix: 'storage-seed',
});

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', storageSeedRateLimiter);

/**
 * POST /api/storage/seed/getting-started
 * Recreate starter documentation at the bucket root, overwriting existing files.
 */
app.post('/getting-started', async (c) => {
  const bucketName = c.get('bucketName');
  const { accountId, endpoint } = await getR2Config(c.env);

  const bucketResult = await createBucketIfNotExists(accountId, c.env.CLOUDFLARE_API_TOKEN, bucketName);
  if (!bucketResult.success) {
    throw new ContainerError('seed-documentation', bucketResult.error || 'Failed to create storage bucket');
  }

  try {
    const seedResult = await seedGettingStartedDocs(c.env, bucketName, endpoint, { overwrite: true });

    logger.info('Recreated getting-started docs', {
      bucketName,
      bucketCreated: bucketResult.created === true,
      writtenCount: seedResult.written.length,
      skippedCount: seedResult.skipped.length,
    });

    // Invalidate storage-stats cache so next poll/fetch gets fresh data
    await c.env.KV.delete(`storage-stats:${bucketName}`);

    return c.json({
      success: true,
      bucketCreated: bucketResult.created === true,
      written: seedResult.written,
      skipped: seedResult.skipped,
    });
  } catch (error) {
    throw new ContainerError('seed-documentation', toErrorMessage(error));
  }
});

/**
 * POST /api/storage/seed/agent-configs
 * Recreate AI agent configuration files (skills, rules), overwriting existing files.
 */
app.post('/agent-configs', async (c) => {
  const bucketName = c.get('bucketName');
  const { accountId, endpoint } = await getR2Config(c.env);

  const bucketResult = await createBucketIfNotExists(accountId, c.env.CLOUDFLARE_API_TOKEN, bucketName);
  if (!bucketResult.success) {
    throw new ContainerError('seed-agent-configs', bucketResult.error || 'Failed to create storage bucket');
  }

  try {
    const seedResult = await seedAgentConfigs(c.env, bucketName, endpoint, { overwrite: true });

    logger.info('Recreated agent configs', {
      bucketName,
      bucketCreated: bucketResult.created === true,
      writtenCount: seedResult.written.length,
      skippedCount: seedResult.skipped.length,
    });

    // Invalidate storage-stats cache so next poll/fetch gets fresh data
    await c.env.KV.delete(`storage-stats:${bucketName}`);

    return c.json({
      success: true,
      bucketCreated: bucketResult.created === true,
      written: seedResult.written,
      skipped: seedResult.skipped,
    });
  } catch (error) {
    throw new ContainerError('seed-agent-configs', toErrorMessage(error));
  }
});

export default app;
