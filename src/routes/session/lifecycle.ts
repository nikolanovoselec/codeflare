/**
 * Session lifecycle routes
 * Handles start/stop/status endpoints for session containers
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { DurableObjectStub } from '@cloudflare/workers-types';
import type { Env, Session } from '../../types';
import { getSessionKey, getSessionPrefix, listAllKvKeys, getSessionOrThrow } from '../../lib/kv-keys';
import { AuthVariables } from '../../middleware/auth';
import { getContainerId, safeCheckContainerHealth } from '../../lib/container-helpers';
import { createLogger } from '../../lib/logger';
import { containerSessionsCB } from '../../lib/circuit-breakers';
import { toApiSession } from '../../lib/session-helpers';

const logger = createLogger('session-lifecycle');

/**
 * Check container health and PTY status for a session.
 * Returns the container status and whether the given session has an active PTY.
 */
async function getContainerSessionStatus(
  container: DurableObjectStub,
  sessionId: string
): Promise<{ status: string; ptyActive: boolean; terminalSessions: { id: string; [key: string]: unknown }[] }> {
  const healthResult = await safeCheckContainerHealth(container);

  if (!healthResult.healthy) {
    return { status: 'stopped', ptyActive: false, terminalSessions: [] };
  }

  let terminalSessions: { id: string; [key: string]: unknown }[] = [];
  try {
    const sessionsRes = await containerSessionsCB.execute(() =>
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

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * GET /api/sessions/batch-status
 * Get status for all sessions in a single call (eliminates N+1 on page load)
 * Returns a map of sessionId -> { status, ptyActive }
 */
app.get('/batch-status', async (c) => {
  const reqLogger = logger.child({ requestId: c.get('requestId') });
  const bucketName = c.get('bucketName');
  const prefix = getSessionPrefix(bucketName);

  // List all sessions for this user
  const keys = await listAllKvKeys(c.env.KV, prefix);
  const sessionPromises = keys.map(key => c.env.KV.get<Session>(key.name, 'json'));
  const sessionResults = await Promise.all(sessionPromises);
  const sessions: Session[] = sessionResults.filter((s): s is Session => s !== null);

  // Check container status for each session in parallel
  const statuses: Record<string, { status: string; ptyActive: boolean; startupStage?: string }> = {};

  const results = await Promise.allSettled(
    sessions.map(async (session) => {
      // If KV says stopped, always trust it — skip the container probe entirely.
      // Probing a stopped session's container wakes the Durable Object, which can
      // trigger R2 sync and effectively auto-start sessions the user didn't request.
      // The stop endpoint writes 'stopped' to KV authoritatively (POST /:id/stop),
      // so this is a reliable signal.
      if (session.status === 'stopped') {
        return { sessionId: session.id, status: 'stopped', ptyActive: false } as const;
      }

      const containerId = getContainerId(bucketName, session.id);
      const container = getContainer(c.env.CONTAINER, containerId);
      const result = await getContainerSessionStatus(container, session.id);

      const entry: { sessionId: string; status: string; ptyActive: boolean; startupStage?: string } = {
        sessionId: session.id,
        status: result.status,
        ptyActive: result.ptyActive,
      };
      if (result.status === 'running') {
        entry.startupStage = result.ptyActive ? 'ready' : 'verifying';
      }
      return entry;
    })
  );

  // Collect KV reconciliation updates for sessions whose container is stopped
  // but KV still says 'running' (stale state from DO self-destruct race)
  const kvReconciliationPromises: Promise<void>[] = [];

  for (let i = 0; i < results.length; i++) {
    const sessionId = sessions[i].id;
    const result = results[i];
    if (result.status === 'fulfilled') {
      const { sessionId: _id, ...entry } = result.value;
      statuses[sessionId] = entry;

      // Reconcile: container says stopped but KV still says running
      if (entry.status === 'stopped' && sessions[i].status === 'running') {
        const key = getSessionKey(bucketName, sessionId);
        kvReconciliationPromises.push(
          (async () => {
            try {
              const freshSession = await c.env.KV.get<Session>(key, 'json');
              if (freshSession && freshSession.status !== 'stopped') {
                freshSession.status = 'stopped';
                await c.env.KV.put(key, JSON.stringify(freshSession));
                reqLogger.info('Reconciled stale KV session status to stopped', { sessionId });
              }
            } catch (err) {
              reqLogger.warn('KV reconciliation failed for session', { sessionId, error: String(err) });
            }
          })()
        );
      }
    } else {
      reqLogger.warn('Batch status check failed for session', {
        sessionId,
        error: String(result.reason),
      });
      statuses[sessionId] = { status: 'stopped', ptyActive: false };
    }
  }

  // Fire reconciliation updates in background (best-effort, don't block response)
  if (kvReconciliationPromises.length > 0) {
    c.executionCtx.waitUntil(Promise.allSettled(kvReconciliationPromises));
  }

  return c.json({ statuses });
});

/**
 * POST /api/sessions/:id/stop
 * Stop a session (kills the PTY but keeps the container alive for restart)
 * Note: The container will naturally go to sleep after inactivity.
 * Use DELETE to fully destroy the container and remove the session.
 */
app.post('/:id/stop', async (c) => {
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('id');
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
    result = await getContainerSessionStatus(container, sessionId);
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
