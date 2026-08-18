import { MANAGED_RELEASE_LIMITS } from '../../scripts/agent-seed-release-limits.mjs';
import type { Env } from '../types';
import { PRESEED_RUNTIME_DEPENDENCY_HASH } from './agent-seed.generated';
import { readBoundedResponse } from './bounded-stream';
import { getR2Config } from './r2-config';
import { createR2Client, getR2Url } from './r2-client';
import type { ActiveManagedRelease } from './remote-curation-cache';
import {
  parseManagedRelease,
  resolveManagedEnvironment,
  verifyManagedRelease,
  type ManagedEnvironmentConfig,
  type ManagedRelease,
} from './remote-curation';

export interface ActiveVerifiedManagedRelease {
  digest: string;
  pointer: ActiveManagedRelease;
  release: ManagedRelease;
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
): Promise<ManagedRelease | null> {
  if (!/^[0-9a-f]{64}$/.test(digest)) return null;
  const client = createR2Client(env);
  const response = await client.fetch(getR2Url(endpoint, bucketName, `releases/${digest}/seed-v1.json.gz`));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Managed release cache read failed with HTTP ${response.status}`);
  const compressed = await readBoundedResponse(response, MANAGED_RELEASE_LIMITS.compressedBytes, 'Managed release cache object');
  if (await sha256Hex(compressed) !== digest) throw new Error('Managed release cache digest does not match its active pointer');
  if (!verification) return parseManagedRelease(compressed);

  const signatureResponse = await client.fetch(getR2Url(endpoint, bucketName, `releases/${digest}/seed-v1.sig`));
  if (!signatureResponse.ok) throw new Error(`Managed release cache signature read failed with HTTP ${signatureResponse.status}`);
  const signature = await readBoundedResponse(signatureResponse, 64, 'Managed release cache signature');
  const verified = await verifyManagedRelease({
    compressed,
    signature,
    publicKeyHex: verification.config.publicKeyHex,
    expectedRepositoryId: verification.config.repositoryId,
    minimumSequence: verification.pointer.sequence,
    expectedRuntimeHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
  });
  if (verified.digest !== digest) throw new Error('Managed release cache digest does not match verified bytes');
  return verified.release;
}

/** Read bytes selected by Phase 3's verified, monotonic active pointer. */
export async function getActiveVerifiedManagedRelease(env: Env): Promise<ActiveVerifiedManagedRelease | null> {
  const context = await resolveCacheContext(env);
  if (!context || !context.config.enabled) return null;
  if (!context.active) throw new Error('Managed coding environment is enabled without a verified active release');
  const release = await readReleaseByDigest(
    env,
    context.endpoint,
    context.config.cacheBucketName,
    context.active.digest,
    { config: context.config, pointer: context.active },
  );
  if (!release) throw new Error('Managed release active pointer references a missing cache object');
  if (
    release.seedAbi !== context.active.seedAbi
    || release.sequence !== context.active.sequence
    || release.source.repositoryId !== context.active.repositoryId
    || release.source.releaseTag !== context.active.releaseTag
    || release.source.commitSha !== context.active.sourceCommit
    || release.runtimeDependencyHash !== context.active.runtimeDependencyHash
  ) {
    throw new Error('Managed release cache object does not match its active pointer');
  }
  return { digest: context.active.digest, pointer: context.active, release };
}

/** Load a prior verified release from retained content-addressed cache history. */
export async function getVerifiedManagedReleaseByDigest(env: Env, digest: string): Promise<ManagedRelease | null> {
  const context = await resolveCacheContext(env);
  if (!context) return null;
  return readReleaseByDigest(env, context.endpoint, context.config.cacheBucketName, digest);
}
