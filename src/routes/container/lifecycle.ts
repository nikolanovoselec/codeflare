/**
 * Container lifecycle routes
 * Handles POST /start, /destroy
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, Session, UserPreferences, TabConfig } from '../../types';
import { createBucketIfNotExists, getOrCreateScopedR2Token } from '../../lib/r2-admin';
import { seedGettingStartedDocs } from '../../lib/r2-seed';
import { getR2Config } from '../../lib/r2-config';
import { getContainerContext, getSessionIdFromQuery, getContainerId } from '../../lib/container-helpers';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError, ContainerError, NotFoundError, RateLimitError, toError, toErrorMessage } from '../../lib/error-types';
import { BUCKET_NAME_SETTLE_DELAY_MS, CONTAINER_ID_DISPLAY_LENGTH, getMaxSessions } from '../../lib/constants';
import { getSessionKey, getPreferencesKey, listAllKvKeys, getSessionPrefix } from '../../lib/kv-keys';
import { getDefaultTabConfig } from '../../lib/agent-config';
import { containerLogger, getStoredBucketName } from './shared';
import { getContainerInternalCB } from '../../lib/circuit-breakers';
import type { Logger } from '../../lib/logger';

// ---------------------------------------------------------------------------
// Extracted helpers (FIX-8)
// ---------------------------------------------------------------------------

/**
 * Build the JSON body for /_internal/setBucketName requests.
 * Extracted to avoid duplication between initial set and post-destroy re-set.
 */
function buildSetBucketNameBody(params: {
  bucketName: string;
  sessionId: string;
  scopedCreds: { accessKeyId: string; secretAccessKey: string };
  r2Config: { accountId: string; endpoint: string };
  tabConfig: TabConfig[];
  workspaceSyncEnabled: boolean;
  fastStartEnabled: boolean;
}): string {
  return JSON.stringify({
    bucketName: params.bucketName,
    sessionId: params.sessionId,
    r2AccessKeyId: params.scopedCreds.accessKeyId,
    r2SecretAccessKey: params.scopedCreds.secretAccessKey,
    r2AccountId: params.r2Config.accountId,
    r2Endpoint: params.r2Config.endpoint,
    tabConfig: params.tabConfig,
    workspaceSyncEnabled: params.workspaceSyncEnabled,
    fastStartEnabled: params.fastStartEnabled,
  });
}

/**
 * Get scoped R2 credentials for a user's bucket.
 * Wraps getOrCreateScopedR2Token with logging and error translation.
 */
async function setupR2Credentials(
  env: Env,
  userEmail: string,
  r2AccountId: string,
  bucketName: string,
  logger: Logger,
): Promise<{ accessKeyId: string; secretAccessKey: string; tokenId: string }> {
  try {
    return await getOrCreateScopedR2Token(
      userEmail,
      r2AccountId,
      env.CLOUDFLARE_API_TOKEN,
      bucketName,
      env.KV,
    );
  } catch (error) {
    logger.error('Failed to create scoped R2 token', toError(error), { bucketName });
    throw new ContainerError('r2_credentials', toErrorMessage(error));
  }
}

/**
 * Validate that the session exists and check concurrent session limits.
 * Returns the session data if valid.
 *
 * @throws NotFoundError if session doesn't exist
 * @throws RateLimitError if session limit exceeded
 */
export async function validateSessionAndCheckLimits(params: {
  env: Env;
  bucketName: string;
  sessionId: string;
  maxSessions: number;
}): Promise<Session> {
  const { env, bucketName, sessionId, maxSessions } = params;

  const sessionKey = getSessionKey(bucketName, sessionId);
  const sessionData = await env.KV.get<Session>(sessionKey, 'json');
  if (!sessionData) {
    throw new NotFoundError('Session', sessionId);
  }

  // Session limit check: enforce max concurrent running sessions per role.
  const sessionKeys = await listAllKvKeys(env.KV, getSessionPrefix(bucketName));
  const sessionSettled = await Promise.allSettled(
    sessionKeys.map(key => env.KV.get<Session>(key.name, 'json'))
  );
  const sessionResults = sessionSettled
    .filter((r): r is PromiseFulfilledResult<Session | null> => r.status === 'fulfilled')
    .map(r => r.value);
  const runningCount = sessionResults.filter(
    (s): s is Session => s !== null && s.status === 'running' && s.id !== sessionId
  ).length;

  if (runningCount >= maxSessions) {
    throw new RateLimitError(
      `Session limit reached (${runningCount}/${maxSessions}). Stop an existing session to start a new one.`
    );
  }

  return sessionData;
}

/**
 * Create the R2 bucket if needed and seed starter docs for new buckets.
 * Returns the R2 config.
 *
 * @throws ContainerError if bucket creation fails
 */
export async function ensureBucketAndSeed(params: {
  env: Env;
  bucketName: string;
  logger: Logger;
}): Promise<{ r2Config: { accountId: string; endpoint: string } }> {
  const { env, bucketName, logger } = params;

  const r2Config = await getR2Config(env);
  const bucketResult = await createBucketIfNotExists(
    r2Config.accountId,
    env.CLOUDFLARE_API_TOKEN,
    bucketName
  );

  if (!bucketResult.success) {
    logger.error('Failed to create bucket', new Error(bucketResult.error || 'Unknown error'), { bucketName });
    throw new ContainerError('bucket_creation', bucketResult.error);
  }
  logger.info('Bucket ready', { bucketName, created: bucketResult.created });

  // Seed starter docs only once, when the bucket is newly created.
  if (bucketResult.created) {
    try {
      const seedResult = await seedGettingStartedDocs(env, bucketName, r2Config.endpoint, { overwrite: false });
      logger.info('Seeded initial getting-started docs', {
        bucketName,
        writtenCount: seedResult.written.length,
        skippedCount: seedResult.skipped.length,
      });
    } catch (error) {
      logger.warn('Failed to seed initial getting-started docs', {
        bucketName,
        error: toErrorMessage(error),
      });
    }
  }

  return { r2Config };
}

/**
 * Configure the container Durable Object: set bucket name, R2 creds, and preferences.
 * Returns whether the bucket name needed an update.
 *
 * @throws ContainerError if setBucketName fails on a needed update
 */
export async function configureContainerDO(params: {
  container: { fetch: (req: Request) => Promise<Response> };
  bucketName: string;
  sessionId: string;
  containerId: string;
  scopedCreds: { accessKeyId: string; secretAccessKey: string };
  r2Config: { accountId: string; endpoint: string };
  tabConfig: TabConfig[];
  workspaceSyncEnabled: boolean;
  fastStartEnabled: boolean;
  logger: Logger;
}): Promise<{ needsBucketUpdate: boolean; setBucketBody: string }> {
  const { container, bucketName, containerId, logger } = params;

  const storedBucketName = await getStoredBucketName(container as any, logger, containerId);

  const setBucketBody = buildSetBucketNameBody({
    bucketName: params.bucketName,
    sessionId: params.sessionId,
    scopedCreds: params.scopedCreds,
    r2Config: params.r2Config,
    tabConfig: params.tabConfig,
    workspaceSyncEnabled: params.workspaceSyncEnabled,
    fastStartEnabled: params.fastStartEnabled,
  });

  const needsBucketUpdate = storedBucketName !== bucketName;

  try {
    await getContainerInternalCB(containerId).execute(() =>
      container.fetch(
        new Request('http://container/_internal/setBucketName', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: setBucketBody,
        })
      )
    );
    if (needsBucketUpdate) {
      await new Promise(resolve => setTimeout(resolve, BUCKET_NAME_SETTLE_DELAY_MS));
    }
    logger.info('Set bucket name', { bucketName, previousBucketName: storedBucketName });
  } catch (error) {
    if (needsBucketUpdate) {
      logger.error('Failed to set bucket name', toError(error));
      throw new ContainerError('set_bucket_name', toErrorMessage(error));
    }
    logger.warn('Failed to store sessionId via setBucketName', { sessionId: params.sessionId });
  }

  return { needsBucketUpdate, setBucketBody };
}

/**
 * Start or restart the container based on current state.
 * If the container is already running with the correct bucket, returns immediately.
 * If bucket name changed, destroys and restarts.
 * Otherwise kicks off a background start.
 */
export async function startOrRestartContainer(params: {
  container: {
    fetch: (req: Request) => Promise<Response>;
    destroy: () => Promise<void>;
    getState: () => Promise<{ status: string }>;
    startAndWaitForPorts: () => Promise<void>;
  };
  needsBucketUpdate: boolean;
  setBucketBody: string;
  containerId: string;
  sessionData: Session;
  sessionKey: string;
  env: Env;
  shortContainerId: string;
  logger: Logger;
  waitUntil: (p: Promise<void>) => void;
}): Promise<{ status: string; containerState?: string }> {
  const { container, needsBucketUpdate, setBucketBody, containerId, sessionData, sessionKey, env, shortContainerId, logger, waitUntil } = params;

  // Check current state
  let currentState;
  try {
    currentState = await container.getState();
  } catch (_error) {
    logger.debug('Could not get container state, treating as unknown');
    currentState = { status: 'unknown' };
  }

  // If container is running but bucket name was wrong or not set, destroy and restart
  if ((currentState.status === 'running' || currentState.status === 'healthy') && needsBucketUpdate) {
    logger.info('Bucket name changed, destroying container to restart with correct bucket');
    try {
      await container.destroy();
      await getContainerInternalCB(containerId).execute(() =>
        container.fetch(
          new Request('http://container/_internal/setBucketName', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: setBucketBody,
          })
        )
      );
      currentState = { status: 'stopped' };
    } catch (error) {
      logger.error('Failed to destroy container', toError(error));
    }
  }

  // Mark session as running in KV
  if (sessionData.status !== 'running') {
    sessionData.status = 'running';
    await env.KV.put(sessionKey, JSON.stringify(sessionData));
  }

  // If container is already running/healthy with correct bucket, return immediately
  if (currentState.status === 'running' || currentState.status === 'healthy') {
    return {
      status: 'already_running',
      containerState: currentState.status,
    };
  }

  // Kick off container start in background (non-blocking)
  waitUntil(
    (async () => {
      try {
        await container.startAndWaitForPorts();
        logger.info('Container started and ports ready', { containerId: shortContainerId });
      } catch (error) {
        logger.error('Failed to start container', toError(error), { containerId: shortContainerId });
        try {
          const freshSession = await env.KV.get<Session>(sessionKey, 'json');
          if (freshSession) {
            freshSession.status = 'stopped';
            await env.KV.put(sessionKey, JSON.stringify(freshSession));
          }
        } catch (err) {
          logger.error('KV rollback to stopped failed', toError(err));
        }
      }
    })()
  );

  return { status: 'starting' };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

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
    const user = c.get('user');
    const maxSessions = getMaxSessions(user.role, c.env);

    // Step 1: Validate session and check limits
    const sessionData = await validateSessionAndCheckLimits({
      env: c.env,
      bucketName,
      sessionId,
      maxSessions,
    });

    const containerId = getContainerId(bucketName, sessionId);
    const shortContainerId = containerId.substring(0, CONTAINER_ID_DISPLAY_LENGTH);
    const preferencesKey = getPreferencesKey(bucketName);
    const preferences = await c.env.KV.get<UserPreferences>(preferencesKey, 'json') || {};
    const workspaceSyncEnabled = preferences.workspaceSyncEnabled !== false;
    const fastStartEnabled = preferences.fastStartEnabled !== false;

    // Step 2: Ensure R2 bucket exists and seed if new
    const { r2Config } = await ensureBucketAndSeed({
      env: c.env,
      bucketName,
      logger: reqLogger,
    });

    // Step 3: Get scoped R2 credentials
    const scopedCreds = await setupR2Credentials(c.env, user.email, r2Config.accountId, bucketName, reqLogger);

    // Get container instance
    const container = getContainer(c.env.CONTAINER, containerId);

    // Resolve tab config
    const tabConfig = sessionData.tabConfig
      || getDefaultTabConfig(sessionData.agentType || 'claude-code');

    // Step 4: Configure the container DO
    const { needsBucketUpdate, setBucketBody } = await configureContainerDO({
      container,
      bucketName,
      sessionId,
      containerId,
      scopedCreds,
      r2Config,
      tabConfig,
      workspaceSyncEnabled,
      fastStartEnabled,
      logger: reqLogger,
    });

    // Step 5: Start or restart the container
    const sessionKey = getSessionKey(bucketName, sessionId);
    const result = await startOrRestartContainer({
      container,
      needsBucketUpdate,
      setBucketBody,
      containerId,
      sessionData,
      sessionKey,
      env: c.env,
      shortContainerId,
      logger: reqLogger,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    });

    if (result.status === 'already_running') {
      return c.json({
        success: true,
        containerId: shortContainerId,
        status: 'already_running',
        containerState: result.containerState,
      });
    }

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
// These endpoints CREATED zombies instead of destroying them!
// Reason: idFromName() + get() + any method CREATES a DO if it doesn't exist.
// The only way to delete DOs is to delete the entire class via migration.

export default app;
