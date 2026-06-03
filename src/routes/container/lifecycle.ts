/**
 * Container lifecycle routes
 * Handles POST /start, /destroy
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, Session, UserPreferences, LlmKeys, DeployKeys } from '../../types';
import { resolveSessionMode, clampSessionModeToTier } from '../../lib/session-mode';
import { getContainerContext, getSessionIdFromQuery, getContainerId } from '../../lib/container-helpers';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError, ContainerError, toError, toErrorMessage } from '../../lib/error-types';
import { getTierConfig, getEffectiveTier } from '../../lib/subscription';
import { isSaasModeActive } from '../../lib/onboarding';
import { CONTAINER_ID_DISPLAY_LENGTH, getMaxSessions } from '../../lib/constants';
import { getSessionKey, getPreferencesKey, getLlmKeysKey, getDeployKeysKey, putSessionWithMetadata } from '../../lib/kv-keys';
import { getDefaultTabConfig } from '../../lib/agent-config';
import { containerLogger } from './shared';
import { getContainerInternalCB } from '../../lib/circuit-breakers';
import type { Logger } from '../../lib/logger';
import { getAndDecrypt, getOrImportKey } from '../../lib/kv-crypto';
import { resolveEffectiveSleepAfter, validateSessionAndCheckLimits } from './lifecycle-validation';
import { setupR2Credentials, ensureBucketAndSeed, configureContainerDO } from './lifecycle-init';

// Re-exported so existing importers (and the spec-anchored unit tests that
// import these from './lifecycle') keep resolving them after the CF-024b split
// into lifecycle-validation.ts and lifecycle-init.ts.
export { resolveEffectiveSleepAfter, validateSessionAndCheckLimits } from './lifecycle-validation';
export { ensureBucketAndSeed, configureContainerDO } from './lifecycle-init';

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

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
    const updated = { ...sessionData, status: 'running' as const };
    await putSessionWithMetadata(env.KV, sessionKey, updated);
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
            const rolledBack = { ...freshSession, status: 'stopped' as const };
            await putSessionWithMetadata(env.KV, sessionKey, rolledBack);
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

    // Step 1: Validate session and check limits (including usage quota)
    const sessionData = await validateSessionAndCheckLimits({
      env: c.env,
      bucketName,
      sessionId,
      maxSessions,
      subscriptionTier: user.subscriptionTier,
      accessTier: user.accessTier,
      billingStatus: user.billingStatus,
      billingPeriodEnd: user.billingPeriodEnd,
    });

    const containerId = getContainerId(bucketName, sessionId);
    const shortContainerId = containerId.substring(0, CONTAINER_ID_DISPLAY_LENGTH);
    const preferencesKey = getPreferencesKey(bucketName);
    const preferences = await c.env.KV.get<UserPreferences>(preferencesKey, 'json') || {};
    const workspaceSyncEnabled = preferences.workspaceSyncEnabled === true;
    const fastStartEnabled = preferences.fastStartEnabled !== false;
    let sessionMode = resolveSessionMode(preferences);
    // Free tier: locked to 15m idle timeout. All other tiers: user preference or 30m default.
    const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd);
    // REQ-SEC-015 AC2/AC3: clamp session mode against effective tier -
    // canceled users can't use advanced (SaaS only)
    if (isSaasModeActive(c.env.SAAS_MODE) && sessionMode === 'advanced') {
      try {
        const tiers = await getTierConfig(c.env.KV);
        sessionMode = clampSessionModeToTier(sessionMode, effectiveTier, tiers);
      } catch { /* non-SaaS or KV unavailable - allow the stored mode */ }
    }
    const sleepAfter = resolveEffectiveSleepAfter(effectiveTier, preferences.sleepAfter);
    // context-mode preseed plugin: hard-gated to the unlimited (Custom) tier
    // in Pro session mode. Any other combination strips the context-mode
    // subtree from the R2 seed before bisync touches the bucket, so the
    // plugin folder simply never appears in the user's ~/.claude/plugins/.
    const contextModeEnabled = effectiveTier === 'unlimited' && sessionMode === 'advanced';

    // Read LLM API keys and deploy credentials (if any) to inject into container env vars
    const cryptoKey = await getOrImportKey(c.env);
    const [llmKeys, deployKeys] = await Promise.all([
      getAndDecrypt<LlmKeys>(c.env.KV, getLlmKeysKey(bucketName), cryptoKey),
      getAndDecrypt<DeployKeys>(c.env.KV, getDeployKeysKey(bucketName), cryptoKey),
    ]);

    // Step 2: Ensure R2 bucket exists and seed if new
    const { r2Config } = await ensureBucketAndSeed({
      env: c.env,
      bucketName,
      sessionMode,
      contextModeEnabled,
      logger: reqLogger,
    });

    // Step 3: Get scoped R2 credentials
    const scopedCreds = await setupR2Credentials(c.env, user.email, r2Config.accountId, bucketName, reqLogger, cryptoKey);

    // Get container instance
    const container = getContainer(c.env.CONTAINER, containerId);

    // Resolve tab config
    const tabConfig = sessionData.tabConfig
      || getDefaultTabConfig(sessionData.agentType || 'claude-code');

    // Step 4: Configure the container DO
    const { needsBucketUpdate, setBucketBody } = await configureContainerDO({
      container,
      containerId,
      bucketName,
      sessionId,
      userEmail: user.email,
      scopedCreds,
      r2Config,
      tabConfig,
      workspaceSyncEnabled,
      fastStartEnabled,
      sessionMode,
      sleepAfter,
      encryptionKey: c.env.ENCRYPTION_KEY,
      llmKeys: llmKeys ?? undefined,
      deployKeys: deployKeys ?? undefined,
      // REQ-MEM-001 AC4: forward the browser's IANA timezone (captured
      // on createSession) into the container so capture filenames reflect
      // the user's wall-clock instead of UTC.
      userTimezone: preferences.userTimezone,
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
    // Note: Do NOT call getState() before destroy() - it wakes up hibernated DOs (gotcha #6)
    await container.destroy();

    reqLogger.info('Container destroyed', { containerId });

    // Don't call getState() after destroy() - it resurrects the DO (gotcha #6)
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
