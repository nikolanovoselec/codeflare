import { Hono } from 'hono';
import type { Env, UserPreferences } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createBucketIfNotExists } from '../../lib/r2-admin';
import { getR2Config } from '../../lib/r2-config';
import { seedGettingStartedDocs, reconcileAgentConfigs } from '../../lib/r2-seed';
import { PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';
import { createRateLimiter } from '../../middleware/rate-limit';
import { ContainerError, toErrorMessage } from '../../lib/error-types';
import { createLogger } from '../../lib/logger';
import { getPreferencesKey } from '../../lib/kv-keys';
import { resolveSessionMode } from '../../lib/session-mode';
import { getEffectiveTier } from '../../lib/subscription';

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
 * Respects the user's session mode preference — cleans up files not in the current mode.
 */
app.post('/agent-configs', async (c) => {
  const bucketName = c.get('bucketName');
  const { accountId, endpoint } = await getR2Config(c.env);

  const bucketResult = await createBucketIfNotExists(accountId, c.env.CLOUDFLARE_API_TOKEN, bucketName);
  if (!bucketResult.success) {
    throw new ContainerError('seed-agent-configs', bucketResult.error || 'Failed to create storage bucket');
  }

  try {
    // Resolve session mode from user preferences
    const preferencesKey = getPreferencesKey(bucketName);
    const preferences = await c.env.KV.get<UserPreferences>(preferencesKey, 'json');
    const mode = resolveSessionMode(preferences ?? null);

    const user = c.get('user');
    const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd);
    const contextModeEnabled = effectiveTier === 'unlimited' && mode === 'advanced';

    const result = await reconcileAgentConfigs(c.env, bucketName, endpoint, mode, {
      overwrite: true,
      cleanup: true,
      contextModeEnabled,
    });

    logger.info('Recreated agent configs', {
      bucketName,
      mode,
      contextModeEnabled,
      bucketCreated: bucketResult.created === true,
      writtenCount: result.written.length,
      deletedCount: result.deleted.length,
    });

    // Invalidate storage-stats cache so next poll/fetch gets fresh data
    await c.env.KV.delete(`storage-stats:${bucketName}`);

    // REQ-AGENT-049: persist preseed hash so next batch-status check skips upgrade
    const updatedPreferences = { ...preferences, lastPreseedHash: PRESEED_CONTENT_HASH };
    await c.env.KV.put(preferencesKey, JSON.stringify(updatedPreferences));

    return c.json({
      success: true,
      bucketCreated: bucketResult.created === true,
      written: result.written,
      skipped: result.skipped,
      deleted: result.deleted,
      warnings: result.warnings,
    });
  } catch (error) {
    throw new ContainerError('seed-agent-configs', toErrorMessage(error));
  }
});

export default app;
