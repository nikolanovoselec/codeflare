/**
 * Session lifecycle routes
 * Handles stop, status, and batch-status endpoints for session containers
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, Session, UserPreferences } from '../../types';
import { getSessionKey, getSessionPrefix, listAllKvKeys, getSessionOrThrow, getTimekeeperKey, getUtcMonthString, getUtcDateString, putSessionWithMetadata, expandSessionMetadata, buildSessionMetadata, getPreferencesKey, type SessionListMetadata } from '../../lib/kv-keys';
import { PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';
import { getMaxSessions, SESSION_ID_PATTERN } from '../../lib/constants';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { getContainerId, safeCheckContainerHealth } from '../../lib/container-helpers';
import { getContainerSessionsCB } from '../../lib/circuit-breakers';
import { toApiSession } from '../../lib/session-helpers';
import { ValidationError } from '../../lib/error-types';
import { isSaasModeActive } from '../../lib/onboarding';
import { getTierConfig, getEffectiveTierForUser } from '../../lib/subscription';
import { fanOutBisyncTrigger } from '../../lib/sync-fanout';
import type { UsageRecord } from '../../types';

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

  const statuses: Record<string, { status: string; ptyActive: boolean; lastActiveAt: string | null; lastStartedAt: string | null; metrics?: Session['metrics'] }> = {};
  const fallbackKeys: Array<{ name: string }> = [];

  for (const key of keys) {
    const meta = key.metadata as SessionListMetadata | null;
    if (meta && meta.s) {
      // Fast path: read status straight from list metadata (zero KV.get).
      // KV status is authoritative - the container writes 'stopped' on exit.
      const sessionId = key.name.split(':').pop()!;
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
      statuses[session.id] = expandSessionMetadata(buildSessionMetadata(session));
    }
  }

  const user = c.get('user');
  let maxSessions = getMaxSessions(user.role, c.env);

  // Include cached storage stats (already in KV from /api/storage/stats, 60s TTL)
  const storageStatsCached = await c.env.KV.get(`storage-stats:${bucketName}`, 'json') as { totalFiles: number; totalFolders: number; totalSizeBytes: number } | null;
  const storageStats = storageStatsCached || undefined;

  // Include usage data when SaaS mode is active
  let usage: { dailySeconds: number; monthlySeconds: number; monthlyQuotaSeconds: number | null; tier: string } | undefined;
  if (isSaasModeActive(c.env.SAAS_MODE)) {
    try {
      const [record, tiers] = await Promise.all([
        c.env.KV.get<UsageRecord>(getTimekeeperKey(bucketName), 'json'),
        getTierConfig(c.env.KV),
      ]);
      const entitlements = getEffectiveTierForUser(user, tiers);
      // REQ-SUB-013 AC4: the returned cap is the effective-tier cap in SaaS
      // mode (role-based cap stays the default outside SaaS mode).
      maxSessions = entitlements.maxSessions;
      const now = new Date();
      const currentMonth = getUtcMonthString(now);
      const currentDate = getUtcDateString(now);
      usage = {
        dailySeconds: (record && record.today.date === currentDate) ? record.today.seconds : 0,
        monthlySeconds: (record && record.thisMonth.month === currentMonth) ? record.thisMonth.seconds : 0,
        monthlyQuotaSeconds: entitlements.monthlyQuotaSeconds,
        tier: entitlements.effectiveTier,
      };
    } catch {
      // Non-fatal - usage display is best-effort
    }
  }

  // REQ-AGENT-049: preseed upgrade check (initial load only, not 5s polls)
  let preseedNeedsUpgrade: boolean | undefined;
  if (c.req.query('includePreseedCheck') === 'true') {
    const prefs = await c.env.KV.get<UserPreferences>(getPreferencesKey(bucketName), 'json');
    preseedNeedsUpgrade = prefs?.lastPreseedHash !== PRESEED_CONTENT_HASH;
  }

  return c.json({ statuses, maxSessions, storageStats, usage, preseedNeedsUpgrade });
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

  // Persist stopped status in KV so batch-status can skip container probes
  const updated = { ...session, status: 'stopped' as const, lastStatusCheck: Date.now() };
  await putSessionWithMetadata(c.env.KV, key, updated);

  // Best-effort container destroy - container may already be stopped
  try {
    const containerId = getContainerId(bucketName, sessionId);
    const container = getContainer(c.env.CONTAINER, containerId);
    await container.destroy();
  } catch { /* best-effort, container may already be stopped */ }

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
