import { Hono, type Context } from 'hono';
import type { Env, UserPreferences } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createBucketIfNotExists } from '../../lib/r2-admin';
import { getR2Config } from '../../lib/r2-config';
import { managedExtensionsDocumentDigest, seedGettingStartedDocs, reconcileAgentConfigs, reseedContextModePlugin, type PriorManagedReleaseSelection } from '../../lib/r2-seed';
import { resolveBucketSseOnEnsure, isBucketMigrating } from '../../lib/r2-migration';
import { PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError, ContainerError, BucketMigratingError, ManagedEnvironmentUpdatePendingError, toErrorMessage } from '../../lib/error-types';
import { createLogger } from '../../lib/logger';
import { getPreferencesKey } from '../../lib/kv-keys';
import { writeManagedReconcileProgress } from '../../lib/managed-reconcile-progress';
import { resolveEffectiveSessionMode } from '../../lib/session-mode';
import { getEffectiveTier, isEnterpriseMode } from '../../lib/subscription';
import { hasOwningSessionContainer } from '../../lib/session-helpers';
import {
  appendManagedReconciliationTarget,
  getActiveManagedRelease,
  getActiveVerifiedManagedRelease,
  getCachedManagedReleaseByDigest,
  readManagedReconciliationTargets,
  type ManagedReconciliationTarget,
} from '../../lib/managed-release-active';
import { getManagedEnvironmentConfig } from '../../lib/remote-curation';

const logger = createLogger('storage-seed');

const storageSeedRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 3,
  keyPrefix: 'storage-seed',
});

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', storageSeedRateLimiter);

async function assertNoOwningSession(
  env: Pick<Env, 'KV' | 'CONTAINER'>,
  bucketName: string,
): Promise<void> {
  if (await hasOwningSessionContainer(env, bucketName)) {
    throw new ManagedEnvironmentUpdatePendingError();
  }
}

function assertAppliedManagedIdentity(applied: NonNullable<UserPreferences['managedEnvironmentApplied']>): void {
  if (
    !/^[0-9a-f]{64}$/.test(applied.digest)
    || !Number.isSafeInteger(applied.sequence)
    || applied.sequence <= 0
    || (applied.mode !== 'default' && applied.mode !== 'advanced')
  ) {
    throw new Error('Previously applied managed release identity is invalid');
  }
}

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
async function reconcileAgentConfigsForRequest(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  automatic: boolean,
): Promise<Response> {
  const bucketName = c.get('bucketName');
  const preferencesKey = getPreferencesKey(bucketName);
  const preferences = await c.env.KV.get<UserPreferences>(preferencesKey, 'json');
  const user = c.get('user');
  const mode = await resolveEffectiveSessionMode(preferences ?? null, user, c.env);

  try {
    const activeManagedRelease = await getActiveVerifiedManagedRelease(c.env);
    const managedConfig = await getManagedEnvironmentConfig(c.env.KV);
    if (activeManagedRelease && !managedConfig) throw new Error('Active managed release has no valid managed environment configuration');
    const resourcePolicy = activeManagedRelease ? managedConfig!.resourcePolicy : 'mutable';
    let priorManagedRelease: PriorManagedReleaseSelection | undefined;
    let priorManagedDigest: string | undefined;
    const applied = preferences?.managedEnvironmentApplied;
    if (applied) {
      if (automatic) assertAppliedManagedIdentity(applied);
      const priorRelease = activeManagedRelease?.digest === applied.digest
        ? { compressed: activeManagedRelease.compressed, release: activeManagedRelease.release }
        : await getCachedManagedReleaseByDigest(c.env, applied.digest);
      if (priorRelease) {
        if (automatic && priorRelease.release.sequence !== applied.sequence) {
          throw new Error('Previously applied managed release identity conflicts with cached content');
        }
        priorManagedRelease = { digest: applied.digest, mode: applied.mode, ...priorRelease };
      } else if (!activeManagedRelease) {
        throw new Error('Previously applied managed release is unavailable while disabling Managed Environment');
      } else {
        if (!/^[0-9a-f]{64}$/.test(applied.digest)) throw new Error('Previously applied managed release digest is invalid');
        priorManagedDigest = applied.digest;
      }
    }

    // Preserve ordinary baked reseed behavior. The no-hot-mutation gate applies
    // only while curation is active or while a prior curated state must converge
    // back to baked content.
    if (activeManagedRelease || applied || preferences?.managedEnvironmentReconciliation) {
      await assertNoOwningSession(c.env, bucketName);
    }

    // REQ-ENTERPRISE-020: block reseed while the bucket's encryption regime is migrating.
    if (await isBucketMigrating(c.env, bucketName)) throw new BucketMigratingError();

    const latestPreferencesBeforeReconcile = await c.env.KV.get<UserPreferences>(preferencesKey, 'json') ?? {};
    if (
      automatic
      && activeManagedRelease
      && JSON.stringify(latestPreferencesBeforeReconcile.managedEnvironmentApplied ?? null) !== JSON.stringify(applied ?? null)
    ) {
      throw new Error('Managed reconciliation applied identity changed before planning');
    }
    const existingTargets = readManagedReconciliationTargets(
      latestPreferencesBeforeReconcile.managedEnvironmentReconciliation,
    );
    let expectedReconciliationTargets: ManagedReconciliationTarget[] | undefined;
    if (activeManagedRelease) {
      expectedReconciliationTargets = appendManagedReconciliationTarget(existingTargets, {
        digest: activeManagedRelease.digest,
        sequence: activeManagedRelease.release.sequence,
        mode,
      });
    }

    const interruptedManagedReleases: PriorManagedReleaseSelection[] = [];
    for (const target of existingTargets) {
      if (activeManagedRelease && target.digest === activeManagedRelease.digest && target.mode === mode) {
        if (target.sequence !== activeManagedRelease.release.sequence) {
          throw new Error('Managed reconciliation target identity conflicts with active content');
        }
        continue;
      }
      const content = activeManagedRelease && target.digest === activeManagedRelease.digest
        ? { compressed: activeManagedRelease.compressed, release: activeManagedRelease.release }
        : await getCachedManagedReleaseByDigest(c.env, target.digest);
      if (!content || content.release.sequence !== target.sequence) {
        throw new Error('Interrupted managed release identity is unavailable or conflicting');
      }
      interruptedManagedReleases.push({
        digest: target.digest,
        mode: target.mode,
        compressed: content.compressed,
        release: content.release,
      });
    }
    if (expectedReconciliationTargets) {
      await c.env.KV.put(preferencesKey, JSON.stringify({
        ...latestPreferencesBeforeReconcile,
        managedEnvironmentReconciliation: { targets: expectedReconciliationTargets },
      }));
    }

    const { accountId, endpoint } = await getR2Config(c.env);
    const bucketResult = await createBucketIfNotExists(accountId, c.env.CLOUDFLARE_API_TOKEN, bucketName);
    if (!bucketResult.success) {
      throw new ContainerError('seed-agent-configs', bucketResult.error || 'Failed to create storage bucket');
    }

    // REQ-ENTERPRISE-020: reconcile in the bucket's current regime (see getting-started above).
    const r2SseDisabled = await resolveBucketSseOnEnsure(c.env, bucketName, bucketResult.created === true);
    const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd, c.env);
    const contextModeEnabled = effectiveTier === 'unlimited' && mode === 'advanced';
    const validateAutomaticTarget = activeManagedRelease && automatic
      ? async (): Promise<void> => {
          const currentActive = await getActiveManagedRelease(c.env);
          const currentPreferences = await c.env.KV.get<UserPreferences>(preferencesKey, 'json') ?? {};
          const currentMode = await resolveEffectiveSessionMode(currentPreferences, user, c.env);
          const currentSseDisabled = await resolveBucketSseOnEnsure(c.env, bucketName, false);
          await assertNoOwningSession(c.env, bucketName);
          if (await isBucketMigrating(c.env, bucketName)) throw new BucketMigratingError();
          if (
            !currentActive
            || currentActive.digest !== activeManagedRelease.digest
            || currentActive.pointer.sequence !== activeManagedRelease.release.sequence
            || currentActive.resourcePolicy !== resourcePolicy
            || currentMode !== mode
            || currentSseDisabled !== r2SseDisabled
            || JSON.stringify(currentPreferences.managedEnvironmentReconciliation?.targets ?? [])
              !== JSON.stringify(expectedReconciliationTargets ?? [])
          ) {
            throw new Error('Managed reconciliation target changed before finalization');
          }
        }
      : undefined;
    let completionProgress: { phase: 'planning' | 'writing' | 'finalizing'; completed: number; total: number } | undefined;
    const managedOptions = activeManagedRelease
      ? {
          managedRelease: { digest: activeManagedRelease.digest, compressed: activeManagedRelease.compressed, release: activeManagedRelease.release },
          resourcePolicy,
          ...(priorManagedRelease ? { priorManagedRelease } : priorManagedDigest ? { priorManagedDigest } : {}),
          ...(interruptedManagedReleases.length > 0 ? { interruptedManagedReleases } : {}),
          ...(automatic ? {
            automatic: {
              assumeEmpty: bucketResult.created === true,
              beforeCleanup: validateAutomaticTarget,
              onProgress: async ({ completed, total }: { completed: number; total: number }) => {
                if (completed === 0 || completed === total || completed % 25 === 0) {
                  const phase = completed === total ? 'finalizing' : 'writing';
                  await writeManagedReconcileProgress(c.env.KV, bucketName, {
                    targetDigest: activeManagedRelease.digest,
                    phase,
                    completed,
                    total,
                  });
                  completionProgress = { phase, completed, total };
                }
              },
            },
          } : {}),
        }
      : priorManagedRelease
        ? {
            managedRelease: null,
            priorManagedRelease,
            resourcePolicy: 'mutable' as const,
            ...(interruptedManagedReleases.length > 0 ? { interruptedManagedReleases } : {}),
          }
        : priorManagedDigest
          ? { resourcePolicy: 'mutable' as const }
          : interruptedManagedReleases.length > 0
            ? {
                managedRelease: null,
                interruptedManagedReleases,
                resourcePolicy: 'mutable' as const,
              }
            : {};

    if (automatic && activeManagedRelease) {
      await writeManagedReconcileProgress(c.env.KV, bucketName, {
        targetDigest: activeManagedRelease.digest,
        phase: 'planning',
        completed: 0,
        total: 0,
      });
    }

    const result = await reconcileAgentConfigs(c.env, bucketName, endpoint, mode, {
      overwrite: true,
      cleanup: true,
      contextModeEnabled,
      r2SseDisabled,
      ...managedOptions,
    });
    if ((activeManagedRelease || priorManagedRelease || priorManagedDigest) && result.warnings.length > 0) {
      throw new Error(`Managed reconciliation did not complete: ${result.warnings[0]}`);
    }
    if (resourcePolicy !== 'mutable' && !result.managedPathsDigest) {
      throw new Error('Protected managed-resource reconciliation did not verify policy identity');
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

    await validateAutomaticTarget?.();

    // Re-read to preserve concurrent preference changes. The applied stamp is the
    // final side effect: no caller can observe current until all R2/context work and
    // cache invalidation have succeeded.
    const latestPreferences = await c.env.KV.get<UserPreferences>(preferencesKey, 'json') ?? {};
    if (
      JSON.stringify(latestPreferences.managedEnvironmentReconciliation?.targets ?? [])
      !== JSON.stringify(expectedReconciliationTargets ?? existingTargets)
    ) {
      throw new Error('Managed reconciliation target state changed before publication');
    }
    const withoutManagedState = Object.fromEntries(
      Object.entries(latestPreferences).filter(([key]) => (
        key !== 'managedEnvironmentApplied' && key !== 'managedEnvironmentReconciliation'
      )),
    ) as UserPreferences;
    const enterpriseMode = isEnterpriseMode(c.env);
    const updatedPreferences: UserPreferences = activeManagedRelease
      ? {
          ...withoutManagedState,
          ...(enterpriseMode ? { sessionMode: 'advanced' as const } : {}),
          managedEnvironmentApplied: {
            digest: activeManagedRelease.digest,
            managedExtensionsDigest: await managedExtensionsDocumentDigest(activeManagedRelease),
            sequence: activeManagedRelease.release.sequence,
            mode,
            resourcePolicy,
            ...(result.managedPathsDigest ? { managedPathsDigest: result.managedPathsDigest } : {}),
            appliedAt: new Date().toISOString(),
          },
        }
      : {
          ...withoutManagedState,
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
      ...(completionProgress && activeManagedRelease ? {
        managedReleaseProgress: completionProgress,
      } : {}),
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new ContainerError('seed-agent-configs', toErrorMessage(error));
  }
}

app.post('/agent-configs', (c) => reconcileAgentConfigsForRequest(c, false));
app.post('/agent-configs/upgrade', (c) => reconcileAgentConfigsForRequest(c, true));

export default app;
