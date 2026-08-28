import type { AccessUser, Env, ManagedResourcePolicy, UserPreferences } from '../types';
import { ForbiddenError, ManagedEnvironmentUpdatePendingError } from './error-types';
import { getPreferencesKey } from './kv-keys';
import { readManagedEnvironmentSnapshot } from './remote-curation';
import { resolveEffectiveSessionMode } from './session-mode';
import { createR2Client, getR2Url } from './r2-client';
import { getR2Config } from './r2-config';
import { getSseHeaders } from './r2-sse';
import { isR2SseDisabledForBucket } from './r2-migration';
import {
  canPrefixIntersectManagedPolicy,
  isManagedMutationProtected,
  MANAGED_R2_POLICY_KEY,
  readVerifiedManagedR2Policy,
  type VerifiedManagedR2Policy,
} from './managed-r2-policy';

export async function guardManagedStorageMutation(input: {
  env: Env;
  bucketName: string;
  user: AccessUser;
  keys?: readonly string[];
  prefixes?: readonly string[];
}): Promise<void> {
  let policy: VerifiedManagedR2Policy | null = null;
  try {
    const preferences = await input.env.KV.get<UserPreferences>(getPreferencesKey(input.bucketName), 'json') ?? {};
    const snapshot = await readManagedEnvironmentSnapshot(input.env);
    const applied = preferences.managedEnvironmentApplied;
    if (!snapshot.config || !snapshot.enabled) {
      if (applied) throw new ManagedEnvironmentUpdatePendingError();
      return;
    }
    if (!snapshot.active || !applied) throw new ManagedEnvironmentUpdatePendingError();
    const mode = await resolveEffectiveSessionMode(preferences, input.user, input.env);
    const desiredPolicy: ManagedResourcePolicy = snapshot.config.resourcePolicy;
    const appliedPolicy = applied.resourcePolicy ?? 'mutable';
    if (
      applied.digest !== snapshot.active.digest
      || applied.sequence !== snapshot.active.sequence
      || applied.mode !== mode
      || !/^[0-9a-f]{64}$/.test(applied.managedExtensionsDigest ?? '')
      || appliedPolicy !== desiredPolicy
      || (desiredPolicy !== 'mutable' && !/^[0-9a-f]{64}$/.test(applied.managedPathsDigest ?? ''))
      || (desiredPolicy === 'mutable' && applied.managedPathsDigest !== undefined)
    ) {
      throw new ManagedEnvironmentUpdatePendingError();
    }
    if (desiredPolicy === 'mutable') return;
    const { endpoint } = await getR2Config(input.env);
    const r2SseDisabled = await isR2SseDisabledForBucket(input.env, input.bucketName);
    const client = createR2Client(input.env);
    policy = await readVerifiedManagedR2Policy({
      fetchPolicyObject: () => client.fetch(
        getR2Url(endpoint, input.bucketName, MANAGED_R2_POLICY_KEY),
        { method: 'GET', headers: getSseHeaders(input.env, r2SseDisabled) },
      ),
      releaseDigest: applied.digest,
      pathsDigest: applied.managedPathsDigest!,
      expectedPolicy: desiredPolicy,
      bypassMemoryCache: false,
    });
  } catch (error) {
    if (error instanceof ManagedEnvironmentUpdatePendingError) throw error;
    throw new ManagedEnvironmentUpdatePendingError();
  }

  if (input.keys?.some(key => isManagedMutationProtected(policy!, key))) {
    throw new ForbiddenError('Managed resources are immutable');
  }
  if (input.prefixes?.some(prefix => canPrefixIntersectManagedPolicy(policy!, prefix))) {
    throw new ForbiddenError('Managed resource prefixes are immutable');
  }
}
