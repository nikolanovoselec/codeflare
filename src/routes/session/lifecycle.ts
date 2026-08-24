/**
 * Session lifecycle routes
 * Handles stop, status, and batch-status endpoints for session containers
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, Session, UserPreferences } from '../../types';
import { getSessionKey, getSessionPrefix, listAllKvKeys, getSessionOrThrow, getTimekeeperKey, getUtcMonthString, getUtcDateString, putSessionWithMetadata, expandSessionMetadata, buildSessionMetadata, getPreferencesKey, type SessionListMetadata } from '../../lib/kv-keys';
import { PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';
import { planRegimeReconcile, advanceMigration } from '../../lib/r2-migration';
import { hasHealthyContainer, drainContainers } from '../../lib/migration-containers';
import { getMaxSessions, SESSION_ID_PATTERN } from '../../lib/constants';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { getContainerId, safeCheckContainerHealth } from '../../lib/container-helpers';
import { getContainerSessionsCB } from '../../lib/circuit-breakers';
import { toApiSession } from '../../lib/session-helpers';
import { ValidationError } from '../../lib/error-types';
import { isSaasModeActive } from '../../lib/onboarding';
import { getTierConfig, getEffectiveTierForUser, isEnterpriseMode } from '../../lib/subscription';
import { fanOutBisyncTrigger } from '../../lib/sync-fanout';
import type { UsageRecord } from '../../types';
import { getActiveManagedRelease } from '../../lib/managed-release-active';
import { resolveEffectiveSessionMode } from '../../lib/session-mode';
import { countsTowardSessionLimit } from '../container/lifecycle-validation';

/**
 * Check container health and PTY status for a session.
 * Returns the container status and whether the given session has an active PTY.
 */
async function getContainerSessionStatus(
  container: DurableObjectStub,
  sessionId: string,
  containerId: string
): Promise<{ status: string; ptyActive: boolean; terminalSessions: { id: string; [key: string]: unknown }[] }> {
  const healthResult = await safeCheckContainerHealth(container, containerId);

  if (!healthResult.healthy) {
    return { status: 'stopped', ptyActive: false, terminalSessions: [] };
  }

  let terminalSessions: { id: string; [key: string]: unknown }[] = [];
  try {
    const sessionsRes = await getContainerSessionsCB(containerId).execute(() =>
      container.fetch(
        new Request('http://container/sessions', { method: 'GET' })
      )
    );
    if (sessionsRes.ok) {
      const data = (await sessionsRes.json()) as {
        sessions: { id: string; [key: string]: unknown }[];
      };
      terminalSessions = data.sessions || [];
    }
  } catch {
    // PTY check failed, but container is healthy
  }

  // Terminal sessions use compound IDs: "sessionId-terminalId" (e.g., "abc123-1")
  // Match any terminal belonging to this session via prefix
  const ptyActive = terminalSessions.some((s) => s.id === sessionId || s.id.startsWith(sessionId + '-'));
  return { status: 'running', ptyActive, terminalSessions };
}

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
 * Returns a map of sessionId -> { status, ptyActive } plus storageStats from KV cache
 *
 * KV-ONLY: This endpoint never contacts Durable Objects or containers.
 * KV is authoritative for session status:
 * - POST /api/sessions/:id/stop sets KV to 'stopped'
 * - Container start sets KV to 'running'
 * - onStop() sets KV lastActiveAt on container hibernation
 *
 * This prevents phantom container auto-starts caused by container.fetch()
 * waking stopped containers during polling.
 */
app.get('/batch-status', async (c) => {
  const bucketName = c.get('bucketName');
  const prefix = getSessionPrefix(bucketName);

  // Read session status/metrics from KV list metadata (zero individual KV.get calls).
  // Keys written via putSessionWithMetadata() include compressed metadata.
  // Fallback to KV.get for pre-migration keys without metadata.
  const keys = await listAllKvKeys(c.env.KV, prefix);

  const statuses: Record<string, { status: string; ptyActive: boolean; lastActiveAt: string | null; lastStartedAt: string | null; editorReady?: boolean; editorReadyError?: boolean; metrics?: Session['metrics'] }> = {};
  const fallbackKeys: Array<{ name: string }> = [];
  let hasOwningSession = false;

  for (const key of keys) {
    const meta = key.metadata as SessionListMetadata | null;
    if (meta && meta.s) {
      // Fast path: read status straight from list metadata (zero KV.get).
      // KV status is authoritative - the container writes 'stopped' on exit.
      const sessionId = key.name.split(':').pop()!;
      if (countsTowardSessionLimit(meta.s)) hasOwningSession = true;
      statuses[sessionId] = expandSessionMetadata(meta);
    } else {
      // Pre-migration key without metadata - queue for fallback KV.get
      fallbackKeys.push(key);
    }
  }

  // Fallback: fetch full session for keys without metadata (graceful migration)
  if (fallbackKeys.length > 0) {
    const fallbackResults = await Promise.all(
      fallbackKeys.map(key => c.env.KV.get<Session>(key.name, 'json'))
    );
    for (const session of fallbackResults) {
      if (!session) continue;
      if (countsTowardSessionLimit(session.status)) hasOwningSession = true;
      statuses[session.id] = expandSessionMetadata(buildSessionMetadata(session));
    }
  }

  const user = c.get('user');
  let maxSessions = getMaxSessions(user.role, c.env);

  // Include cached storage stats (already in KV from /api/storage/stats, 60s TTL)
  const storageStatsCached = await c.env.KV.get(`storage-stats:${bucketName}`, 'json') as { totalFiles: number; totalFolders: number; totalSizeBytes: number } | null;
  const storageStats = storageStatsCached || undefined;

  // Include per-user consumption in every deployment mode. Only SaaS exposes
  // billing quota and derives the session cap from subscription entitlements.
  let usage: { dailySeconds: number; monthlySeconds: number; monthlyQuotaSeconds: number | null; tier: string } | undefined;
  const saasMode = isSaasModeActive(c.env.SAAS_MODE);
  try {
    const [record, tiers] = await Promise.all([
      c.env.KV.get<UsageRecord>(getTimekeeperKey(bucketName), 'json'),
      getTierConfig(c.env.KV),
    ]);
    const entitlements = getEffectiveTierForUser(user, tiers, c.env);
    if (saasMode) {
      // REQ-SUB-013 AC4: SaaS uses the effective-tier cap; role-based limits
      // remain authoritative in onboarding/default/enterprise deployments.
      maxSessions = entitlements.maxSessions;
    }
    const now = new Date();
    const currentMonth = getUtcMonthString(now);
    const currentDate = getUtcDateString(now);
    usage = {
      dailySeconds: (record && record.today.date === currentDate) ? record.today.seconds : 0,
      monthlySeconds: (record && record.thisMonth.month === currentMonth) ? record.thisMonth.seconds : 0,
      monthlyQuotaSeconds: saasMode ? entitlements.monthlyQuotaSeconds : null,
      tier: entitlements.effectiveTier,
    };
  } catch {
    // Non-fatal - usage display is best-effort
  }

  // Initial-load upgrade decision. Remote curation piggybacks on this existing
  // request and existing reconcile route; it does not add another poller.
  let preseedNeedsUpgrade: boolean | undefined;
  let managedReleaseStatus: 'current' | 'upgrading' | 'update_pending' | undefined;
  if (c.req.query('includePreseedCheck') === 'true') {
    const prefs = await c.env.KV.get<UserPreferences>(getPreferencesKey(bucketName), 'json');
    const mode = await resolveEffectiveSessionMode(prefs ?? null, user, c.env);
    try {
      const active = await getActiveManagedRelease(c.env);
      const applied = prefs?.managedEnvironmentApplied;
      const managedMismatch = active
        ? applied?.digest !== active.digest
          || applied.mode !== mode
          || applied.sequence !== active.pointer.sequence
          || !/^[0-9a-f]{64}$/.test(applied.managedExtensionsDigest ?? '')
        : applied !== undefined;

      if (active || applied) {
        managedReleaseStatus = managedMismatch
          ? (hasOwningSession ? 'update_pending' : 'upgrading')
          : 'current';
      }

      const bakedMismatch = !active && (
        prefs?.lastPreseedHash !== PRESEED_CONTENT_HASH
        || (isEnterpriseMode(c.env) && prefs?.sessionMode !== 'advanced')
      );
      // Never fire the mutating route while a session owns the bucket. The
      // update_pending state remains visible and blocks another start.
      preseedNeedsUpgrade = (managedMismatch || bakedMismatch) && !hasOwningSession;
    } catch {
      // Cache availability may fail open only to a previously applied verified
      // bucket state. A fresh bucket remains blocked and must not trigger a
      // reconciliation request until the verified deployment cache is readable.
      managedReleaseStatus = prefs?.managedEnvironmentApplied?.mode === mode
        && /^[0-9a-f]{64}$/.test(prefs.managedEnvironmentApplied.managedExtensionsDigest ?? '')
        ? 'current'
        : 'update_pending';
      preseedNeedsUpgrade = false;
    }
  }

  // REQ-ENTERPRISE-020: Governed Mode regime reconcile. Decide synchronously so THIS
  // response reports `bucketMigrating` (the New Session button reuses the Upgrading gate);
  // a no-op when the bucket already matches the deployment policy. The lossless re-encrypt
  // runs one bounded chunk per poll in the BACKGROUND so it never blocks this response or
  // session creation; running on every batch-status poll (not just initial load) is what
  // advances the chunked pass to completion. D1: a pending flip waits for running sessions
  // to stop (no force-kill).
  const { state: regimeState, migrating: bucketMigrating, pending: bucketMigrationPending } = await planRegimeReconcile(
    c.env,
    bucketName,
    () => hasHealthyContainer(c.env, bucketName),
  );
  // REQ-ENTERPRISE-020: a 0–99 progress % for the Migrating button, computed across BOTH passes
  // (migrate then verify) as processed/(2·total). Undefined until `total` is counted (first poll shows a
  // plain "Migrating"), when total is 0 (empty/too-large bucket ⇒ no %), or when the migration has halted
  // (wedged on an un-migratable object — a % there would misleadingly read "99%").
  const migrationTotal = regimeState.total ?? 0;
  const bucketMigrationPercent = bucketMigrating && !regimeState.halted && migrationTotal > 0 && regimeState.processed != null
    ? Math.min(99, Math.max(0, Math.round((regimeState.processed / (2 * migrationTotal)) * 100)))
    : undefined;
  if (bucketMigrating) {
    // waitUntil so the chunk never delays this response; a synthetic request with no
    // execution context (unit tests) simply skips the background advance.
    try {
      c.executionCtx.waitUntil(
        advanceMigration(c.env, bucketName, {
          drainContainers: () => drainContainers(c.env, bucketName),
          hasHealthyContainer: () => hasHealthyContainer(c.env, bucketName),
        }),
      );
    } catch {
      /* no execution context (e.g. unit tests) — skip the background advance */
    }
  }

  return c.json({ statuses, maxSessions, storageStats, usage, preseedNeedsUpgrade, managedReleaseStatus, bucketMigrating, bucketMigrationPending, bucketMigrationPercent });
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
  const results = await fanOutBisyncTrigger(c.env, bucketName);
  return c.json({ sessions: results, count: results.length });
});

/**
 * POST /api/sessions/:id/stop
 * Stop a session and destroy its container.
 * Use DELETE to fully remove the session from KV.
 */
app.post('/:id/stop', sessionStopRateLimiter, async (c) => {
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('id');
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ValidationError('Invalid sessionId format');
  }
  const key = getSessionKey(bucketName, sessionId);

  const session = await getSessionOrThrow(c.env.KV, key);

  // Destruction owns graceful shutdown and final sync. Keep the current KV state
  // retryable until that boundary confirms success.
  const containerId = getContainerId(bucketName, sessionId);
  const container = getContainer(c.env.CONTAINER, containerId);
  await container.destroy();

  const updated = { ...session, status: 'stopped' as const, lastStatusCheck: Date.now() };
  await putSessionWithMetadata(c.env.KV, key, updated);

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
  const key = getSessionKey(bucketName, sessionId);

  const session = await getSessionOrThrow(c.env.KV, key);

  // If KV says stopped, skip container probe to avoid waking the Durable Object
  if (session.status === 'stopped') {
    return c.json({
      session: toApiSession(session),
      containerStatus: 'stopped',
      status: 'stopped',
      ptyActive: false,
      ptyInfo: null,
    });
  }

  // Check container status
  let result = { status: 'stopped', ptyActive: false, terminalSessions: [] as { id: string; [key: string]: unknown }[] };

  try {
    const containerId = getContainerId(bucketName, sessionId);
    const container = getContainer(c.env.CONTAINER, containerId);
    result = await getContainerSessionStatus(container, sessionId, containerId);
  } catch {
    // Container check failed - defaults to stopped
  }

  const activePty = result.terminalSessions.find((s) => s.id === sessionId);

  return c.json({
    session: toApiSession(session),
    containerStatus: result.status,
    status: result.status === 'running' ? 'running' : 'stopped',
    ptyActive: result.ptyActive,
    ptyInfo: activePty || null,
  });
});

export default app;
