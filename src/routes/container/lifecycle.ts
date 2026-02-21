/**
 * Container lifecycle routes
 * Handles POST /start, /destroy
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, Session, UserPreferences } from '../../types';
import { createBucketIfNotExists } from '../../lib/r2-admin';
import { seedGettingStartedDocs } from '../../lib/r2-seed';
import { getR2Config } from '../../lib/r2-config';
import { getContainerContext, getSessionIdFromQuery, getContainerId } from '../../lib/container-helpers';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError, ContainerError, NotFoundError, ValidationError, toError, toErrorMessage } from '../../lib/error-types';
import { BUCKET_NAME_SETTLE_DELAY_MS, CONTAINER_ID_DISPLAY_LENGTH } from '../../lib/constants';
import { getSessionKey, getPreferencesKey } from '../../lib/kv-keys';
import { getDefaultTabConfig } from '../../lib/agent-config';
import { containerLogger, containerInternalCB, getStoredBucketName } from './shared';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * Rate limiter for container start endpoint
 * Limits to 5 start requests per minute per user
 */
const containerStartRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 5,
  keyPrefix: 'container-start',
});

/**
 * POST /api/container/start
 * Kicks off container start and returns immediately (non-blocking)
 * Use GET /api/container/startup-status to poll for readiness
 */
app.post('/start', containerStartRateLimiter, async (c) => {
  const reqLogger = containerLogger.child({ requestId: c.get('requestId') });
  try {
    const bucketName = c.get('bucketName');
    const sessionId = getSessionIdFromQuery(c);

    // Verify session exists in KV before creating a container DO
    const sessionKey = getSessionKey(bucketName, sessionId);
    const sessionData = await c.env.KV.get<Session>(sessionKey, 'json');
    if (!sessionData) {
      throw new NotFoundError('Session', sessionId);
    }

    const containerId = getContainerId(bucketName, sessionId);
    const shortContainerId = containerId.substring(0, CONTAINER_ID_DISPLAY_LENGTH);
    const preferencesKey = getPreferencesKey(bucketName);
    const preferences = await c.env.KV.get<UserPreferences>(preferencesKey, 'json') || {};
    const workspaceSyncEnabled = preferences.workspaceSyncEnabled !== false;

    // CRITICAL: Create R2 bucket BEFORE starting container
    // Container sync will fail if bucket doesn't exist
    const r2Config = await getR2Config(c.env);
    const bucketResult = await createBucketIfNotExists(
      r2Config.accountId,
      c.env.CLOUDFLARE_API_TOKEN,
      bucketName
    );

    if (!bucketResult.success) {
      reqLogger.error('Failed to create bucket', new Error(bucketResult.error || 'Unknown error'), { bucketName });
      throw new ContainerError('bucket_creation', bucketResult.error);
    }
    reqLogger.info('Bucket ready', { bucketName, created: bucketResult.created });

    // Seed starter docs only once, when the bucket is newly created.
    if (bucketResult.created) {
      try {
        const seedResult = await seedGettingStartedDocs(c.env, bucketName, r2Config.endpoint, { overwrite: false });
        reqLogger.info('Seeded initial getting-started docs', {
          bucketName,
          writtenCount: seedResult.written.length,
          skippedCount: seedResult.skipped.length,
        });
      } catch (error) {
        reqLogger.warn('Failed to seed initial getting-started docs', {
          bucketName,
          error: toErrorMessage(error),
        });
      }
    }

    // Get container instance for this session
    const container = getContainer(c.env.CONTAINER, containerId);

    // Check if bucket name needs to be set/updated
    // If container is running with wrong bucket name, we need to restart it
    const storedBucketName = await getStoredBucketName(container, reqLogger);

    // Resolve tab config: session-level > defaults from agent type > legacy defaults
    const tabConfig = sessionData.tabConfig
      || getDefaultTabConfig(sessionData.agentType || 'claude-unleashed');

    // If bucket name is different or not set, update it
    const needsBucketUpdate = storedBucketName !== bucketName;
    if (needsBucketUpdate) {
      try {
        await containerInternalCB.execute(() =>
          container.fetch(
            new Request('http://container/_internal/setBucketName', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                bucketName,
                sessionId,
                r2AccessKeyId: c.env.R2_ACCESS_KEY_ID,
                r2SecretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
                r2AccountId: r2Config.accountId,
                r2Endpoint: r2Config.endpoint,
                tabConfig,
                workspaceSyncEnabled,
              }),
            })
          )
        );
        // Small delay to ensure DO processes the bucket name before container starts
        await new Promise(resolve => setTimeout(resolve, BUCKET_NAME_SETTLE_DELAY_MS));
        reqLogger.info('Set bucket name', { bucketName, previousBucketName: storedBucketName });
      } catch (error) {
        reqLogger.error('Failed to set bucket name', toError(error));
        throw new ContainerError('set_bucket_name', toErrorMessage(error));
      }
    }

    // Always ensure sessionId is stored in DO storage (needed by collectMetrics/onStop).
    // This is a separate call because setBucketName is skipped when bucket already matches.
    try {
      await containerInternalCB.execute(() =>
        container.fetch(
          new Request('http://container/_internal/setSessionId', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
        )
      );
    } catch {
      // Best-effort — don't fail the start if this fails
      reqLogger.warn('Failed to store sessionId in DO', { sessionId });
    }

    // Check current state
    let currentState;
    try {
      currentState = await container.getState();
    } catch (error) {
      // Expected: container may not exist yet, treat as needing start
      reqLogger.debug('Could not get container state, treating as unknown');
      currentState = { status: 'unknown' };
    }

    // If container is running but bucket name was wrong or not set, destroy and restart
    if ((currentState.status === 'running' || currentState.status === 'healthy') && needsBucketUpdate) {
      reqLogger.info('Bucket name changed, destroying container to restart with correct bucket');
      try {
        await container.destroy();
        // Container will be started below
        currentState = { status: 'stopped' };
      } catch (error) {
        reqLogger.error('Failed to destroy container', toError(error));
      }
    }

    // Mark session as running in KV so batch-status can include it
    if (sessionData.status !== 'running') {
      sessionData.status = 'running';
      await c.env.KV.put(sessionKey, JSON.stringify(sessionData));
    }

    // If container is already running/healthy with correct bucket, return immediately
    if (currentState.status === 'running' || currentState.status === 'healthy') {
      return c.json({
        success: true,
        containerId: shortContainerId,
        status: 'already_running',
        containerState: currentState.status,
      });
    }

    // Kick off container start in background (non-blocking)
    // We use waitUntil so the worker doesn't terminate before start() completes
    // Using startAndWaitForPorts() which waits for defaultPort (8080)
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await container.startAndWaitForPorts();
          reqLogger.info('Container started and ports ready', { containerId: shortContainerId });
        } catch (error) {
          reqLogger.error('Failed to start container', toError(error), { containerId: shortContainerId });
          // Rollback KV session status to 'stopped' so batch-status doesn't show stale 'running'
          try {
            const freshSession = await c.env.KV.get<Session>(sessionKey, 'json');
            if (freshSession) {
              freshSession.status = 'stopped';
              await c.env.KV.put(sessionKey, JSON.stringify(freshSession));
            }
          } catch {
            // Rollback failure shouldn't propagate
          }
        }
      })()
    );

    // Return immediately - client should poll startup-status for progress
    return c.json({
      success: true,
      containerId: shortContainerId,
      status: 'starting',
      message: 'Container start initiated. Poll /api/container/startup-status for progress.',
    });
  } catch (error) {
    reqLogger.error('Container start error', toError(error));
    if (error instanceof AppError) {
      throw error;
    }
    throw new ContainerError('start');
  }
});

/**
 * POST /api/container/destroy
 * Destroy the container (SIGKILL) - used to force restart with new image
 */
app.post('/destroy', async (c) => {
  const reqLogger = containerLogger.child({ requestId: c.get('requestId') });

  try {
    const { containerId, container } = getContainerContext(c);

    // Destroy the container
    // Note: Do NOT call getState() before destroy() — it wakes up hibernated DOs (gotcha #6)
    await container.destroy();

    reqLogger.info('Container destroyed', { containerId });

    // Don't call getState() after destroy() — it resurrects the DO (gotcha #6)
    return c.json({ success: true, message: 'Container destroyed' });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    const err = toError(error);
    if (err.message.includes('not found') || err.message.includes('does not exist')) {
      reqLogger.debug('Container not found during destroy', { error: err.message });
    } else {
      reqLogger.error('Container destroy error', err);
    }
    throw new ContainerError('destroy', toErrorMessage(error));
  }
});

// REMOVED: destroy-by-name and nuke-all endpoints
// Also REMOVED: destroy-by-id (duplicate exists in src/index.ts under /api/admin/destroy-by-id)
// These endpoints CREATED zombies instead of destroying them!
// Reason: idFromName() + get() + any method CREATES a DO if it doesn't exist.
// The only way to delete DOs is to delete the entire class via migration.

export default app;
