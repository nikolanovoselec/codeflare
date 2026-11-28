import type { DeployKeys, Env } from '../types';
import { getBucketOwnerStub } from './access';
import type { DeployKeyFence, DeployKeyScope, DeployKeySnapshot } from './deploy-key-state';

export interface DeployKeyStore {
  read(): Promise<DeployKeySnapshot>;
  compare(expected: DeployKeyFence, scope: DeployKeyScope, keys: DeployKeys | null): Promise<boolean>;
  reset(): Promise<void>;
}

export function ownedDeployKeys(env: Env, bucket: string): DeployKeyStore {
  const owner = getBucketOwnerStub(env, bucket);
  return {
    read: () => owner.readOwnedDeployKeys(bucket),
    compare: ({ revision, github, cloudflare, epoch }, scope, keys) =>
      owner.compareOwnedDeployKeys(bucket, { revision, github, cloudflare, epoch }, scope, keys),
    reset: () => owner.resetOwnedDeployKeys(bucket),
  };
}

export async function readDeployKeys(env: Env, bucket: string): Promise<DeployKeys | null> {
  return (await ownedDeployKeys(env, bucket).read()).keys;
}

/** Rebase on unrelated changes only; never replay an older grant across a reset or replacement. */
export async function changeDeployKeys(store: DeployKeyStore, scope: DeployKeyScope,
  change: (keys: DeployKeys | null) => DeployKeys | null | Promise<DeployKeys | null>,
  guard?: { snapshot: DeployKeySnapshot; provider?: 'github' | 'cloudflare' },
): Promise<{ previous: DeployKeys | null; keys: DeployKeys | null } | null> {
  let snapshot = await store.read();
  const initial = guard?.snapshot ?? snapshot;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (snapshot.epoch !== initial.epoch || (guard?.provider && snapshot[guard.provider] !== initial[guard.provider])) return null;
    const keys = await change(snapshot.keys);
    if (await store.compare(snapshot, scope, keys)) return { previous: snapshot.keys, keys };
    snapshot = await store.read();
  }
  throw new Error('Concurrent deploy credential updates; retry the operation');
}
