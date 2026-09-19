/**
 * Session lifecycle routes
 * Handles stop, status, and batch-status endpoints for session containers
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, UsageRecord, UserPreferences } from '../../types';
import { getMaxSessions, SESSION_ID_PATTERN } from '../../lib/constants';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { getContainerId } from '../../lib/container-helpers';
import { NotFoundError, ValidationError } from '../../lib/error-types';
import { fanOutBisyncTrigger } from '../../lib/sync-fanout';
import { D1SessionRepository } from '../../lib/session-repository';
import { getPreferencesKey, getTimekeeperKey, getUtcDateString, getUtcMonthString } from '../../lib/kv-keys';
import { PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';
import { planRegimeReconcile, advanceMigration } from '../../lib/r2-migration';
import { hasHealthyContainer } from '../../lib/migration-containers';
import { hasOwningSessionContainer } from '../../lib/session-helpers';
import { isSaasModeActive } from '../../lib/onboarding';
import { getTierConfig, getEffectiveTierForUser, isEnterpriseMode } from '../../lib/subscription';
import { getActiveManagedRelease, hasPendingManagedReconciliation } from '../../lib/managed-release-active';
import { resolveEffectiveSessionMode } from '../../lib/session-mode';
import { clearMatchingManagedReconcileProgress, readManagedReconcileProgress } from '../../lib/managed-reconcile-progress';
import { codingAgentProjectionIdentity } from '../../../scripts/ci/coding-agent-selection-core.mjs';

/**
 * Rate limiter for session stop
 * Limits to 10 stop requests per minute per user
 */
const sessionStopRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  keyPrefix: 'session-stop',
});

/**
 * Rate limiter for manual fan-out sync trigger (REQ-STOR-015 AC7).
 * 6/min matches the destructive-action pattern of session-stop / session-
 * delete. The Sync-now button is a user-driven action that should be
 * rare in normal use; 6/min covers reasonable usage without enabling
 * trigger spam against multiple containers.
 */
const sessionsSyncRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 6,
  keyPrefix: 'sessions-sync',
});

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * GET /api/sessions/batch-status
 * Get status for all sessions in a single call (eliminates N+1 on page load)
 * Returns the owner-scoped D1 lifecycle projection in one primary-consistent query.
 * Ancillary usage, storage, entitlement, release, and migration polling is owned
 * separately and is intentionally absent from this frequent endpoint.
 */
app.get('/batch-status', async (c) => {
  const ownerKey = c.get('bucketName');
  const sessions = await new D1SessionRepository(c.env.USAGE_DB).listSessions(ownerKey);
  const statuses = Object.fromEntries(sessions.map((session) => [session.sessionId, {
    status: session.lifecycleState,
    lifecycle: session.lifecycleState,
    generation: session.lifecycleGeneration,
    revision: session.responseRevision,
    lastActiveAt: session.lastActiveAt,
    lastStartedAt: session.lastStartedAt,
    editorReady: session.editorReady,
    editorReadyError: session.editorReadyError,
    unreachableIncidentId: session.unreachableIncidentId,
    unreachableDeadlineMs: session.unreachableDeadlineMs,
    metrics: {
      cpu: session.cpu,
      mem: session.memory,
      hdd: session.disk,
      syncStatus: session.syncStatus,
      updatedAt: session.metricsObservedAt,
    },
  }]));
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({ statuses });
});

/** Slower/event-driven owner for non-session dashboard state. */
app.get('/ancillary-status', async (c) => {
  const bucketName = c.get('bucketName');
  const user = c.get('user');
  let maxSessions = getMaxSessions(user.role, c.env);
  const storageStats = await c.env.KV.get(`storage-stats:${bucketName}`, 'json') as
    { totalFiles: number; totalFolders: number; totalSizeBytes: number } | null;

  let usage: { dailySeconds: number; monthlySeconds: number; monthlyQuotaSeconds: number | null; tier: string } | undefined;
  try {
    const tiers = await getTierConfig(c.env.KV);
    const entitlements = getEffectiveTierForUser(user, tiers, c.env);
    if (isSaasModeActive(c.env.SAAS_MODE)) maxSessions = entitlements.maxSessions;
    const record = await c.env.KV.get<UsageRecord>(getTimekeeperKey(bucketName), 'json');
    const now = new Date();
    usage = {
      dailySeconds: record?.today.date === getUtcDateString(now) ? record.today.seconds : 0,
      monthlySeconds: record?.thisMonth.month === getUtcMonthString(now) ? record.thisMonth.seconds : 0,
      monthlyQuotaSeconds: isSaasModeActive(c.env.SAAS_MODE) ? entitlements.monthlyQuotaSeconds : null,
      tier: entitlements.effectiveTier,
    };
  } catch { /* retain optional fields as unavailable */ }

  let preseedNeedsUpgrade: boolean | undefined;
  let preseedUpgradeTarget: string | undefined;
  let managedReleaseStatus: 'current' | 'upgrading' | 'update_pending' | undefined;
  let managedReleaseProgress: { phase: 'planning' | 'writing' | 'finalizing'; completed: number; total: number } | undefined;
  const prefs = await c.env.KV.get<UserPreferences>(getPreferencesKey(bucketName), 'json');
  const mode = await resolveEffectiveSessionMode(prefs ?? null, user, c.env);
  try {
    const projectionIdentity = codingAgentProjectionIdentity(c.env.CODING_AGENTS);
    const active = await getActiveManagedRelease(c.env);
    const applied = prefs?.managedEnvironmentApplied;
    const desiredPolicy = active?.resourcePolicy ?? 'mutable';
    const appliedPolicy = applied?.resourcePolicy ?? 'mutable';
    preseedUpgradeTarget = JSON.stringify([
      active ? 'managed' : 'baked', active?.digest ?? PRESEED_CONTENT_HASH,
      active?.pointer.sequence ?? null, mode, projectionIdentity, desiredPolicy,
    ]);
    const managedMismatch = hasPendingManagedReconciliation(prefs?.managedEnvironmentReconciliation) || (active
      ? applied?.digest !== active.digest
        || applied.mode !== mode
        || applied.sequence !== active.pointer.sequence
        || applied.projectionIdentity !== projectionIdentity
        || !/^[0-9a-f]{64}$/.test(applied.managedExtensionsDigest ?? '')
        || appliedPolicy !== desiredPolicy
        || (desiredPolicy !== 'mutable' && !/^[0-9a-f]{64}$/.test(applied.managedPathsDigest ?? ''))
        || (desiredPolicy === 'mutable' && applied.managedPathsDigest !== undefined)
      : applied !== undefined);
    const bakedMismatch = !active && (
      prefs?.lastPreseedHash !== PRESEED_CONTENT_HASH
      || prefs?.lastPreseedProjectionIdentity !== projectionIdentity
      || (isEnterpriseMode(c.env) && prefs?.sessionMode !== 'advanced')
    );
    const needsReconciliation = managedMismatch || bakedMismatch;
    const hasOwner = needsReconciliation ? await hasOwningSessionContainer(c.env, bucketName) : false;
    if (active || applied) managedReleaseStatus = managedMismatch ? (hasOwner ? 'update_pending' : 'upgrading') : 'current';
    if (active) {
      const progress = await readManagedReconcileProgress(c.env.KV, bucketName);
      if (!managedMismatch && progress?.targetDigest === active.digest) {
        if (progress.phase === 'finalizing') {
          managedReleaseStatus = 'upgrading';
          managedReleaseProgress = { phase: progress.phase, completed: progress.completed, total: progress.total };
        }
        await clearMatchingManagedReconcileProgress(c.env.KV, bucketName, active.digest);
      } else if (managedReleaseStatus === 'upgrading' && progress?.targetDigest === active.digest) {
        managedReleaseProgress = { phase: progress.phase, completed: progress.completed, total: progress.total };
      }
    }
    preseedNeedsUpgrade = needsReconciliation && !hasOwner;
  } catch {
    managedReleaseStatus = 'update_pending';
    preseedNeedsUpgrade = false;
  }

  const { state: regimeState, migrating: bucketMigrating, pending: bucketMigrationPending } = await planRegimeReconcile(
    c.env,
    bucketName,
    () => hasHealthyContainer(c.env, bucketName),
  );
  const migrationTotal = regimeState.total ?? 0;
  const bucketMigrationPercent = bucketMigrating && !regimeState.halted && migrationTotal > 0 && regimeState.processed != null
    ? Math.min(99, Math.max(0, Math.round((regimeState.processed / (2 * migrationTotal)) * 100)))
    : undefined;
  if (bucketMigrating) {
    try {
      c.executionCtx.waitUntil(advanceMigration(c.env, bucketName, {
        drainContainers: async () => {
          if (await hasOwningSessionContainer(c.env, bucketName)) throw new Error('Session workload owns the bucket');
        },
        hasHealthyContainer: () => hasHealthyContainer(c.env, bucketName),
      }));
    } catch { /* no execution context in direct unit requests */ }
  }

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    maxSessions, storageStats: storageStats ?? undefined, usage,
    preseedNeedsUpgrade, preseedUpgradeTarget, managedReleaseStatus, managedReleaseProgress,
    bucketMigrating, bucketMigrationPending, bucketMigrationPercent,
  });
});

/**
 * POST /api/sessions/sync
 *
 * User-driven Sync-now button (REQ-STOR-015 AC1). Thin wrapper over
 * `fanOutBisyncTrigger`; the helper holds the enumeration + fan-out
 * logic so the upload-side auto-trigger (REQ-STOR-015 AC4) can share
 * it without duplication.
 */
app.post('/sync', sessionsSyncRateLimiter, async (c) => {
  const bucketName = c.get('bucketName');
  const results = await fanOutBisyncTrigger(c.env, bucketName, 'manual');
  return c.json({ sessions: results, count: results.length });
});

/**
 * POST /api/sessions/:id/stop
 * Stop a session and destroy its container.
 * Use DELETE to remove a confirmed-stopped session from D1.
 */
app.post('/:id/stop', sessionStopRateLimiter, async (c) => {
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('id');
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ValidationError('Invalid sessionId format');
  }
  const repository = new D1SessionRepository(c.env.USAGE_DB);
  const existing = await repository.getSession(bucketName, sessionId);
  if (!existing) throw new NotFoundError('Session not found');
  if (existing.lifecycleState === 'stopped') return c.json({ success: true, stopped: true, id: sessionId });
  const intentId = existing.lifecycleState === 'stopping'
    ? existing.terminationIntentId
    : crypto.randomUUID();
  if (!intentId) throw new Error('Session stop ownership unavailable');
  const claimed = existing.lifecycleState === 'stopping'
    ? existing
    : await repository.claimStop(bucketName, sessionId, intentId, new Date().toISOString());
  if (!claimed) throw new Error('Session stop ownership unavailable');
  const containerId = getContainerId(bucketName, sessionId);
  await getContainer(c.env.CONTAINER, containerId).destroy();
  if (!await repository.confirmStopped(bucketName, sessionId, claimed.lifecycleGeneration, intentId, new Date().toISOString())) {
    throw new Error('Confirmed exit could not be persisted');
  }

  return c.json({ success: true, stopped: true, id: sessionId });
});

/**
 * GET /api/sessions/:id/status
 * Get session and container status
 */
app.get('/:id/status', async (c) => {
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('id');
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ValidationError('Invalid sessionId format');
  }
  const session = await new D1SessionRepository(c.env.USAGE_DB).getSession(bucketName, sessionId);
  if (!session) throw new NotFoundError('Session not found');
  return c.json({
    session,
    containerStatus: session.lifecycleState,
    status: session.lifecycleState,
    ptyActive: false,
    ptyInfo: null,
  }, 200, { 'Cache-Control': 'no-store' });
});

export default app;
