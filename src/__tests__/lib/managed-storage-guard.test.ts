import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessUser, Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

const state = vi.hoisted(() => ({ snapshot: null as any }));
vi.mock('../../lib/remote-curation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/remote-curation')>()),
  readManagedEnvironmentSnapshot: vi.fn(async () => state.snapshot),
}));
vi.mock('../../lib/managed-r2-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/managed-r2-policy')>()),
  readVerifiedManagedR2Policy: vi.fn(async () => ({
    schemaVersion: 1,
    releaseDigest: 'd'.repeat(64),
    pathsDigest: 'f'.repeat(64),
    resourcePolicy: 'exclusive',
    paths: ['.codeflare/managed-paths.json'],
    resourceRoots: ['.claude/skills/'],
  })),
}));
vi.mock('../../lib/r2-config', () => ({ getR2Config: vi.fn(async () => ({ accountId: 'account', endpoint: 'https://r2.example.com' })) }));
vi.mock('../../lib/r2-client', () => ({
  createR2Client: () => ({ fetch: vi.fn(async () => new Response('{}')) }),
  getR2Url: (endpoint: string, bucket: string, key: string) => `${endpoint}/${bucket}/${key}`,
}));
vi.mock('../../lib/r2-migration', () => ({ isR2SseDisabledForBucket: vi.fn(async () => false) }));

import { guardManagedStorageMutation } from '../../lib/managed-storage-guard';
import { readVerifiedManagedR2Policy } from '../../lib/managed-r2-policy';

const user: AccessUser = { email: 'user@example.com', authenticated: true };

describe('REQ-ENTERPRISE-030 Storage mutation guard', () => {
  let kv: ReturnType<typeof createMockKV>;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    kv = createMockKV();
    env = { KV: kv as unknown as KVNamespace, R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret' } as Env;
    state.snapshot = {
      configured: true,
      enabled: true,
      config: { resourcePolicy: 'exclusive' },
      active: { digest: 'd'.repeat(64), sequence: 4 },
    };
    kv._set('user-prefs:bucket', {
      managedEnvironmentApplied: {
        digest: 'd'.repeat(64), sequence: 4, mode: 'default', managedExtensionsDigest: 'e'.repeat(64),
        resourcePolicy: 'exclusive', managedPathsDigest: 'f'.repeat(64), appliedAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it('blocks exact keys and intersecting prefixes but permits adjacent paths', async () => {
    await expect(guardManagedStorageMutation({ env, bucketName: 'bucket', user, keys: ['.codeflare/managed-paths.json'] }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(guardManagedStorageMutation({ env, bucketName: 'bucket', user, prefixes: ['.claude/'] }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(guardManagedStorageMutation({ env, bucketName: 'bucket', user, keys: ['Vault/personal.md'] }))
      .resolves.toBeUndefined();
  });

  it.each([
    ['release digest', (snapshot: any, _applied: any) => { snapshot.active.digest = 'c'.repeat(64); }],
    ['sequence', (snapshot: any) => { snapshot.active.sequence = 5; }],
    ['effective mode', (_snapshot: any, applied: any) => { applied.mode = 'advanced'; }],
    ['extension digest', (_snapshot: any, applied: any) => { applied.managedExtensionsDigest = undefined; }],
    ['resource policy', (_snapshot: any, applied: any) => { applied.resourcePolicy = 'immutable'; }],
    ['path digest', (_snapshot: any, applied: any) => { applied.managedPathsDigest = undefined; }],
  ])('fails update-pending before policy lookup on %s mismatch', async (_dimension, mutate) => {
    const applied = {
      digest: 'd'.repeat(64), sequence: 4, mode: 'default', managedExtensionsDigest: 'e'.repeat(64),
      resourcePolicy: 'exclusive', managedPathsDigest: 'f'.repeat(64), appliedAt: '2026-01-01T00:00:00.000Z',
    };
    mutate(state.snapshot, applied);
    kv._set('user-prefs:bucket', { managedEnvironmentApplied: applied });

    await expect(guardManagedStorageMutation({ env, bucketName: 'bucket', user, keys: ['Vault/personal.md'] }))
      .rejects.toMatchObject({ code: 'MANAGED_ENVIRONMENT_UPDATE_PENDING' });
    expect(readVerifiedManagedR2Policy).not.toHaveBeenCalled();
  });
});
