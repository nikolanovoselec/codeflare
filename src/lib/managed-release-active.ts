import { MANAGED_RELEASE_LIMITS } from '../../scripts/agent-seed-release-limits.mjs';
import type { Env, UserPreferences } from '../types';
import { PRESEED_RUNTIME_DEPENDENCY_HASH } from './agent-seed.generated';
import { readBoundedResponse } from './bounded-stream';
import { getR2Config } from './r2-config';
import { createR2Client, getR2Url } from './r2-client';
import type { ActiveManagedRelease } from './remote-curation-cache';
import {
  parseManagedReleaseStream,
  readManagedEnvironmentSnapshot,
  resolveManagedEnvironment,
  verifyManagedReleaseStream,
  type ManagedEnvironmentConfig,
  type ManagedReleaseIndex,
} from './remote-curation';

export interface VerifiedManagedReleaseContent {
  compressed: Uint8Array;
  release: ManagedReleaseIndex;
}

export interface ActiveVerifiedManagedRelease extends VerifiedManagedReleaseContent {
  digest: string;
  pointer: ActiveManagedRelease;
}

const MAX_INTERRUPTED_MANAGED_TARGETS = 32;

export type ManagedReconciliationTarget = NonNullable<UserPreferences['managedEnvironmentReconciliation']>['targets'][number];

export function readManagedReconciliationTargets(value: unknown): ManagedReconciliationTarget[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || !Array.isArray((value as { targets?: unknown }).targets)) {
    throw new Error('Managed reconciliation target state is invalid');
  }
  const targets = (value as { targets: unknown[] }).targets;
  if (targets.length > MAX_INTERRUPTED_MANAGED_TARGETS) {
    throw new Error('Managed reconciliation target state exceeds its bound');
  }
  const seen = new Map<string, ManagedReconciliationTarget>();
  for (const candidate of targets) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Managed reconciliation target state is invalid');
    const target = candidate as Partial<ManagedReconciliationTarget>;
    if (
      typeof target.digest !== 'string'
      || !/^[0-9a-f]{64}$/.test(target.digest)
      || typeof target.sequence !== 'number'
      || !Number.isSafeInteger(target.sequence)
      || target.sequence <= 0
      || (target.mode !== 'default' && target.mode !== 'advanced')
    ) {
      throw new Error('Managed reconciliation target state is invalid');
    }
    const key = `${target.digest}:${target.mode}`;
    const existing = seen.get(key);
    if (existing && existing.sequence !== target.sequence) {
      throw new Error('Managed reconciliation target state conflicts with itself');
    }
    seen.set(key, target as ManagedReconciliationTarget);
  }
  return [...seen.values()];
}

export function hasPendingManagedReconciliation(value: unknown): boolean {
  try {
    return readManagedReconciliationTargets(value).length > 0;
  } catch {
    return true;
  }
}

export function appendManagedReconciliationTarget(
  targets: readonly ManagedReconciliationTarget[],
  target: ManagedReconciliationTarget,
): ManagedReconciliationTarget[] {
  const next = [
    ...targets.filter(value => value.digest !== target.digest || value.mode !== target.mode),
    target,
  ];
  if (next.length > MAX_INTERRUPTED_MANAGED_TARGETS) {
    throw new Error('Managed reconciliation target state exceeds its bound');
  }
  return next;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function resolveCacheContext(env: Env): Promise<{
  config: ManagedEnvironmentConfig;
  active?: ActiveManagedRelease;
  endpoint: string;
} | null> {
  // Phase 3 owns repository refresh, signature/schema verification, monotonic
  // activation, and degraded fallback. Phase 4 consumes only that narrow API;
  // it never downloads a release from GitHub into a user bucket.
  const resolved = await resolveManagedEnvironment({ env, requireFresh: false });
  if (!resolved.config) return null;
  const { endpoint } = await getR2Config(env);
  return { config: resolved.config, active: resolved.active, endpoint };
}

async function readReleaseByDigest(
  env: Env,
  endpoint: string,
  bucketName: string,
  digest: string,
  verification?: { config: ManagedEnvironmentConfig; pointer: ActiveManagedRelease },
): Promise<VerifiedManagedReleaseContent | null> {
  if (!/^[0-9a-f]{64}$/.test(digest)) return null;
  const client = createR2Client(env);
  const response = await client.fetch(getR2Url(endpoint, bucketName, `releases/${digest}/seed-v1.json.gz`));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Managed release cache read failed with HTTP ${response.status}`);
  const compressed = await readBoundedResponse(response, MANAGED_RELEASE_LIMITS.compressedBytes, 'Managed release cache object');
  if (await sha256Hex(compressed) !== digest) throw new Error('Managed release cache digest does not match its active pointer');
  if (!verification) return { compressed, release: await parseManagedReleaseStream(compressed) };

  const signatureResponse = await client.fetch(getR2Url(endpoint, bucketName, `releases/${digest}/seed-v1.sig`));
  if (!signatureResponse.ok) throw new Error(`Managed release cache signature read failed with HTTP ${signatureResponse.status}`);
  const signature = await readBoundedResponse(signatureResponse, 64, 'Managed release cache signature');
  const verified = await verifyManagedReleaseStream({
    compressed,
    signature,
    publicKeyHex: verification.config.publicKeyHex,
    expectedRepositoryId: verification.config.repositoryId,
    minimumSequence: verification.pointer.sequence,
    expectedRuntimeHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
  });
  if (verified.digest !== digest) throw new Error('Managed release cache digest does not match verified bytes');
  return { compressed, release: verified.release };
}

/** Read the persisted active descriptor without repository or cache I/O. */
export async function getCachedActiveManagedRelease(
  env: Pick<Env, 'KV'>,
): Promise<{ digest: string; pointer: ActiveManagedRelease; resourcePolicy: ManagedEnvironmentConfig['resourcePolicy'] } | null> {
  const snapshot = await readManagedEnvironmentSnapshot(env);
  if (!snapshot.config || !snapshot.enabled) return null;
  if (!snapshot.active) throw new Error('Managed environment is enabled without a cached verified active release');
  return { digest: snapshot.active.digest, pointer: snapshot.active, resourcePolicy: snapshot.config.resourcePolicy };
}

/** Refresh and read the already-verified active descriptor without loading release payload bytes. */
export async function getActiveManagedRelease(
  env: Env,
): Promise<{ digest: string; pointer: ActiveManagedRelease; resourcePolicy: ManagedEnvironmentConfig['resourcePolicy'] } | null> {
  const resolved = await resolveManagedEnvironment({ env, requireFresh: false });
  if (!resolved.config || !resolved.config.enabled) return null;
  if (!resolved.active) throw new Error('Managed environment is enabled without a verified active release');
  return { digest: resolved.active.digest, pointer: resolved.active, resourcePolicy: resolved.config.resourcePolicy };
}

/** Read bytes selected by Phase 3's verified, monotonic active pointer. */
export async function getActiveVerifiedManagedRelease(env: Env): Promise<ActiveVerifiedManagedRelease | null> {
  const context = await resolveCacheContext(env);
  if (!context || !context.config.enabled) return null;
  if (!context.active) throw new Error('Managed environment is enabled without a verified active release');
  const release = await readReleaseByDigest(
    env,
    context.endpoint,
    context.config.cacheBucketName,
    context.active.digest,
    { config: context.config, pointer: context.active },
  );
  if (!release) throw new Error('Managed release active pointer references a missing cache object');
  if (
    release.release.seedAbi !== context.active.seedAbi
    || release.release.sequence !== context.active.sequence
    || release.release.source.repositoryId !== context.active.repositoryId
    || release.release.source.releaseTag !== context.active.releaseTag
    || release.release.source.commitSha !== context.active.sourceCommit
    || release.release.runtimeDependencyHash !== context.active.runtimeDependencyHash
  ) {
    throw new Error('Managed release cache object does not match its active pointer');
  }
  return { digest: context.active.digest, pointer: context.active, ...release };
}

/**
 * Load a prior release from retained content-addressed cache history.
 *
 * Trust here is the content address alone, not a fresh signature check. The digest
 * originates from a `managedEnvironmentApplied` stamp that is written only after full
 * verification, and re-verifying those bytes against the *current* public key would
 * break convergence after a signing-key or repository rotation.
 */
export async function getCachedManagedReleaseByDigest(env: Env, digest: string): Promise<VerifiedManagedReleaseContent | null> {
  const context = await resolveCacheContext(env);
  if (!context) return null;
  return readReleaseByDigest(env, context.endpoint, context.config.cacheBucketName, digest);
}
