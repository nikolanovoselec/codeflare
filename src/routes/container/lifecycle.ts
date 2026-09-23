/**
 * Container lifecycle routes
 * Handles POST /start, /destroy
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, Session, UserPreferences, LlmKeys, DeployKeys, ManagedResourcePolicy } from '../../types';
import { resolveSessionWorkspace, resolveTerminalMode } from '../../types';
import { resolveEffectiveSessionMode } from '../../lib/session-mode';
import { getContainerContext, getSessionIdFromQuery, getContainerId } from '../../lib/container-helpers';
import { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError, ContainerError, BucketMigratingError, ManagedEnvironmentUpdatePendingError, ValidationError, toError, toErrorMessage } from '../../lib/error-types';
import { isBucketMigrating } from '../../lib/r2-migration';
import { getEffectiveTier, isEnterpriseMode } from '../../lib/subscription';
import { CONTAINER_ID_DISPLAY_LENGTH, getMaxSessions } from '../../lib/constants';
import { getPreferencesKey, getLlmKeysKey, getDeployKeysKey } from '../../lib/kv-keys';
import { D1SessionRepository } from '../../lib/session-repository';
import { fencePendingBoundaryStart } from '../session/boundary-stop';
import { getDefaultTabConfig } from '../../lib/agent-config';
import { buildCloneTargets } from '../../lib/clone-targets';
import { installedAgents } from '../../lib/agent-allowlist';
import { containerLogger } from './shared';
import { getContainerInternalCB } from '../../lib/circuit-breakers';
import type { Logger } from '../../lib/logger';
import { getAndDecrypt, getOrImportKey } from '../../lib/kv-crypto';
import { resolveEffectiveSleepAfter, validateSessionAndCheckLimits } from './lifecycle-validation';
import { setupR2Credentials, ensureBucketAndSeed, configureContainerDO } from './lifecycle-init';
import { resolveSessionAccessGroup, loadEnterpriseRouteConfig, requireOperatorHumanContext } from '../../lib/access';
import { applyEnterpriseBrowserToken } from '../../lib/browser-render-token';
import { applyCloudflareOAuthToken } from '../../lib/cloudflare-token';
import { getCachedActiveManagedRelease, hasPendingManagedReconciliation } from '../../lib/managed-release-active';
import { hasStrictGatewayEgress } from '../../lib/controller-egress';
import { createR2Client, getR2Url } from '../../lib/r2-client';
import { getSseHeaders } from '../../lib/r2-sse';
import { MANAGED_R2_POLICY_KEY, readVerifiedManagedR2Policy } from '../../lib/managed-r2-policy';
import { codingAgentProjectionIdentity } from '../../../scripts/ci/coding-agent-selection-core.mjs';

// Re-exported so existing importers (and the spec-anchored unit tests that
// import these from './lifecycle') keep resolving them after the CF-024b split
// into lifecycle-validation.ts and lifecycle-init.ts.
export { resolveEffectiveSleepAfter, validateSessionAndCheckLimits } from './lifecycle-validation';
export { ensureBucketAndSeed, configureContainerDO } from './lifecycle-init';

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function runStartStage<T>(logger: Logger, stage: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  logger.info('Container start stage started', { stage });
  try {
    const result = await operation();
    logger.info('Container start stage completed', { stage, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    logger.error('Container start stage failed', toError(error), { stage, durationMs: Date.now() - startedAt });
    throw error;
  }
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
  env: Env;
  shortContainerId: string;
  logger: Logger;
  waitUntil: (p: Promise<void>) => void;
  bindHuman?: (lifecycleGeneration: number) => Promise<void>;
  expectedLifecycleGeneration?: number;
}): Promise<{ status: string; containerState?: string }> {
  const { container, needsBucketUpdate, setBucketBody, containerId, sessionData, env, shortContainerId,
    logger, waitUntil, bindHuman, expectedLifecycleGeneration } = params;
  if (bindHuman && !Number.isSafeInteger(expectedLifecycleGeneration)) throw new Error('Session lifecycle unavailable');

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
    const repository = new D1SessionRepository(env.USAGE_DB);
    const intentId = crypto.randomUUID();
    const stopping = await repository.claimStop(sessionData.userId, sessionData.id, intentId, new Date().toISOString());
    if (!stopping) throw new Error('Replacement lifecycle could not claim termination ownership');
    await fencePendingBoundaryStart(env, repository, stopping);
    try {
      await container.destroy();
    } catch (error) {
      logger.error('Failed to destroy container', toError(error));
      throw error;
    }
    if (!await repository.confirmStopped(
      sessionData.userId, sessionData.id, stopping.lifecycleGeneration, intentId, new Date().toISOString(),
    )) throw new Error('Replacement container exit could not be confirmed');
    currentState = { status: 'stopped' };
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
    } catch (error) {
      logger.error('Failed to set replacement bucket', toError(error));
    }
  }

  // If container is already running/healthy with correct bucket, return immediately.
  // Marker-protected metrics owns KV convergence; this request path cannot inspect
  // shutdownRequested and must not race a deliberate stop or recreate a deletion.
  if (currentState.status === 'running' || currentState.status === 'healthy') {
    const current = await new D1SessionRepository(env.USAGE_DB).getSession(sessionData.userId, sessionData.id);
    if (!current || current.lifecycleState !== 'running' || current.boundaryActivityId && current.terminationIntentId
      || (bindHuman && current.lifecycleGeneration !== expectedLifecycleGeneration)) throw new Error('Session lifecycle moved');
    if (bindHuman) await bindHuman(current.lifecycleGeneration);
    return {
      status: 'already_running',
      containerState: currentState.status,
    };
  }

  // A definitively stopped process is confirmed before claiming a replacement
  // generation. Unknown transport/process state is not stopped evidence.
  if (currentState.status === 'unknown') throw new Error('Container exit is not confirmed for Start');
  const repository = new D1SessionRepository(env.USAGE_DB);
  const authoritative = await repository.getSession(sessionData.userId, sessionData.id);
  if (!authoritative) throw new Error('Session lifecycle record unavailable for Start');
  if (bindHuman && authoritative.lifecycleGeneration !== expectedLifecycleGeneration) throw new Error('Session lifecycle moved');
  if (authoritative.lifecycleState !== 'stopped') {
    if (currentState.status !== 'stopped') throw new Error('Container exit is not confirmed for Start');
    const intentId = authoritative.lifecycleState === 'stopping'
      ? authoritative.terminationIntentId
      : crypto.randomUUID();
    if (!intentId) throw new Error('Session lifecycle could not claim termination ownership');
    const stopping = authoritative.lifecycleState === 'stopping'
      ? authoritative
      : await repository.claimStop(sessionData.userId, sessionData.id, intentId, new Date().toISOString());
    if (!stopping) throw new Error('Confirmed container exit could not be persisted for Start');
    await fencePendingBoundaryStart(env, repository, stopping);
    if (!await repository.confirmStopped(
      sessionData.userId, sessionData.id, stopping.lifecycleGeneration, intentId, new Date().toISOString(),
    )) throw new Error('Confirmed container exit could not be persisted for Start');
  }

  // D1 claims the replacement generation before process work begins.
  const claimed = await repository.start(
    sessionData.userId,
    sessionData.id,
    new Date().toISOString(),
  );
  if (!claimed) throw new Error('Session lifecycle could not be claimed for Start');

  // Kick off container start in background (non-blocking)
  waitUntil(
    (async () => {
      try {
        await container.startAndWaitForPorts();
        // onStart has confirmed the new lifecycle and cleared its old shutdown
        // marker; only then may the parent attach current human authority.
        await bindHuman?.(claimed.lifecycleGeneration);
        logger.info('Container started and ports ready', { containerId: shortContainerId });
      } catch (error) {
        logger.error('Failed to start container', toError(error), { containerId: shortContainerId });
        // Start failure is not confirmed process exit. Leave the generation in
        // starting for bounded lifecycle reconciliation rather than inventing stopped.
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
    const preferencesKey = getPreferencesKey(bucketName);
    const preferences = await runStartStage(
      reqLogger,
      'preferences',
      async () => await c.env.KV.get<UserPreferences>(preferencesKey, 'json') || {},
    );
    const sessionMode = await runStartStage(
      reqLogger,
      'session_mode',
      () => resolveEffectiveSessionMode(preferences, user, c.env),
    );
    const projectionIdentity = codingAgentProjectionIdentity(c.env.CODING_AGENTS);
    let remoteCurationActive = false;
    let remoteCurationReleaseDigest: string | undefined;
    let remoteCurationManifestDigest: string | undefined;
    let managedResourcePolicy: ManagedResourcePolicy = 'mutable';
    let managedResourcePathsDigest: string | undefined;
    try {
      const activeManagedRelease = await runStartStage(
        reqLogger,
        'managed_release_snapshot',
        () => getCachedActiveManagedRelease(c.env),
      );
      const applied = preferences.managedEnvironmentApplied;
      const desiredPolicy = activeManagedRelease?.resourcePolicy ?? 'mutable';
      const appliedPolicy = applied?.resourcePolicy ?? 'mutable';
      const hasInterruptedTargets = hasPendingManagedReconciliation(
        preferences.managedEnvironmentReconciliation,
      );
      const mismatch = hasInterruptedTargets || (activeManagedRelease
        ? applied?.digest !== activeManagedRelease.digest
          || applied.mode !== sessionMode
          || applied.sequence !== activeManagedRelease.pointer.sequence
          || applied.projectionIdentity !== projectionIdentity
          || !/^[0-9a-f]{64}$/.test(applied.managedExtensionsDigest ?? '')
          || appliedPolicy !== desiredPolicy
          || (desiredPolicy !== 'mutable' && !/^[0-9a-f]{64}$/.test(applied.managedPathsDigest ?? ''))
          || (desiredPolicy === 'mutable' && applied.managedPathsDigest !== undefined)
        : applied !== undefined);
      if (mismatch) throw new ManagedEnvironmentUpdatePendingError();
      remoteCurationActive = activeManagedRelease !== null;
      remoteCurationReleaseDigest = activeManagedRelease?.digest;
      remoteCurationManifestDigest = applied?.managedExtensionsDigest;
      managedResourcePolicy = desiredPolicy;
      managedResourcePathsDigest = desiredPolicy === 'mutable' ? undefined : applied?.managedPathsDigest;
    } catch (error) {
      if (error instanceof ManagedEnvironmentUpdatePendingError) throw error;
      // A transient persisted-snapshot read failure may continue only from a
      // previously applied verified release. A fresh bucket has no trustworthy
      // managed state and must remain behind the same typed update gate.
      if (
        hasPendingManagedReconciliation(preferences.managedEnvironmentReconciliation)
        || !preferences.managedEnvironmentApplied
        || preferences.managedEnvironmentApplied.mode !== sessionMode
        || preferences.managedEnvironmentApplied.projectionIdentity !== projectionIdentity
        || !/^[0-9a-f]{64}$/.test(preferences.managedEnvironmentApplied.managedExtensionsDigest ?? '')
      ) {
        throw new ManagedEnvironmentUpdatePendingError();
      }
      const fallbackPolicy = preferences.managedEnvironmentApplied.resourcePolicy ?? 'mutable';
      if (fallbackPolicy !== 'mutable') throw new ManagedEnvironmentUpdatePendingError();
      remoteCurationActive = true;
      remoteCurationReleaseDigest = preferences.managedEnvironmentApplied.digest;
      remoteCurationManifestDigest = preferences.managedEnvironmentApplied.managedExtensionsDigest;
    }

    if (managedResourcePolicy !== 'mutable') {
      const protectedAdmissionReady = isEnterpriseMode(c.env)
        && c.env.EGRESS !== undefined
        && await runStartStage(reqLogger, 'strict_egress_policy', () => hasStrictGatewayEgress(c.env));
      if (!protectedAdmissionReady) throw new ManagedEnvironmentUpdatePendingError();
    }

    // REQ-ENTERPRISE-020: refuse to start a container while the bucket is migrating its
    // encryption regime. A container bakes the bucket's SSE-C regime at boot and its rclone
    // daemon writes R2 directly; starting one mid-flip would write the wrong regime. 409
    // until the migration verifies + flips status back to ready (reuses the Upgrading UX).
    if (await runStartStage(reqLogger, 'migration_gate', () => isBucketMigrating(c.env, bucketName))) {
      throw new BucketMigratingError();
    }

    const maxSessions = getMaxSessions(user.role, c.env);

    // Step 1: Validate session and check limits (including usage quota)
    const sessionData = await runStartStage(reqLogger, 'session_validation', () => validateSessionAndCheckLimits({
      env: c.env,
      bucketName,
      sessionId,
      maxSessions,
      subscriptionTier: user.subscriptionTier,
      accessTier: user.accessTier,
      billingStatus: user.billingStatus,
      billingPeriodEnd: user.billingPeriodEnd,
    }));
    const enterpriseLifecycle = isEnterpriseMode(c.env)
      ? await new D1SessionRepository(c.env.USAGE_DB).getSession(bucketName, sessionId) : null;
    if (isEnterpriseMode(c.env) && !enterpriseLifecycle) throw new Error('Session lifecycle unavailable');
    const sessionAgent = sessionData.agentType ?? 'claude-code';
    if (!installedAgents(c.env).includes(sessionAgent)) {
      throw new ValidationError(`Agent type '${sessionAgent}' is not available in this deployment`);
    }

    const containerId = getContainerId(bucketName, sessionId);
    const shortContainerId = containerId.substring(0, CONTAINER_ID_DISPLAY_LENGTH);
    const workspaceSyncEnabled = preferences.workspaceSyncEnabled === true;
    const fastStartEnabled = preferences.fastStartEnabled !== false;
    // Free tier: locked to 15m idle timeout. All other tiers: user preference or 30m default.
    const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd, c.env);
    const sleepAfter = resolveEffectiveSleepAfter(effectiveTier, preferences.sleepAfter, c.env);
    // context-mode preseed plugin: hard-gated to the unlimited (Custom) tier
    // in Pro session mode. Any other combination strips the context-mode
    // subtree from the R2 seed before bisync touches the bucket, so the
    // plugin folder simply never appears in the user's ~/.claude/plugins/.
    const contextModeEnabled = effectiveTier === 'unlimited' && sessionMode === 'advanced';

    // Read LLM API keys and deploy credentials (if any) to inject into container env vars
    const cryptoKey = await runStartStage(reqLogger, 'credential_key', () => getOrImportKey(c.env));
    const [llmKeys, deployKeys] = await runStartStage(reqLogger, 'credentials', () => Promise.all([
      getAndDecrypt<LlmKeys>(c.env.KV, getLlmKeysKey(bucketName), cryptoKey),
      getAndDecrypt<DeployKeys>(c.env.KV, getDeployKeysKey(bucketName), cryptoKey),
    ]));

    // REQ-BROWSER-007: in enterprise the per-user Push & Deploy accordion is hidden,
    // so the Cloudflare Browser Rendering token + account that browser-run needs come
    // from the admin-global Setup value rather than per-user deploy-keys. No-op in
    // every other mode (returns deployKeys unchanged).
    let effectiveDeployKeys = await runStartStage(
      reqLogger,
      'enterprise_browser_token',
      () => applyEnterpriseBrowserToken(c.env, deployKeys, cryptoKey),
    );

    // Refresh an expiring Connect-to-Cloudflare OAuth token before injection so the
    // container always receives a currently-valid CLOUDFLARE_API_TOKEN (no-op for a
    // pasted PAT or the enterprise browser token; fails closed if un-refreshable).
    effectiveDeployKeys = await runStartStage(
      reqLogger,
      'cloudflare_oauth_token',
      () => applyCloudflareOAuthToken(c.env, effectiveDeployKeys, bucketName),
    );

    // Step 2: Ensure R2 bucket exists and seed if new
    const { r2Config, r2SseDisabled } = await runStartStage(reqLogger, 'bucket_seed', () => ensureBucketAndSeed({
      env: c.env,
      bucketName,
      sessionMode,
      contextModeEnabled,
      codingAgents: c.env.CODING_AGENTS,
      logger: reqLogger,
    }));

    // Step 3: Get scoped R2 credentials
    const scopedCreds = await runStartStage(
      reqLogger,
      'scoped_r2_credentials',
      () => setupR2Credentials(c.env, user.email, r2Config.accountId, bucketName, reqLogger, cryptoKey),
    );

    if (managedResourcePolicy !== 'mutable') {
      try {
        await runStartStage(reqLogger, 'managed_resource_policy', () => readVerifiedManagedR2Policy({
          fetchPolicyObject: () => createR2Client({
            R2_ACCESS_KEY_ID: scopedCreds.accessKeyId,
            R2_SECRET_ACCESS_KEY: scopedCreds.secretAccessKey,
          }).fetch(getR2Url(r2Config.endpoint, bucketName, MANAGED_R2_POLICY_KEY), {
            method: 'GET',
            headers: getSseHeaders(c.env, r2SseDisabled),
          }),
          releaseDigest: remoteCurationReleaseDigest!,
          pathsDigest: managedResourcePathsDigest!,
          expectedPolicy: managedResourcePolicy,
          bypassMemoryCache: true,
        }));
      } catch {
        throw new ManagedEnvironmentUpdatePendingError();
      }
    }

    // Get container instance
    const container = getContainer(c.env.CONTAINER, containerId);

    // Resolve immutable terminal ownership and its outer tab configuration.
    const terminalMode = resolveTerminalMode(sessionData.terminalMode);
    const tabConfig = sessionData.tabConfig
      || getDefaultTabConfig(sessionData.agentType || 'claude-code', terminalMode);

    // Enterprise-mode LLM routing (REQ-ENTERPRISE-004/005) needs NO per-session
    // injection here: the container DO wires outbound-HTTPS interception in
    // onStart (container/index.ts), and buildEnvVars emits ENTERPRISE_MODE
    // straight from the Worker deploy var. The gateway URL/token live only in
    // the LlmInterceptor's env - they never reach the container.

    // Enterprise per-group attribution: resolve the user's matched Access groups
    // ONCE here (session start), not per request, and forward them to the DO so the
    // LlmInterceptor stamps one cf-aig-metadata tag per group. Empty when
    // non-enterprise, no groups are configured, or the user matches none.
    // REQ-ENTERPRISE-004 (revised).
    const userGroups = await resolveSessionAccessGroup(c.req.raw, c.env); // string[] (empty when none)

    // Enterprise dynamic-route config: read the catalog + resolved default
    // route:reasoning ONCE here (buildEnvVars is sync and cannot await KV) and
    // forward it to the DO so buildEnvVars emits ENTERPRISE_ROUTE_CATALOG /
    // ENTERPRISE_DEFAULT_ROUTE / ENTERPRISE_DEFAULT_REASONING for entrypoint.sh.
    // Empty when non-enterprise. REQ-ENTERPRISE-005 (revised).
    const routeConfig = await loadEnterpriseRouteConfig(c.env, userGroups);

    // Step 4: Configure the container DO
    const { needsBucketUpdate, setBucketBody } = await configureContainerDO({
      container,
      containerId,
      bucketName,
      sessionId,
      userEmail: user.email,
      userGroups,
      routeCatalog: routeConfig.routeCatalog,
      defaultRoute: routeConfig.defaultRoute,
      defaultReasoning: routeConfig.defaultReasoning,
      routeContextWindows: routeConfig.routeContextWindows,
      routeReasoningLevels: routeConfig.routeReasoningLevels,
      modelDisplayNames: routeConfig.modelDisplayNames,
      promptCacheTargets: routeConfig.promptCacheTargets ?? [],
      scopedCreds,
      r2Config,
      tabConfig,
      terminalMode,
      workspaceSyncEnabled,
      fastStartEnabled,
      sessionMode,
      sessionWorkspace: resolveSessionWorkspace(sessionData.workspace),
      sleepAfter,
      encryptionKey: c.env.ENCRYPTION_KEY,
      // REQ-ENTERPRISE-018: this bucket's resolved Governed Mode regime (post-migration).
      r2SseDisabled,
      remoteCurationActive,
      remoteCurationReleaseDigest,
      remoteCurationManifestDigest,
      managedResourcePolicy,
      managedResourcePathsDigest,
      llmKeys: llmKeys ?? undefined,
      deployKeys: effectiveDeployKeys ?? undefined,
      // REQ-MEM-001 AC4: forward the browser's IANA timezone (captured
      // on createSession) into the container so capture filenames reflect
      // the user's wall-clock instead of UTC.
      userTimezone: preferences.userTimezone,
      // REQ-GITHUB-004: forward the clone directive recorded on the session.
      // entrypoint.sh clones on each fresh workspace start and skips collisions.
      gitCloneRepo: sessionData.clone?.repo,
      gitCloneRef: sessionData.clone?.ref,
      // REQ-GITHUB-015 AC4: restore every repository tracked for this session,
      // the session's own repository first.
      gitCloneTargets: buildCloneTargets(sessionData.clones, sessionData.clone),
      logger: reqLogger,
    });

    // Operator authority is separate from bucket/session ownership and never enters
    // the container configuration, env vars, or the GitHub credential placeholder.
    let reviewHuman: Awaited<ReturnType<typeof requireOperatorHumanContext>> | null = null;
    if (isEnterpriseMode(c.env)) {
      try { reviewHuman = await requireOperatorHumanContext(c.req.raw, c.env, user.email); }
      catch { /* Missing or stale human authority leaves ordinary Git available. */ }
    }

    // Step 5: Start or restart the container
    const result = await startOrRestartContainer({
      ...(enterpriseLifecycle ? { expectedLifecycleGeneration: enterpriseLifecycle.lifecycleGeneration,
        bindHuman: (generation: number) => (container as unknown as {
          bindReviewHuman: (value: typeof reviewHuman & { bucket: string; sessionId: string;
            generation: number } | null) => Promise<void>;
        }).bindReviewHuman(reviewHuman ? { bucket: bucketName, sessionId, generation, ...reviewHuman } : null) } : {}),
      container,
      needsBucketUpdate,
      setBucketBody,
      containerId,
      sessionData,
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

    // Preserve a D1 termination intent before teardown; cancellation must precede destruction.
    const bucketName = c.get('bucketName');
    const sessionId = getSessionIdFromQuery(c);
    const repository = new D1SessionRepository(c.env.USAGE_DB);
    const session = await repository.getSession(bucketName, sessionId);
    if (!session) throw new Error('Session lifecycle unavailable for Destroy');
    const intentId = session.lifecycleState === 'stopping' ? session.terminationIntentId : crypto.randomUUID();
    if (!intentId) throw new Error('Session termination intent unavailable');
    const stopping = session.lifecycleState === 'stopped' || session.lifecycleState === 'stopping'
      ? session : await repository.claimStop(bucketName, sessionId, intentId, new Date().toISOString());
    if (!stopping) throw new Error('Session termination intent unavailable');
    await fencePendingBoundaryStart(c.env, repository, stopping);
    // Note: Do NOT call getState() before destroy() - it wakes up hibernated DOs (gotcha #6)
    await container.destroy();
    if (stopping.lifecycleState !== 'stopped' && !await repository.confirmStopped(
      bucketName, sessionId, stopping.lifecycleGeneration, intentId, new Date().toISOString(),
    )) throw new Error('Confirmed container exit could not be persisted');

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
