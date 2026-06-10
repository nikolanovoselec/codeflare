/**
 * Container lifecycle - initialization helpers.
 *
 * R2 credential setup, bucket creation + seeding, and container DO
 * configuration extracted from lifecycle.ts (CF-024b). lifecycle.ts re-exports
 * these so existing importers (and the spec-anchored unit tests) keep resolving
 * them from './lifecycle'.
 */
import type { Env, SessionMode, ContainerConfigPayload, R2ConnectionConfig, UserPreferences } from '../../types';
import { createBucketIfNotExists, getOrCreateScopedR2Token } from '../../lib/r2-admin';
import { seedGettingStartedDocs, reconcileAgentConfigs, reseedContextModePlugin } from '../../lib/r2-seed';
import { getR2Config } from '../../lib/r2-config';
import { getPreferencesKey } from '../../lib/kv-keys';
import { ContainerError, toError, toErrorMessage } from '../../lib/error-types';
import { BUCKET_NAME_SETTLE_DELAY_MS } from '../../lib/constants';
import { SetBucketNameBodySchema } from '../../lib/container-config-schema';
import { getStoredBucketName } from './shared';
import { getContainerInternalCB } from '../../lib/circuit-breakers';
import type { Logger } from '../../lib/logger';

/**
 * Build the JSON body for /_internal/setBucketName requests.
 * Extracted to avoid duplication between initial set and post-destroy re-set.
 *
 * sleepAfter is REQUIRED here (not defaulted). The /start route resolves the
 * effective value from `(effectiveTier === 'free' ? '15m' : preferences.sleepAfter || '30m')`
 * and passes it explicitly. A missing sleepAfter at this layer would mean the
 * resolution skipped a code path and we should fail loudly rather than ship a
 * silent '30m' default that lies to the user about their configured 2h pref.
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
    // REQ-AGENT-029 AC2: a stored `null` on any of the three deploy creds is an
    // explicit clear that must reach the container so a revoked credential is
    // unset, not silently left stale. `undefined` stays omitted (no change); a
    // string sets the value.
    ...(params.deployKeys?.githubToken !== undefined && { githubToken: params.deployKeys.githubToken }),
    ...(params.deployKeys?.cloudflareApiToken !== undefined && { cloudflareApiToken: params.deployKeys.cloudflareApiToken }),
    ...(params.deployKeys?.cloudflareAccountId !== undefined && { cloudflareAccountId: params.deployKeys.cloudflareAccountId }),
    ...(params.encryptionKey && { encryptionKey: params.encryptionKey }),
    sessionMode: params.sessionMode,
    sleepAfter: params.sleepAfter,
    // REQ-ENTERPRISE-004: forward the user's matched Access groups so the
    // LlmInterceptor stamps one cf-aig-metadata tag per group for the gateway.
    ...(params.userGroups && params.userGroups.length > 0 && { userGroups: params.userGroups }),
    // REQ-ENTERPRISE-005 (revised): forward the dynamic-route catalog + resolved
    // default route:reasoning so buildEnvVars emits them for entrypoint.sh (Pi
    // models.json lists all routes; Copilot/Pi default model + Pi thinking level).
    // The default route + reasoning travel as a unit with the catalog. defaultReasoning
    // '' is a meaningful "reasoning off" value (admin cleared the default, or it drifted
    // out of the catalog), so it is forwarded explicitly — a truthiness guard would drop
    // the empty reset and leave applyPrefsOnRestart stranded on a stale grade.
    ...(params.routeCatalog && params.routeCatalog.length > 0 && {
      routeCatalog: params.routeCatalog,
      defaultRoute: params.defaultRoute ?? '',
      defaultReasoning: params.defaultReasoning ?? '',
    }),
    // REQ-MEM-001 AC4: forward the user's IANA timezone so the capture
    // pipeline's TZ resolution produces wall-clock filenames matching
    // the user's location instead of UTC.
    ...(params.userTimezone && { userTimezone: params.userTimezone }),
  });
  return JSON.stringify(body);
}

/**
 * Get scoped R2 credentials for a user's bucket.
 * Wraps getOrCreateScopedR2Token with logging and error translation.
 */
export async function setupR2Credentials(
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
}): Promise<{ r2Config: R2ConnectionConfig }> {
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

  // Seed agent configs once, when the bucket is newly created. Agent configs have
  // additional reseed paths (the Recreate button, mode-change reconcile, and the
  // REQ-AGENT-049 preseed-hash upgrade), so the create-time gate keeps them healthy.
  if (bucketResult.created) {
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

  // REQ-STOR-009: seed getting-started docs until one attempt succeeds — self-healing,
  // NOT gated on first-creation. A freshly created bucket is not always immediately
  // writable on the R2 data plane (see seedGettingStartedDocs), so the old create-only
  // seed could fail, get swallowed, and leave docs permanently missing — the user then
  // had to click "Recreate Docs & Examples" by hand. Unlike agent configs, getting-started
  // docs have no other reseed path, so we re-attempt on every session start until the
  // `gettingStartedSeeded` marker is set (mirrors REQ-AGENT-049's lastPreseedHash).
  // overwrite:false keeps it idempotent and preserves user edits; once the marker is
  // set, user deletions of the starter docs are respected.
  try {
    const preferencesKey = getPreferencesKey(bucketName);
    const preferences = await env.KV.get<UserPreferences>(preferencesKey, 'json');
    if (preferences?.gettingStartedSeeded !== true) {
      const seedResult = await seedGettingStartedDocs(env, bucketName, r2Config.endpoint, { overwrite: false });
      // Only mark after a successful seed, so a failed attempt retries next session.
      await env.KV.put(preferencesKey, JSON.stringify({ ...preferences, gettingStartedSeeded: true }));
      logger.info('Seeded getting-started docs', {
        bucketName,
        created: bucketResult.created === true,
        writtenCount: seedResult.written.length,
        skippedCount: seedResult.skipped.length,
      });
    }
  } catch (error) {
    logger.warn('Failed to seed getting-started docs; will retry next session', {
      bucketName,
      error: toErrorMessage(error),
    });
  }

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
