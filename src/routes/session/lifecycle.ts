/**
 * Session lifecycle routes
 * Handles stop, status, and batch-status endpoints for session containers
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env } from '../../types';
import { getMaxSessions, SESSION_ID_PATTERN } from '../../lib/constants';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { getContainerId } from '../../lib/container-helpers';
import { NotFoundError, ValidationError } from '../../lib/error-types';
import { fanOutBisyncTrigger } from '../../lib/sync-fanout';
import { D1SessionRepository } from '../../lib/session-repository';

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
  return c.json({ statuses, maxSessions: getMaxSessions(c.get('user').role, c.env) });
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
  const intentId = crypto.randomUUID();
  const claimed = await repository.claimStop(bucketName, sessionId, intentId, new Date().toISOString());
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
