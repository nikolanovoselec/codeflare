/**
 * Container debug routes — DEV_MODE ONLY
 *
 * Handles GET /debug, /mount-test, /sync-log, /state.
 * All routes are gated behind the DEV_MODE environment variable and must
 * NEVER be exposed in production. They reveal internal container state,
 * environment variables, and storage mount details that would be a
 * security risk if publicly accessible.
 *
 * The middleware at the top of this module enforces the gate; removing or
 * bypassing it would expose sensitive operational data.
 */
import { Hono } from 'hono';
import type { Env } from '../../types';
import { getContainerContext } from '../../lib/container-helpers';
import { AuthVariables } from '../../middleware/auth';
import { ContainerError, AuthError, toError, toErrorMessage } from '../../lib/error-types';
import { containerLogger, containerHealthCB, containerInternalCB, getStoredBucketName } from './shared';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * Middleware to gate all debug routes behind DEV_MODE
 * Debug endpoints expose internal state and should not be available in production.
 * FIX-37: Verified — all debug routes (including /_internal/debugEnvVars proxy) are
 * blocked unless DEV_MODE === 'true', preventing accidental env var leakage in prod.
 */
app.use('*', async (c, next) => {
  if (c.env.DEV_MODE !== 'true') {
    throw new AuthError('Debug endpoints only available in DEV_MODE');
  }
  await next();
});

/**
 * GET /api/container/debug
 * Debug endpoint to check DO stored bucket name and container env vars
 */
app.get('/debug', async (c) => {
  const reqLogger = containerLogger.child({ requestId: c.get('requestId') });

  try {
    const { bucketName, containerId, container } = getContainerContext(c);

    // Get stored bucket name from DO
    const storedBucketName = await getStoredBucketName(container, reqLogger);

    // Get envVars debug info from DO
    let envVarsDebug: Record<string, unknown> = {};
    try {
      const envVarsResp = await containerInternalCB.execute(() =>
        container.fetch(
          new Request('http://container/_internal/debugEnvVars', { method: 'GET' })
        )
      );
      envVarsDebug = await envVarsResp.json() as Record<string, unknown>;
    } catch (err) {
      envVarsDebug = { error: String(err) };
    }

    // Get container state
    let containerState;
    try {
      containerState = await container.getState();
    } catch (err) {
      containerState = { status: 'unknown', error: String(err) };
    }

    // Get health status
    let healthData: Record<string, unknown> = {};
    try {
      const healthRequest = new Request('http://container/health', { method: 'GET' });
      const healthRes = await containerHealthCB.execute(() => container.fetch(healthRequest));
      if (healthRes.ok) {
        healthData = await healthRes.json() as Record<string, unknown>;
      } else {
        const text = await healthRes.text();
        healthData = {
          fetchOk: false,
          status: healthRes.status,
          statusText: healthRes.statusText,
          body: text.substring(0, 500)
        };
      }
    } catch (err) {
      healthData = { error: String(err) };
    }

    reqLogger.info('Debug endpoint called', { containerId, bucketName });

    return c.json({
      success: true,
      containerId,
      expectedBucketName: bucketName,
      storedBucketName,
      envVarsDebug,
      containerState,
      healthData,
    });
  } catch (err) {
    throw new ContainerError('debug', toErrorMessage(err));
  }
});

/**
 * GET /api/container/mount-test
 * Tests if the s3fs mount is working by writing and reading a file
 */
app.get('/mount-test', async (c) => {
  const reqLogger = containerLogger.child({ requestId: c.get('requestId') });

  try {
    const { containerId, container } = getContainerContext(c);

    const response = await containerHealthCB.execute(() =>
      container.fetch(
        new Request('http://container/mount-test', {
          method: 'GET',
        })
      )
    );

    const result = await response.json();

    reqLogger.info('Mount test completed', { containerId });

    return c.json({
      success: true,
      containerId,
      mountTest: result,
    });
  } catch (err) {
    reqLogger.error('Mount test error', toError(err));
    throw new ContainerError('mount-test', toErrorMessage(err));
  }
});

/**
 * GET /api/container/sync-log
 * Fetch the sync log from the container for debugging
 */
app.get('/sync-log', async (c) => {
  const reqLogger = containerLogger.child({ requestId: c.get('requestId') });

  try {
    const { containerId, container } = getContainerContext(c);

    // Fetch sync log via the health server (add endpoint to entrypoint.sh)
    const logRequest = new Request('http://container/sync-log', { method: 'GET' });
    const logRes = await containerHealthCB.execute(() => container.fetch(logRequest));

    if (!logRes.ok) {
      reqLogger.error('Failed to fetch sync log', new Error(`Status ${logRes.status}`), { containerId });
      throw new ContainerError('sync-log', `Failed to fetch sync log: ${logRes.status}`);
    }

    const logData = await logRes.json() as { log: string };

    reqLogger.info('Sync log fetched', { containerId });

    return c.json({
      success: true,
      containerId,
      log: logData.log,
    });
  } catch (err) {
    reqLogger.error('Sync log error', toError(err));
    throw new ContainerError('sync-log', toErrorMessage(err));
  }
});

/**
 * GET /api/container/state
 * Get the container state (for debugging)
 */
app.get('/state', async (c) => {
  try {
    const { containerId, container } = getContainerContext(c);

    // Try to get state via RPC
    const state = await container.getState();

    return c.json({
      success: true,
      containerId,
      state,
    });
  } catch (err) {
    throw new ContainerError('state', toErrorMessage(err));
  }
});

export default app;
