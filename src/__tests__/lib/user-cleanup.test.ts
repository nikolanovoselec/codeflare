import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { getSessionEditorKey, getSessionMetricsKey, getSessionStatusCorrectionKey } from '../../lib/kv-keys';

// Mock dependencies before imports
const mockResolveBucketName = vi.hoisted(() => vi.fn());
vi.mock('../../lib/access', () => ({
  resolveBucketName: mockResolveBucketName,
}));

const mockDeleteScopedR2Token = vi.hoisted(() => vi.fn());
vi.mock('../../lib/cloudflare-token', () => ({
  disconnectCloudflare: vi.fn(async () => undefined),
}));

vi.mock('../../lib/r2-admin', () => ({
  deleteScopedR2Token: mockDeleteScopedR2Token,
}));

const mockEmptyR2Bucket = vi.hoisted(() => vi.fn());
const mockCreateR2Client = vi.hoisted(() => vi.fn());
vi.mock('../../lib/r2-client', () => ({
  emptyR2Bucket: mockEmptyR2Bucket,
  createR2Client: mockCreateR2Client,
}));

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue({
    accountId: 'test-account-id',
    endpoint: 'https://test-account-id.r2.cloudflarestorage.com',
  }),
}));

const containerState = vi.hoisted(() => ({
  destroy: vi.fn(),
}));
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => containerState),
}));

import { cleanupUserData } from '../../lib/user-cleanup';
import type { Env } from '../../types';
import { getContainer } from '@cloudflare/containers';

const mockGetContainer = vi.mocked(getContainer);
const mockContainerDestroy = containerState.destroy;
const mockFetch = vi.fn();

// REQ-AUTH-018: User management admin panel
// REQ-SEC-003: Per-user R2 tokens scoped to user bucket

describe('cleanupUserData', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  const originalFetch = globalThis.fetch;

  const email = 'target@example.com';
  const bucketName = 'codeflare-target-example-com';

  function createEnv(overrides?: Partial<Env>): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
      CONTAINER: {} as unknown as Env['CONTAINER'],
      CLOUDFLARE_API_TOKEN: 'test-api-token',
      CLOUDFLARE_WORKER_NAME: undefined,
      R2_ACCESS_KEY_ID: 'test-r2-access-key',
      R2_SECRET_ACCESS_KEY: 'test-r2-secret-key',
      ...overrides,
    } as unknown as Env;
  }

  beforeEach(() => {
    mockKV = createMockKV();
    globalThis.fetch = mockFetch;
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    mockDeleteScopedR2Token.mockResolvedValue(undefined);
    mockContainerDestroy.mockResolvedValue(undefined);
    mockEmptyR2Bucket.mockResolvedValue(0);
    mockCreateR2Client.mockReturnValue({});
    mockResolveBucketName.mockResolvedValue(bucketName);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('resolves verified bucket ownership before deleting user state', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    await cleanupUserData(email, createEnv());

    expect(mockResolveBucketName).toHaveBeenCalledWith(expect.anything(), email);
    expect(mockResolveBucketName.mock.invocationCallOrder[0]).toBeLessThan(mockKV.delete.mock.invocationCallOrder[0]);
  });

  it('destroys active sessions and their containers', async () => {
    // Set up two sessions in KV
    mockKV._set(`session:${bucketName}:abcdef0123456789`, { id: 'abcdef0123456789', name: 'Session 1', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._set(`session:${bucketName}:fedcba9876543210`, { id: 'fedcba9876543210', name: 'Session 2', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._set(getSessionEditorKey(bucketName, 'orphan0000000000'), '', { er: 1 });
    mockKV._set(getSessionMetricsKey(bucketName, 'orphan0000000000'), '', { m: {} });
    mockKV._set(getSessionStatusCorrectionKey(bucketName, 'orphan0000000000'), '1', { r: 1 });
    mockKV._store.set('setup:account_id', 'test-account-id');

    const result = await cleanupUserData(email, createEnv());

    expect(result.deletedSessions).toBe(2);
    // Should have called getContainer + destroy for each session
    expect(mockGetContainer).toHaveBeenCalledTimes(2);
    expect(mockContainerDestroy).toHaveBeenCalledTimes(2);
    // Durable and concern-owned session KV entries should be deleted.
    expect(mockKV.delete).toHaveBeenCalledWith(`session:${bucketName}:abcdef0123456789`);
    expect(mockKV.delete).toHaveBeenCalledWith(`session:${bucketName}:fedcba9876543210`);
    for (const id of ['abcdef0123456789', 'fedcba9876543210']) {
      expect(mockKV.delete).toHaveBeenCalledWith(getSessionEditorKey(bucketName, id));
      expect(mockKV.delete).toHaveBeenCalledWith(getSessionMetricsKey(bucketName, id));
      expect(mockKV.delete).toHaveBeenCalledWith(getSessionStatusCorrectionKey(bucketName, id));
    }
    expect(mockKV.delete).toHaveBeenCalledWith(getSessionEditorKey(bucketName, 'orphan0000000000'));
    expect(mockKV.delete).toHaveBeenCalledWith(getSessionMetricsKey(bucketName, 'orphan0000000000'));
    expect(mockKV.delete).toHaveBeenCalledWith(getSessionStatusCorrectionKey(bucketName, 'orphan0000000000'));
  });

  it('deletes user:{email} from KV', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    await cleanupUserData(email, createEnv());

    expect(mockKV.delete).toHaveBeenCalledWith(`user:${email}`);
  });

  it('deletes bucket-keyed KV entries (storage-stats, preferences, legacy presets)', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    await cleanupUserData(email, createEnv());

    expect(mockKV.delete).toHaveBeenCalledWith(`storage-stats:${bucketName}`);
    expect(mockKV.delete).toHaveBeenCalledWith(`user-prefs:${bucketName}`);
    expect(mockKV.delete).toHaveBeenCalledWith(`presets:${bucketName}`);
  });

  it('REQ-AUTH-018 AC3 / REQ-SEC-023 AC4: deletes every push-subscription prefix entry and preserves other users', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`pushsub:${bucketName}:digest-a`, { endpoint: 'https://fcm.googleapis.com/fcm/send/a' });
    mockKV._set(`pushsub:${bucketName}:digest-b`, { endpoint: 'https://web.push.apple.com/b' });
    mockKV._set('pushsub:codeflare-other-user:digest-c', { endpoint: 'https://fcm.googleapis.com/fcm/send/c' });

    await cleanupUserData(email, createEnv());

    expect(mockKV.delete).toHaveBeenCalledWith(`pushsub:${bucketName}:digest-a`);
    expect(mockKV.delete).toHaveBeenCalledWith(`pushsub:${bucketName}:digest-b`);
    expect(await mockKV.get('pushsub:codeflare-other-user:digest-c')).not.toBeNull();
  });

  it('REQ-AUTH-018 AC3: follows paginated push-subscription cursors until complete', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    const originalList = mockKV.list;
    mockKV.list = vi.fn(async (options?: { prefix?: string; cursor?: string }) => {
      if (options?.prefix !== `pushsub:${bucketName}:`) return originalList(options);
      if (!options.cursor) {
        return {
          keys: [{ name: `pushsub:${bucketName}:digest-page-1`, metadata: null }],
          list_complete: false,
          cursor: 'page-2',
        } as never;
      }
      return {
        keys: [{ name: `pushsub:${bucketName}:digest-page-2`, metadata: null }],
        list_complete: true,
      } as never;
    });

    await cleanupUserData(email, createEnv());

    expect(mockKV.list).toHaveBeenCalledWith({ prefix: `pushsub:${bucketName}:` });
    expect(mockKV.list).toHaveBeenCalledWith({ prefix: `pushsub:${bucketName}:`, cursor: 'page-2' });
    expect(mockKV.delete).toHaveBeenCalledWith(`pushsub:${bucketName}:digest-page-1`);
    expect(mockKV.delete).toHaveBeenCalledWith(`pushsub:${bucketName}:digest-page-2`);
  });

  it('reads r2token, calls deleteScopedR2Token, deletes r2token KV entry', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`r2token:${email}`, {
      accessKeyId: 'ak-123',
      secretAccessKey: 'sk-456',
      tokenId: 'token-id-789',
      bucketName,
      createdAt: '2024-01-01T00:00:00Z',
    });

    const result = await cleanupUserData(email, createEnv());

    expect(mockDeleteScopedR2Token).toHaveBeenCalledWith(
      'test-account-id',
      'test-api-token',
      'token-id-789',
    );
    expect(result.tokenDeleted).toBe(true);
    expect(mockKV.delete).toHaveBeenCalledWith(`r2token:${email}`);
  });

  it('empties R2 bucket via emptyR2Bucket and deletes bucket via CF API', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockEmptyR2Bucket.mockResolvedValueOnce(5);

    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await cleanupUserData(email, createEnv());

    expect(result.bucketDeleted).toBe(true);
    expect(mockCreateR2Client).toHaveBeenCalled();
    expect(mockEmptyR2Bucket).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('r2.cloudflarestorage.com'),
      bucketName,
    );
    // Should have called fetch for bucket deletion (CF API DELETE)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/r2/buckets/${bucketName}`),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('skips R2 emptying when R2 credentials are missing', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await cleanupUserData(email, createEnv({
      R2_ACCESS_KEY_ID: '',
      R2_SECRET_ACCESS_KEY: '',
    } as Partial<Env>));

    expect(result.bucketDeleted).toBe(true);
    expect(mockCreateR2Client).not.toHaveBeenCalled();
    expect(mockEmptyR2Bucket).not.toHaveBeenCalled();
  });

  it('returns CleanupResult with correct counts', async () => {
    mockKV._set(`session:${bucketName}:abcdef0123456789`, { id: 'abcdef0123456789', name: 'S1', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`r2token:${email}`, {
      tokenId: 'tok-1',
      bucketName,
      createdAt: '2024-01-01T00:00:00Z',
    });

    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await cleanupUserData(email, createEnv());

    expect(result).toEqual({
      deletedSessions: 1,
      bucketDeleted: true,
      tokenDeleted: true,
    });
  });

  it('gracefully handles missing sessions (no sessions to clean)', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    const result = await cleanupUserData(email, createEnv());

    expect(result.deletedSessions).toBe(0);
    expect(mockGetContainer).not.toHaveBeenCalled();
  });

  it('gracefully handles missing R2 token (no token stored)', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    const result = await cleanupUserData(email, createEnv());

    expect(result.tokenDeleted).toBe(false);
    expect(mockDeleteScopedR2Token).not.toHaveBeenCalled();
    // r2token KV entry should still be deleted (cleanup)
    expect(mockKV.delete).toHaveBeenCalledWith(`r2token:${email}`);
  });

  it('gracefully handles R2 bucket deletion failure (logged, not thrown)', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    // Bucket delete returns error (no objects emptied = only 1 attempt)
    mockFetch.mockResolvedValueOnce(new Response('BucketNotEmpty', { status: 409 }));

    const result = await cleanupUserData(email, createEnv());

    expect(result.bucketDeleted).toBe(false);
    // Should NOT throw
  });

  it('retries bucket deletion when objects were emptied and first DELETE returns BucketNotEmpty', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    // emptyR2Bucket deleted objects, triggering retry logic
    mockEmptyR2Bucket.mockResolvedValueOnce(10);

    // First attempt: still not empty (R2 eventual consistency)
    // Second attempt: succeeds
    mockFetch
      .mockResolvedValueOnce(new Response('BucketNotEmpty', { status: 409 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await cleanupUserData(email, createEnv());

    expect(result.bucketDeleted).toBe(true);
    // Should have called fetch twice for bucket deletion
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('gracefully handles container destroy failure (continues with other sessions)', async () => {
    mockKV._set(`session:${bucketName}:abcdef0123456789`, { id: 'abcdef0123456789', name: 'S1', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._set(`session:${bucketName}:fedcba9876543210`, { id: 'fedcba9876543210', name: 'S2', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._store.set('setup:account_id', 'test-account-id');

    // First container destroy fails, second succeeds
    mockContainerDestroy
      .mockRejectedValueOnce(new Error('Container not found'))
      .mockResolvedValueOnce(undefined);

    const result = await cleanupUserData(email, createEnv());

    // Both sessions should still be cleaned from KV
    expect(result.deletedSessions).toBe(2);
    expect(mockKV.delete).toHaveBeenCalledWith(`session:${bucketName}:abcdef0123456789`);
    expect(mockKV.delete).toHaveBeenCalledWith(`session:${bucketName}:fedcba9876543210`);
  });

  it('reads r2token BEFORE deleting it (Block D can use token data)', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`r2token:${email}`, {
      accessKeyId: 'ak-123',
      secretAccessKey: 'sk-456',
      tokenId: 'token-id-789',
      bucketName,
      createdAt: '2024-01-01T00:00:00Z',
    });

    // Track KV call order to verify read happens before delete
    const kvCallOrder: string[] = [];
    const origGet = mockKV.get.bind(mockKV);
    const origDelete = mockKV.delete.bind(mockKV);
    mockKV.get = vi.fn<(key: string, type?: string) => Promise<unknown>>((...args) => {
      kvCallOrder.push(`get:${args[0]}`);
      return origGet(...args);
    });
    mockKV.delete = vi.fn<(key: string) => Promise<void>>((...args) => {
      kvCallOrder.push(`delete:${args[0]}`);
      return origDelete(...args);
    });

    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await cleanupUserData(email, createEnv());

    // r2token must be GET before DELETE
    const getIdx = kvCallOrder.indexOf(`get:r2token:${email}`);
    const deleteIdx = kvCallOrder.indexOf(`delete:r2token:${email}`);
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(getIdx);
  });

  it('skips R2 bucket deletion when accountId is missing', async () => {
    // No setup:account_id in KV

    const result = await cleanupUserData(email, createEnv());

    expect(result.bucketDeleted).toBe(false);
    // No fetch calls for bucket deletion
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips R2 bucket deletion when CLOUDFLARE_API_TOKEN is missing', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    const result = await cleanupUserData(email, createEnv({ CLOUDFLARE_API_TOKEN: '' } as Partial<Env>));

    expect(result.bucketDeleted).toBe(false);
  });

  it('gracefully handles r2token KV delete failure (FIX-2)', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`r2token:${email}`, {
      tokenId: 'tok-1',
      bucketName,
      createdAt: '2024-01-01T00:00:00Z',
    });

    // Make KV.delete throw specifically for the r2token key
    const origDelete = mockKV.delete.bind(mockKV);
    mockKV.delete = vi.fn<(key: string) => Promise<void>>(async (key: string) => {
      if (key === `r2token:${email}`) {
        throw new Error('KV delete failed');
      }
      return origDelete(key);
    });

    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    // Should NOT throw - the r2token KV delete failure is caught
    const result = await cleanupUserData(email, createEnv());

    // Token API deletion should still have succeeded
    expect(result.tokenDeleted).toBe(true);
  });

  // REQ-GITHUB-005: offboarding revokes the user's GitHub token AT GitHub (same
  // revoke+clear as POST /api/github/disconnect), not just a local KV delete.
  it('REQ-GITHUB-005: revokes the GitHub token at GitHub, then deletes the deploy-keys entry', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    // A connected GitHub token (app source) lives in the deploy-keys entry.
    // Stored plaintext — no ENCRYPTION_KEY in the test env (getAndDecrypt reads it back).
    mockKV._set(`deploy-keys:${bucketName}`, { githubToken: 'gho_secret', githubTokenSource: 'app' });

    const env = createEnv({ GITHUB_APP_CLIENT_ID: 'app-cid', GITHUB_APP_CLIENT_SECRET: 'app-sec' } as Partial<Env>);
    await cleanupUserData(email, env);

    // The GitHub token-revoke endpoint (DELETE /applications/{clientId}/token) was hit.
    const revokeCall = mockFetch.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/applications/app-cid/token'),
    );
    expect(revokeCall).toBeDefined();
    expect((revokeCall![1] as RequestInit).method).toBe('DELETE');
    // The deploy-keys entry holding the token is removed.
    expect(mockKV.delete).toHaveBeenCalledWith(`deploy-keys:${bucketName}`);
  });

  it('REQ-GITHUB-005: a failed GitHub revocation does not block local offboarding', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`user:${email}`, { role: 'user', addedBy: 'enterprise-jit' });
    mockKV._set(`deploy-keys:${bucketName}`, { githubToken: 'gho_secret', githubTokenSource: 'oauth' });
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return Promise.resolve(new Response('{}', { status: url.includes('/applications/') ? 404 : 200 }));
    });

    await cleanupUserData(email, createEnv({ OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec' } as Partial<Env>));

    expect(mockFetch.mock.calls.some((call) => String(call[0]).includes('/applications/oauth-cid/token'))).toBe(true);
    expect(await mockKV.get(`deploy-keys:${bucketName}`)).toBeNull();
    expect(await mockKV.get(`user:${email}`)).toBeNull();
  });

  it('REQ-GITHUB-005: makes no GitHub revoke call when the user never connected GitHub', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    const env = createEnv({ GITHUB_APP_CLIENT_ID: 'app-cid', GITHUB_APP_CLIENT_SECRET: 'app-sec' } as Partial<Env>);

    await cleanupUserData(email, env);

    const revokeCall = mockFetch.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/applications/'),
    );
    expect(revokeCall).toBeUndefined();
  });
});
