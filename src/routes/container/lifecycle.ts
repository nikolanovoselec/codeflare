/**
 * Container lifecycle routes
 * Handles POST /start, /destroy
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, Session, SessionMode, UserPreferences, LlmKeys, DeployKeys, ContainerConfigPayload } from '../../types';
import { createBucketIfNotExists, getOrCreateScopedR2Token } from '../../lib/r2-admin';
import { seedGettingStartedDocs, reconcileAgentConfigs, reseedContextModePlugin } from '../../lib/r2-seed';
import { resolveSessionMode } from '../../lib/session-mode';
import { getR2Config } from '../../lib/r2-config';
import { getContainerContext, getSessionIdFromQuery, getContainerId } from '../../lib/container-helpers';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError, ContainerError, NotFoundError, QuotaExceededError, toError, toErrorMessage } from '../../lib/error-types';
import { getTierConfig, getUserTier, getEffectiveTier, getAllowedSessionModes } from '../../lib/subscription';
import { isSaasModeActive } from '../../lib/onboarding';
import { BUCKET_NAME_SETTLE_DELAY_MS, CONTAINER_ID_DISPLAY_LENGTH, getMaxSessions } from '../../lib/constants';
import { getSessionKey, getPreferencesKey, getLlmKeysKey, getDeployKeysKey, listAllKvKeys, getSessionPrefix, getTimekeeperKey, getUtcMonthString, putSessionWithMetadata, type SessionListMetadata } from '../../lib/kv-keys';
import { getDefaultTabConfig } from '../../lib/agent-config';
import { SetBucketNameBodySchema } from '../../lib/container-config-schema';
import { containerLogger, getStoredBucketName } from './shared';
import { getContainerInternalCB } from '../../lib/circuit-breakers';
import type { Logger } from '../../lib/logger';
import { getAndDecrypt, getOrImportKey } from '../../lib/kv-crypto';

// ---------------------------------------------------------------------------
// Extracted helpers
// ---------------------------------------------------------------------------

/**
 * Build the JSON body for /_internal/setBucketName requests.
 * Extracted to avoid duplication between initial set and post-destroy re-set.
 *
 * sleepAfter is REQUIRED here (not defaulted). The /start route resolves the
 * effective value from `(effectiveTier === 'free' ? '15m' : preferences.sleepAfter || '30m')`
 * and passes it explicitly. A missing sleepAfter at this layer would mean the
 * resolution skipped a code path and we should fail loudly rather than ship a
 * silent '30m' default that lies to the user about their configured 2h pref.
 * Implements REQ-OPS-006 AC10.
 */
function buildSetBucketNameBody(params: ContainerConfigPayload): string {
  if (!params.sleepAfter) {
    throw new Error(
      'buildSetBucketNameBody: sleepAfter is required. The caller must resolve '
      + 'it from user preferences before invoking. A silent default would mask '
      + 'a real bug where the user\'s configured idle-timeout is ignored.'
    );
  }
  const body = SetBucketNameBodySchema.parse({
    bucketName: params.bucketName,
    sessionId: params.sessionId,
    userEmail: params.userEmail,
    r2AccessKeyId: params.scopedCreds.accessKeyId,
    r2SecretAccessKey: params.scopedCreds.secretAccessKey,
    r2AccountId: params.r2Config.accountId,
    r2Endpoint: params.r2Config.endpoint,
    tabConfig: params.tabConfig,
    workspaceSyncEnabled: params.workspaceSyncEnabled,
    fastStartEnabled: params.fastStartEnabled,
    ...(params.llmKeys?.openaiApiKey && { openaiApiKey: params.llmKeys.openaiApiKey }),
    ...(params.llmKeys?.geminiApiKey && { geminiApiKey: params.llmKeys.geminiApiKey }),
    ...(params.deployKeys?.githubToken && { githubToken: params.deployKeys.githubToken }),
    ...(params.deployKeys?.cloudflareApiToken && { cloudflareApiToken: params.deployKeys.cloudflareApiToken }),
    ...(params.deployKeys?.cloudflareAccountId && { cloudflareAccountId: params.deployKeys.cloudflareAccountId }),
    ...(params.encryptionKey && { encryptionKey: params.encryptionKey }),
    sessionMode: params.sessionMode,
    sleepAfter: params.sleepAfter,
  });
  return JSON.stringify(body);
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
  cryptoKey?: CryptoKey | null,
): Promise<{ accessKeyId: string; secretAccessKey: string; tokenId: string }> {
  try {
    return await getOrCreateScopedR2Token(
      userEmail,
      r2AccountId,
      env.CLOUDFLARE_API_TOKEN,
      bucketName,
      env.KV,
      cryptoKey,
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
 * @throws QuotaExceededError if session limit exceeded
 */
export async function validateSessionAndCheckLimits(params: {
  env: Env;
  bucketName: string;
  sessionId: string;
  maxSessions: number;
  subscriptionTier?: string;
  accessTier?: string;
  billingStatus?: string;
  billingPeriodEnd?: string;
}): Promise<Session> {
  const { env, bucketName, sessionId, maxSessions, subscriptionTier, accessTier, billingStatus, billingPeriodEnd } = params;

  const sessionKey = getSessionKey(bucketName, sessionId);
  const sessionData = await env.KV.get<Session>(sessionKey, 'json');
  if (!sessionData) {
    throw new NotFoundError('Session', sessionId);
  }

  // Session limit + quota checks. Bypass when stress testing.
  if (env.STRESS_TEST_MODE !== 'active') {
    // Resolve tier once for both session limit and quota checks (cached 60s)
    const isSaas = isSaasModeActive(env.SAAS_MODE);
    let resolvedTier: ReturnType<typeof getUserTier> | null = null;
    if (isSaas) {
      try {
        const tiers = await getTierConfig(env.KV);
        resolvedTier = getUserTier(getEffectiveTier(subscriptionTier, accessTier, billingStatus, billingPeriodEnd), tiers);
      } catch { /* fall back to role-based */ }
    }

    // Session limit: tier-based in SaaS mode, role-based otherwise.
    // Uses list metadata to count running sessions (zero individual KV.get calls).
    const effectiveMaxSessions = resolvedTier?.maxSessions ?? maxSessions;
    const sessionKeys = await listAllKvKeys(env.KV, getSessionPrefix(bucketName));
    let runningCount = 0;
    for (const key of sessionKeys) {
      const meta = key.metadata as SessionListMetadata | null;
      if (meta && meta.s) {
        // Fast path: read status from list metadata
        const keySessionId = key.name.split(':').pop();
        if (meta.s === 'r' && keySessionId !== sessionId) runningCount++;
      } else {
        // Fallback: pre-migration key without metadata
        const s = await env.KV.get<Session>(key.name, 'json');
        if (s && s.status === 'running' && s.id !== sessionId) runningCount++;
      }
    }

    if (runningCount >= effectiveMaxSessions) {
      throw new QuotaExceededError(
        `Session limit reached (${runningCount}/${effectiveMaxSessions}). Stop an existing session to start a new one.`
      );
    }

    // Usage quota check (SaaS mode only)
    if (isSaas && resolvedTier && resolvedTier.monthlySeconds !== null) {
      try {
        const usageRecord = await env.KV.get(getTimekeeperKey(bucketName), 'json') as { thisMonth?: { month: string; seconds: number } } | null;
        const now = new Date();
        const currentMonth = getUtcMonthString(now);
        const monthlySeconds = (usageRecord?.thisMonth?.month === currentMonth)
          ? usageRecord.thisMonth.seconds : 0;

        if (monthlySeconds >= resolvedTier.monthlySeconds) {
          const usedHours = Math.round(monthlySeconds / 3600);
          const quotaHours = Math.round(resolvedTier.monthlySeconds / 3600);
          throw new QuotaExceededError(
            `Monthly compute quota reached (${usedHours}h / ${quotaHours}h). Upgrade your plan.`
          );
        }
      } catch (err) {
        if (err instanceof QuotaExceededError) throw err;
      }
    }
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
  sessionMode: SessionMode;
  contextModeEnabled?: boolean;
  logger: Logger;
}): Promise<{ r2Config: { accountId: string; endpoint: string } }> {
  const { env, bucketName, sessionMode, contextModeEnabled, logger } = params;

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

    try {
      const agentResult = await reconcileAgentConfigs(env, bucketName, r2Config.endpoint, sessionMode, {
        overwrite: false,
        cleanup: false,
        contextModeEnabled,
      });
      logger.info('Seeded initial agent configs', {
        bucketName,
        mode: sessionMode,
        contextModeEnabled,
        writtenCount: agentResult.written.length,
        skippedCount: agentResult.skipped.length,
      });
    } catch (error) {
      logger.warn('Failed to seed initial agent configs', {
        bucketName,
        error: toErrorMessage(error),
      });
    }
  }

  // Implements REQ-AGENT-005
  // Always reseed the context-mode plugin subtree on every session start
  // when the user is on the unlimited tier in advanced mode. The 3 plugin
  // files (plugin.json, hooks.json, README.md) are Worker-authoritative -
  // their content lives in the deployed Worker bundle and must always
  // reflect the latest deploy. Existing buckets seeded before a manifest
  // change (e.g. before the mcpServers block was added) would otherwise
  // keep the stale manifest forever, since first-bucket seeding uses
  // overwrite:false. Cost: 3 small R2 PUTs per session start.
  if (contextModeEnabled === true) {
    try {
      const reseedResult = await reseedContextModePlugin(env, bucketName, r2Config.endpoint, true);
      logger.info('Reseeded context-mode plugin subtree on session start', {
        bucketName,
        writtenCount: reseedResult.written.length,
      });
    } catch (error) {
      logger.warn('Failed to reseed context-mode plugin subtree', {
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
export async function configureContainerDO(params: ContainerConfigPayload & {
  container: { fetch: (req: Request) => Promise<Response> };
  containerId: string;
  logger: Logger;
}): Promise<{ needsBucketUpdate: boolean; setBucketBody: string }> {
  const { container, bucketName, containerId, logger } = params;

  const storedBucketName = await getStoredBucketName(container, logger, containerId);

  const setBucketBody = buildSetBucketNameBody(params);

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
    // Clamp session mode against effective tier — canceled users can't use advanced (SaaS only)
    if (isSaasModeActive(c.env.SAAS_MODE) && sessionMode === 'advanced') {
      try {
        const tiers = await getTierConfig(c.env.KV);
        if (!getAllowedSessionModes(effectiveTier, tiers).includes('advanced')) {
          sessionMode = 'default';
        }
      } catch { /* non-SaaS or KV unavailable — allow the stored mode */ }
    }
    const sleepAfter = effectiveTier === 'free' ? '15m' : (preferences.sleepAfter || '30m');
    // Implements REQ-AGENT-005
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
