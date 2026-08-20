import { Hono } from 'hono';
import type { Env, UserPreferences } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createBucketIfNotExists } from '../../lib/r2-admin';
import { getR2Config } from '../../lib/r2-config';
import { seedGettingStartedDocs, reconcileAgentConfigs, reseedContextModePlugin, type PriorManagedReleaseSelection } from '../../lib/r2-seed';
import { resolveBucketSseOnEnsure, isBucketMigrating } from '../../lib/r2-migration';
import { PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError, ContainerError, BucketMigratingError, ManagedEnvironmentUpdatePendingError, toErrorMessage } from '../../lib/error-types';
import { createLogger } from '../../lib/logger';
import { getPreferencesKey, getSessionPrefix, listAllKvKeys, type SessionListMetadata } from '../../lib/kv-keys';
import { resolveEffectiveSessionMode } from '../../lib/session-mode';
import { getEffectiveTier, isEnterpriseMode } from '../../lib/subscription';
import { countsTowardSessionLimit } from '../container/lifecycle-validation';
import { getActiveVerifiedManagedRelease, getCachedManagedReleaseByDigest } from '../../lib/managed-release-active';

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
  // REQ-ENTERPRISE-020: block reseed while the bucket's encryption regime is migrating.
  if (await isBucketMigrating(c.env, bucketName)) throw new BucketMigratingError();
  const { accountId, endpoint } = await getR2Config(c.env);

  const bucketResult = await createBucketIfNotExists(accountId, c.env.CLOUDFLARE_API_TOKEN, bucketName);
  if (!bucketResult.success) {
    throw new ContainerError('seed-documentation', bucketResult.error || 'Failed to create storage bucket');
  }

  // REQ-ENTERPRISE-020: write the starter docs in the bucket's current regime so
  // they are readable (new bucket adopts policy; existing keeps its marker).
  const r2SseDisabled = await resolveBucketSseOnEnsure(c.env, bucketName, bucketResult.created === true);

  try {
    const seedResult = await seedGettingStartedDocs(c.env, bucketName, endpoint, { overwrite: true, r2SseDisabled });

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
  const preferencesKey = getPreferencesKey(bucketName);
  const preferences = await c.env.KV.get<UserPreferences>(preferencesKey, 'json');
  const user = c.get('user');
  const mode = await resolveEffectiveSessionMode(preferences ?? null, user, c.env);

  try {
    const activeManagedRelease = await getActiveVerifiedManagedRelease(c.env);
    let priorManagedRelease: PriorManagedReleaseSelection | undefined;
    const applied = preferences?.managedEnvironmentApplied;
    if (applied) {
      const priorRelease = activeManagedRelease?.digest === applied.digest
        ? { compressed: activeManagedRelease.compressed, release: activeManagedRelease.release }
        : await getCachedManagedReleaseByDigest(c.env, applied.digest);
      if (!priorRelease) throw new Error('Previously applied managed release is missing from the verified deployment cache');
      priorManagedRelease = { digest: applied.digest, mode: applied.mode, ...priorRelease };
    }

    // Preserve ordinary baked reseed behavior. The no-hot-mutation gate applies
    // only while curation is active or while a prior curated state must converge
    // back to baked content.
    if (activeManagedRelease || applied) {
      const sessionKeys = await listAllKvKeys(c.env.KV, getSessionPrefix(bucketName));
      for (const key of sessionKeys) {
        const metadata = key.metadata as SessionListMetadata | null;
        if (metadata?.s && countsTowardSessionLimit(metadata.s)) throw new ManagedEnvironmentUpdatePendingError();
        if (!metadata?.s) {
          const session = await c.env.KV.get<{ status?: string }>(key.name, 'json');
          if (countsTowardSessionLimit(session?.status)) throw new ManagedEnvironmentUpdatePendingError();
        }
      }
    }

    // REQ-ENTERPRISE-020: block reseed while the bucket's encryption regime is migrating.
    if (await isBucketMigrating(c.env, bucketName)) throw new BucketMigratingError();

    const { accountId, endpoint } = await getR2Config(c.env);
    const bucketResult = await createBucketIfNotExists(accountId, c.env.CLOUDFLARE_API_TOKEN, bucketName);
    if (!bucketResult.success) {
      throw new ContainerError('seed-agent-configs', bucketResult.error || 'Failed to create storage bucket');
    }

    // REQ-ENTERPRISE-020: reconcile in the bucket's current regime (see getting-started above).
    const r2SseDisabled = await resolveBucketSseOnEnsure(c.env, bucketName, bucketResult.created === true);
    const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd, c.env);
    const contextModeEnabled = effectiveTier === 'unlimited' && mode === 'advanced';
    const managedOptions = activeManagedRelease
      ? { managedRelease: { digest: activeManagedRelease.digest, compressed: activeManagedRelease.compressed, release: activeManagedRelease.release }, ...(priorManagedRelease && { priorManagedRelease }) }
      : priorManagedRelease
        ? { managedRelease: null, priorManagedRelease }
        : {};

    const result = await reconcileAgentConfigs(c.env, bucketName, endpoint, mode, {
      overwrite: true,
      cleanup: true,
      contextModeEnabled,
      r2SseDisabled,
      ...managedOptions,
    });
    if ((activeManagedRelease || priorManagedRelease) && result.warnings.length > 0) {
      throw new Error(`Managed reconciliation did not complete: ${result.warnings[0]}`);
    }

    // Context-mode stays image-owned even during remote curation. Complete this
    // separate reconciliation before recording the managed release as applied.
    if (activeManagedRelease) {
      await reseedContextModePlugin(c.env, bucketName, endpoint, contextModeEnabled, r2SseDisabled);
    }

    logger.info('Recreated agent configs', {
      bucketName,
      mode,
      contextModeEnabled,
      managedReleaseDigest: activeManagedRelease?.digest,
      bucketCreated: bucketResult.created === true,
      writtenCount: result.written.length,
      deletedCount: result.deleted.length,
    });

    await c.env.KV.delete(`storage-stats:${bucketName}`);

    // Re-read to preserve concurrent preference changes. The applied stamp is the
    // final side effect: no caller can observe current until all R2/context work and
    // cache invalidation have succeeded.
    const latestPreferences = await c.env.KV.get<UserPreferences>(preferencesKey, 'json') ?? {};
    const withoutApplied = Object.fromEntries(
      Object.entries(latestPreferences).filter(([key]) => key !== 'managedEnvironmentApplied'),
    ) as UserPreferences;
    const enterpriseMode = isEnterpriseMode(c.env);
    const updatedPreferences: UserPreferences = activeManagedRelease
      ? {
          ...latestPreferences,
          ...(enterpriseMode ? { sessionMode: 'advanced' as const } : {}),
          managedEnvironmentApplied: {
            digest: activeManagedRelease.digest,
            sequence: activeManagedRelease.release.sequence,
            mode,
            appliedAt: new Date().toISOString(),
          },
        }
      : {
          ...withoutApplied,
          lastPreseedHash: PRESEED_CONTENT_HASH,
          ...(enterpriseMode ? { sessionMode: 'advanced' as const } : {}),
        };
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
    if (error instanceof AppError) throw error;
    throw new ContainerError('seed-agent-configs', toErrorMessage(error));
  }
});

export default app;
