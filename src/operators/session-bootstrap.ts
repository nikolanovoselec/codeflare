import type { AccessUser, Env, ManagedResourcePolicy, UserPreferences } from '../types';
import { PRESEED_CONTENT_HASH } from '../lib/agent-seed.generated';
import { authenticateRequest } from '../lib/access';
import { getOrImportKey } from '../lib/kv-crypto';
import { getPreferencesKey } from '../lib/kv-keys';
import { createLogger } from '../lib/logger';
import { getActiveManagedRelease, hasPendingManagedReconciliation } from '../lib/managed-release-active';
import { hasHealthyContainer, drainContainers } from '../lib/migration-containers';
import { advanceMigration, planRegimeReconcile } from '../lib/r2-migration';
import { resolveEffectiveSessionMode } from '../lib/session-mode';
import { getEffectiveTier, isEnterpriseMode } from '../lib/subscription';
import { ensureBucketAndSeed, setupR2Credentials } from '../routes/container/lifecycle-init';
import { reconcileAgentConfigsForBootstrap } from '../routes/storage/seed';
import { codingAgentProjectionIdentity } from '../../scripts/ci/coding-agent-selection-core.mjs';
import type { JwtStampingAuthority } from './jwt-stamping';
import type { OperatorSessionBootstrap } from './owned-session-runtime';

const logger = createLogger('operator-session-bootstrap');

function needsReconciliation(env: Env, preferences: UserPreferences | null, mode: string,
  active: Awaited<ReturnType<typeof getActiveManagedRelease>>, projectionIdentity: string): boolean {
  const applied = preferences?.managedEnvironmentApplied;
  const desiredPolicy = active?.resourcePolicy ?? 'mutable';
  const appliedPolicy = applied?.resourcePolicy ?? 'mutable';
  const managedMismatch = hasPendingManagedReconciliation(preferences?.managedEnvironmentReconciliation)
    || (active
      ? applied?.digest !== active.digest
        || applied.mode !== mode
        || applied.sequence !== active.pointer.sequence
        || applied.projectionIdentity !== projectionIdentity
        || !/^[0-9a-f]{64}$/.test(applied.managedExtensionsDigest ?? '')
        || appliedPolicy !== desiredPolicy
        || (desiredPolicy !== 'mutable' && !/^[0-9a-f]{64}$/.test(applied.managedPathsDigest ?? ''))
        || (desiredPolicy === 'mutable' && applied.managedPathsDigest !== undefined)
      : applied !== undefined);
  const bakedMismatch = !active && (preferences?.lastPreseedHash !== PRESEED_CONTENT_HASH
    || preferences?.lastPreseedProjectionIdentity !== projectionIdentity
    || (isEnterpriseMode(env) && preferences?.sessionMode !== 'advanced'));
  return managedMismatch || bakedMismatch;
}

async function resolveUser(env: Env, authority: JwtStampingAuthority): Promise<{ user: AccessUser; bucketName: string }> {
  const request = new Request('https://operator.internal/', {
    headers: { 'cf-access-jwt-assertion': authority.accessJwt },
  });
  const resolved = await authenticateRequest(request, env);
  if (resolved.user.email.toLowerCase() !== authority.human.email.toLowerCase()) {
    throw new Error('Operator bootstrap identity mismatch');
  }
  return resolved;
}

/** Run the same server-owned bucket preparation required before an interactive session starts. */
export async function bootstrapOperatorSession(input: {
  env: Env;
  authority: JwtStampingAuthority;
  ownerBucket: string;
}): Promise<{ user: AccessUser; bootstrap: OperatorSessionBootstrap }> {
  const { env, authority, ownerBucket } = input;
  const { user, bucketName } = await resolveUser(env, authority);
  if (bucketName !== ownerBucket) throw new Error('Operator bootstrap bucket mismatch');

  let preferences = await env.KV.get<UserPreferences>(getPreferencesKey(bucketName), 'json');
  const mode = await resolveEffectiveSessionMode(preferences ?? null, user, env);
  const projectionIdentity = codingAgentProjectionIdentity(env.CODING_AGENTS);
  const active = await getActiveManagedRelease(env);
  const regime = await planRegimeReconcile(env, bucketName, () => hasHealthyContainer(env, bucketName));
  if (regime.pending) throw new Error('Operator bootstrap bucket update pending');
  if (regime.migrating) {
    await advanceMigration(env, bucketName, {
      hasHealthyContainer: () => hasHealthyContainer(env, bucketName),
      drainContainers: () => drainContainers(env, bucketName),
    });
    const observed = await planRegimeReconcile(env, bucketName, () => hasHealthyContainer(env, bucketName));
    if (observed.migrating || observed.pending) throw new Error('Operator bootstrap bucket update pending');
  }

  if (needsReconciliation(env, preferences, mode, active, projectionIdentity)) {
    await reconcileAgentConfigsForBootstrap({ env, bucketName, user }, true);
    preferences = await env.KV.get<UserPreferences>(getPreferencesKey(bucketName), 'json');
  }

  const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier,
    user.billingStatus, user.billingPeriodEnd, env);
  const contextModeEnabled = effectiveTier === 'unlimited' && mode === 'advanced';
  const { r2Config, r2SseDisabled } = await ensureBucketAndSeed({ env, bucketName, sessionMode: mode,
    contextModeEnabled, codingAgents: env.CODING_AGENTS, logger });
  const cryptoKey = await getOrImportKey(env);
  const scoped = await setupR2Credentials(env, user.email, r2Config.accountId, bucketName, logger, cryptoKey);

  const applied = preferences?.managedEnvironmentApplied;
  const current = await getActiveManagedRelease(env);
  const managedResourcePolicy: ManagedResourcePolicy = current?.resourcePolicy ?? 'mutable';
  return { user, bootstrap: {
    r2AccessKeyId: scoped.accessKeyId,
    r2SecretAccessKey: scoped.secretAccessKey,
    r2AccountId: r2Config.accountId,
    r2Endpoint: r2Config.endpoint,
    r2SseDisabled,
    workspaceSyncEnabled: false,
    fastStartEnabled: true,
    sessionMode: mode,
    sessionWorkspace: 'terminal',
    terminalMode: 'classic',
    remoteCurationActive: current !== null,
    ...(current ? { remoteCurationReleaseDigest: current.digest,
      remoteCurationManifestDigest: applied?.managedExtensionsDigest } : {}),
    managedResourcePolicy,
    ...(managedResourcePolicy !== 'mutable' ? { managedResourcePathsDigest: applied?.managedPathsDigest } : {}),
  } };
}
