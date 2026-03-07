/**
 * Session lifecycle routes
 * Handles stop, status, and batch-status endpoints for session containers
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { DurableObjectStub } from '@cloudflare/workers-types';
import type { Env, Session } from '../../types';
import { getSessionKey, getSessionPrefix, listAllKvKeys, getSessionOrThrow } from '../../lib/kv-keys';
import { getMaxSessions, SESSION_ID_PATTERN } from '../../lib/constants';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { getContainerId, safeCheckContainerHealth } from '../../lib/container-helpers';
import { getContainerSessionsCB } from '../../lib/circuit-breakers';
import { toApiSession } from '../../lib/session-helpers';
import { ValidationError } from '../../lib/error-types';

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

  const keys = await listAllKvKeys(c.env.KV, prefix);
  const sessionPromises = keys.map(key => c.env.KV.get<Session>(key.name, 'json'));
  const sessionResults = await Promise.all(sessionPromises);
  const sessions: Session[] = sessionResults.filter((s): s is Session => s !== null);

  const statuses: Record<string, { status: string; ptyActive: boolean; lastActiveAt: string | null; lastStartedAt: string | null; metrics?: Session['metrics'] }> = {};

  for (const session of sessions) {
    const isRunning = session.status === 'running';
    statuses[session.id] = {
      status: isRunning ? 'running' : 'stopped',
      ptyActive: isRunning,
      lastActiveAt: session.lastActiveAt || null,
      lastStartedAt: session.lastStartedAt || null,
      metrics: session.metrics || undefined,
    };
  }

  const user = c.get('user');
  const maxSessions = getMaxSessions(user.role, c.env);

  // Include cached storage stats (already in KV from /api/storage/stats, 60s TTL)
  const storageStatsCached = await c.env.KV.get(`storage-stats:${bucketName}`, 'json') as { totalFiles: number; totalFolders: number; totalSizeBytes: number } | null;
  const storageStats = storageStatsCached || undefined;

  return c.json({ statuses, maxSessions, storageStats });
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
  session.status = 'stopped';
  session.lastStatusCheck = Date.now();
  await c.env.KV.put(key, JSON.stringify(session));

  // Best-effort container destroy — container may already be stopped
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
