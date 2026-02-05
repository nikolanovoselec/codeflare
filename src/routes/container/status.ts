/**
 * Container status routes
 * Handles GET /health, /state, /startup-status
 */
import { Hono } from 'hono';
import type { Env } from '../../types';
import { getContainerContext, checkContainerHealth, type HealthData } from '../../lib/container-helpers';
import { AuthVariables } from '../../middleware/auth';
import { ContainerError, toError, toErrorMessage } from '../../lib/error-types';
import {
  containerLogger,
  containerHealthCB,
  containerSessionsCB,
  fetchWithTimeout,
} from './shared';

/** Copy cpu/mem/hdd metrics from health data into the response details object */
function populateMetrics(
  details: Record<string, unknown>,
  healthData: HealthData | null,
): void {
  if (healthData?.cpu !== undefined) details.cpu = healthData.cpu;
  if (healthData?.mem !== undefined) details.mem = healthData.mem;
  if (healthData?.hdd !== undefined) details.hdd = healthData.hdd;
}

type StartupStage = 'stopped' | 'starting' | 'syncing' | 'mounting' | 'verifying' | 'ready' | 'error';

interface StartupResponse {
  stage: StartupStage;
  progress: number;
  message: string;
  details: Record<string, unknown>;
  error?: string;
}

/** Build a "ready" stage response, accounting for sync status variations. */
function buildReadyResponse(
  response: StartupResponse,
  syncStatus: string,
  healthData: HealthData,
  containerStatus: string,
): StartupResponse {
  response.stage = 'ready';
  response.progress = 100;
  if (syncStatus === 'syncing') {
    response.message = 'Container ready (sync in progress)';
  } else if (syncStatus === 'success') {
    response.message = 'Container ready (R2 sync complete)';
  } else if (syncStatus === 'skipped') {
    const syncError = healthData.syncError || 'R2 credentials not configured';
    response.message = `Container ready (sync skipped: ${syncError})`;
    response.details.syncError = syncError;
  } else {
    response.message = 'Container ready';
  }
  response.details.containerStatus = containerStatus;
  response.details.syncStatus = syncStatus;
  response.details.healthServerOk = true;
  response.details.terminalServerOk = true;
  populateMetrics(response.details, healthData);
  return response;
}

/** Build a "syncing" stage response when initial sync is in progress. */
function buildSyncingResponse(
  response: StartupResponse,
  syncStatus: string,
  healthData: HealthData,
  containerStatus: string,
): StartupResponse {
  response.stage = 'syncing';
  response.progress = syncStatus === 'pending' ? 30 : 45;
  response.message = 'Syncing user data from R2...';
  response.details.containerStatus = containerStatus;
  response.details.syncStatus = syncStatus;
  response.details.healthServerOk = true;
  populateMetrics(response.details, healthData);
  return response;
}

/** Build an "error" stage response for failed sync. */
function buildSyncFailedResponse(
  response: StartupResponse,
  healthData: HealthData,
  containerStatus: string,
): StartupResponse {
  response.stage = 'error';
  response.progress = 0;
  response.message = healthData.syncError || 'R2 sync failed';
  response.error = healthData.syncError || 'R2 sync failed';
  response.details.containerStatus = containerStatus;
  response.details.syncStatus = 'failed';
  response.details.syncError = healthData.syncError;
  response.details.healthServerOk = true;
  return response;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * GET /api/container/health
 * Checks if the container is running and healthy
 */
app.get('/health', async (c) => {
  const reqLogger = containerLogger.child({ requestId: c.get('requestId') });

  try {
    const { containerId, container } = getContainerContext(c);

    const healthResult = await checkContainerHealth(container);

    if (!healthResult.healthy) {
      reqLogger.error('Container health check failed', new Error(healthResult.error || 'Unknown error'), { containerId });
      return c.json({
        success: false,
        containerId,
        error: healthResult.error || 'Container health check failed',
      }, 500);
    }

    return c.json({
      success: true,
      containerId,
      container: healthResult.data,
    });
  } catch (err) {
    throw new ContainerError('health', toErrorMessage(err));
  }
});

/**
 * GET /api/container/startup-status
 * Polling endpoint for container startup progress
 * Returns current initialization stage without blocking
 *
 * Stage progression:
 * 1. stopped (0%) - Container not running
 * 2. starting (10-20%) - Container state is running/healthy but services not ready
 * 3. syncing (30-60%) - Health server responding, R2 sync in progress
 * 4. verifying (80-85%) - Sync complete, terminal server starting
 * 5. mounting (90%) - Terminal server ready, PTY pre-warming in progress
 * 6. ready (100%) - All services ready
 */
app.get('/startup-status', async (c) => {
  const reqLogger = containerLogger.child({ requestId: c.get('requestId') });

  /** Default response values — used to initialize `response` and as a clean base in catch */
  const DEFAULTS = {
    stage: 'stopped' as const,
    progress: 0,
    message: 'Container not running',
    details: {
      bucketName: '',
      container: '',
      path: '/home/user/workspace',
      containerStatus: 'stopped',
      syncStatus: 'pending',
      healthServerOk: false,
      terminalServerOk: false,
    },
  };

  const response: {
    stage: 'stopped' | 'starting' | 'syncing' | 'mounting' | 'verifying' | 'ready' | 'error';
    progress: number;
    message: string;
    details: {
      bucketName: string;
      container: string;
      path: string;
      email?: string;
      containerStatus?: string;
      syncStatus?: string;
      syncError?: string | null;
      healthServerOk?: boolean;
      terminalServerOk?: boolean;
      cpu?: string;
      mem?: string;
      hdd?: string;
    };
    error?: string;
  } = {
    ...DEFAULTS,
    details: { ...DEFAULTS.details },
  };

  try {
    const user = c.get('user');
    const { bucketName, containerId, container } = getContainerContext(c);

    // Populate response details now that we have context
    response.details.bucketName = bucketName;
    response.details.container = `container-${containerId.substring(0, 24)}`;
    response.details.email = user.email;

    // Step 1: Check container state
    let containerState;
    try {
      containerState = await container.getState();
    } catch (err) {
      // Container not available - stopped state
      return c.json(response);
    }

    // Container states: stopped, stopping, running, healthy, stopped_with_code
    // We consider 'running' OR 'healthy' as container being up
    const isContainerUp = containerState &&
      (containerState.status === 'running' || containerState.status === 'healthy');

    if (!isContainerUp) {
      // Container not running yet
      response.stage = 'starting';
      response.progress = 10;
      response.message = `Container is starting... (status: ${containerState?.status || 'unknown'})`;
      response.details.containerStatus = containerState?.status || 'unknown';
      return c.json(response);
    }

    // Step 2: Check health server (port 8080) - now consolidated into terminal server
    // Returns sync status from /tmp/sync-status.json and system metrics (cpu/mem/hdd)
    const healthRequest = new Request('http://container/health', { method: 'GET' });
    const healthRes = await fetchWithTimeout(() =>
      containerHealthCB.execute(() => container.fetch(healthRequest))
    );

    // Parse health data if available (includes sync status and system metrics)
    let healthData: HealthData = {};
    let healthServerOk = false;

    if (healthRes && healthRes.ok) {
      try {
        healthData = await healthRes.json() as typeof healthData;
        healthServerOk = true;
      } catch (err) {
        // Failed to parse - continue without health data
      }
    }

    // If health server is not responding yet, we're still starting
    if (!healthServerOk) {
      response.stage = 'starting';
      response.progress = 20;
      response.message = 'Waiting for container services...';
      response.details.containerStatus = containerState?.status || 'running';
      response.details.healthServerOk = false;
      return c.json(response);
    }

    // Step 3: Check R2 sync status
    // syncStatus values: "pending", "syncing", "success", "failed", "skipped"
    const syncStatus = healthData.syncStatus || 'pending';

    // Step 4: Check if the terminal server (sessions endpoint) is already responding.
    // This distinguishes startup sync from on-demand sync:
    // - During startup, the sessions endpoint won't respond yet → gate on sync status
    // - During on-demand sync (user clicked sync button), the sessions endpoint IS
    //   responding → container is fully ready, sync is just a background data operation
    const sessionsRequest = new Request('http://container/sessions', { method: 'GET' });
    const sessionsRes = await fetchWithTimeout(() =>
      containerSessionsCB.execute(() => container.fetch(sessionsRequest))
    );
    const terminalServerReady = sessionsRes != null && sessionsRes.ok;

    // If terminal server is already responding, check if PTY pre-warming is complete.
    // Use !== false for backwards compat with old containers that don't report prewarmReady.
    const cStatus = containerState?.status || 'running';

    if (terminalServerReady) {
      if (healthData.prewarmReady !== false) {
        // Fully ready — pre-warm done (or old container without pre-warm support)
        return c.json(buildReadyResponse(response, syncStatus, healthData, cStatus));
      }

      // Terminal server is up but PTY is still pre-warming
      response.stage = 'mounting';
      response.progress = 90;
      response.message = 'Preparing terminal...';
      response.details.containerStatus = cStatus;
      response.details.syncStatus = syncStatus;
      response.details.healthServerOk = true;
      response.details.terminalServerOk = true;
      populateMetrics(response.details, healthData);
      return c.json(response);
    }

    // Terminal server NOT ready yet — this is a startup sequence.
    // Gate on sync status: user must not see terminal until initial sync completes.
    if (syncStatus === 'pending' || syncStatus === 'syncing') {
      return c.json(buildSyncingResponse(response, syncStatus, healthData, cStatus));
    }

    if (syncStatus === 'failed') {
      return c.json(buildSyncFailedResponse(response, healthData, cStatus));
    }

    // Sync complete but terminal server not responding yet — still starting up
    response.stage = 'verifying';
    response.progress = 85;
    response.message = 'Verifying terminal sessions...';
    response.details.containerStatus = cStatus;
    response.details.syncStatus = syncStatus;
    response.details.healthServerOk = true;
    response.details.terminalServerOk = false;
    populateMetrics(response.details, healthData);
    return c.json(response);
  } catch (err) {
    reqLogger.error('Startup status error', toError(err));
    return c.json({
      ...DEFAULTS,
      details: { ...DEFAULTS.details },
      stage: 'error' as const,
      progress: 0,
      message: 'Container startup check failed',
      error: 'Container startup check failed',
    });
  }
});

export default app;
