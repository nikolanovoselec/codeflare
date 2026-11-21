import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import { attachMcpOwners, mcpPortalFixture, portal, access, deferred, legacyCiphertext, legacyConnectionKey } from '../helpers/mcp-portal-fixture';
import { getMcpPortalGrant, getValidMcpPortalToken } from '../../lib/mcp-portal-token';

// Mock dependencies before imports
const mockResolveBucketName = vi.hoisted(() => vi.fn());
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  resolveBucketName: mockResolveBucketName,
}));

const mockDeleteScopedR2Token = vi.hoisted(() => vi.fn());
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
  let mockUsageDb: D1Database;
  let mockUsageBatch: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  const email = 'target@example.com';
  const bucketName = 'codeflare-target-example-com';
  let ownerEnvironment: Env;

  function baseEnv(): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
      CONTAINER: {} as unknown as Env['CONTAINER'],
      CLOUDFLARE_API_TOKEN: 'test-api-token',
      CLOUDFLARE_WORKER_NAME: undefined,
      R2_ACCESS_KEY_ID: 'test-r2-access-key',
      R2_SECRET_ACCESS_KEY: 'test-r2-secret-key',
      USAGE_DB: mockUsageDb,
    } as unknown as Env;
  }
  function createEnv(overrides?: Partial<Env>): Env {
    return Object.assign(ownerEnvironment, overrides);
  }

  beforeEach(async () => {
    mockKV = createMockKV();
    mockKV._store.set('setup:account_id', 'test-account-id');
    globalThis.fetch = mockFetch;
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    mockDeleteScopedR2Token.mockResolvedValue(undefined);
    // The shared fixture owns the SDK base seam; cleanup supplies only its
    // external session-destruction transport, never an MCP state implementation.
    mockGetContainer.mockReturnValue(containerState as unknown as ReturnType<typeof getContainer>);
    mockContainerDestroy.mockResolvedValue(undefined);
    mockEmptyR2Bucket.mockResolvedValue(0);
    mockCreateR2Client.mockReturnValue({});
    mockResolveBucketName.mockResolvedValue(bucketName);
    mockUsageBatch = vi.fn(async () => [{ success: true }]);
    mockUsageDb = Object.assign(createMockSessionD1(mockKV), { batch: mockUsageBatch });
    ownerEnvironment = baseEnv();
    const owners = await attachMcpOwners(ownerEnvironment);
    await owners.claim(bucketName, email);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('resolves ownership, then writes a D1 tombstone before live cleanup', async () => {
    mockKV._store.set(`user:${email}`, JSON.stringify({ role: 'user' }));
    await cleanupUserData(email, createEnv());

    expect(await mockKV.get(`user:${email}`)).toBeNull();
    expect(mockUsageBatch).toHaveBeenCalledOnce();
    expect(mockResolveBucketName.mock.invocationCallOrder[0]).toBeLessThan(mockUsageBatch.mock.invocationCallOrder[0]);
    expect(mockUsageBatch.mock.invocationCallOrder[0]).toBeLessThan(mockKV.delete.mock.invocationCallOrder[0]);
  });

  it('does not tombstone when verified bucket resolution fails before cleanup', async () => {
    mockKV._store.set(`user:${email}`, JSON.stringify({ role: 'user' }));
    mockResolveBucketName.mockRejectedValueOnce(new Error('ownership unavailable'));
    await expect(cleanupUserData(email, createEnv())).rejects.toThrow('ownership unavailable');
    expect(mockUsageBatch).not.toHaveBeenCalled();
    expect(await mockKV.get(`user:${email}`)).not.toBeNull();
  });

  it('fails closed with typed 503 evidence and leaves live data unchanged when tombstoning fails', async () => {
    mockKV._store.set(`user:${email}`, JSON.stringify({ role: 'user' }));
    mockUsageBatch.mockRejectedValueOnce(new Error('D1 unavailable'));

    await expect(cleanupUserData(email, createEnv())).rejects.toMatchObject({
      code: 'history_delete_unavailable',
      statusCode: 503,
    });
    expect(await mockKV.get(`user:${email}`)).not.toBeNull();
    expect(mockKV.delete).not.toHaveBeenCalled();
    expect(mockContainerDestroy).not.toHaveBeenCalled();
  });

  it('resolves verified bucket ownership before deleting user state', async () => {
    mockKV._set(`user:${email}`, { role: 'user' });
    mockKV._store.set('setup:account_id', 'test-account-id');

    await cleanupUserData(email, createEnv());

    expect(await mockKV.get(`user:${email}`)).toBeNull();
    expect(mockResolveBucketName).toHaveBeenCalledWith(expect.anything(), email);
    expect(mockResolveBucketName.mock.invocationCallOrder[0]).toBeLessThan(mockKV.delete.mock.invocationCallOrder[0]);
  });

  it('destroys active sessions and their containers', async () => {
    // Set up two sessions in KV
    mockKV._set(`session:${bucketName}:abcdef0123456789`, { id: 'abcdef0123456789', name: 'Session 1', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._set(`session:${bucketName}:fedcba9876543210`, { id: 'fedcba9876543210', name: 'Session 2', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._store.set('setup:account_id', 'test-account-id');

    const result = await cleanupUserData(email, createEnv());

    expect(result.deletedSessions).toBe(2);
    // Should have called getContainer + destroy for each session
    expect(mockGetContainer).toHaveBeenCalledTimes(2);
    expect(mockContainerDestroy).toHaveBeenCalledTimes(2);
    // Session KV entries should be deleted
    expect(mockKV.delete).toHaveBeenCalledWith(`session:${bucketName}:abcdef0123456789`);
    expect(mockKV.delete).toHaveBeenCalledWith(`session:${bucketName}:fedcba9876543210`);
  });

  it('REQ-AUTH-026 AC2: deletes the existing user record from KV', async () => {
    mockKV._set(`user:${email}`, { role: 'user' });
    await cleanupUserData(email, createEnv());
    expect(await mockKV.get(`user:${email}`)).toBeNull();
  });

  it('REQ-AUTH-026 AC2: erases every owned local resource before the user record and preserves neighboring data', async () => {
    const userKey = `user:${email}`;
    const owned = [
      `session:${bucketName}:abcdef0123456789`,
      `storage-stats:${bucketName}`, `presets:${bucketName}`, `user-prefs:${bucketName}`,
      `llm-keys:${bucketName}`, `deploy-keys:${bucketName}`, `timekeeper:${bucketName}`,
      `r2-regime:${bucketName}`, `pushsub:${bucketName}:subscription`, `r2token:${email}`,
    ];
    const user = { role: 'user', addedBy: 'setup', addedAt: '2025-01-01' };
    mockKV._set(userKey, user);
    for (const key of owned) mockKV._set(key, { retained: key });
    mockKV._set(owned[0]!, {
      id: 'abcdef0123456789', name: 'Owned session', userId: email, createdAt: '', lastAccessedAt: '',
    });
    mockKV._set(`r2token:${email}`, { tokenId: 'scoped-token', bucketName });
    const neighborKeys = owned.map(key => key.replace(bucketName, `${bucketName}-neighbor`).replace(email, 'neighbor@example.com'));
    neighborKeys.push('user:neighbor@example.com');
    for (const key of neighborKeys) mockKV._set(key, { retained: key });
    const neighboringData = neighborKeys.map(key => [key, mockKV._store.get(key)]);
    let beforeUserRemoval: { user: string | undefined; remaining: string[] } | undefined;
    const remove = mockKV.delete.getMockImplementation()!;
    mockKV.delete.mockImplementation(async key => {
      if (key === userKey) {
        beforeUserRemoval = {
          user: mockKV._store.get(userKey), remaining: owned.filter(name => mockKV._store.has(name)),
        };
      }
      return remove(key);
    });

    expect(await cleanupUserData(email, createEnv())).toEqual({
      deletedSessions: 1, bucketDeleted: true, tokenDeleted: true,
    });
    expect(beforeUserRemoval).toEqual({ user: JSON.stringify(user), remaining: [] });
    expect(owned.filter(key => mockKV._store.has(key))).toEqual([]);
    expect(await mockKV.get(userKey)).toBeNull();
    expect(neighborKeys.map(key => [key, mockKV._store.get(key)])).toEqual(neighboringData);
  });

  it('REQ-AUTH-026 AC2: removes bucket-keyed settings and legacy presets', async () => {
    const keys = [`storage-stats:${bucketName}`, `user-prefs:${bucketName}`, `presets:${bucketName}`];
    for (const key of keys) mockKV._set(key, { existing: true });
    await cleanupUserData(email, createEnv());
    for (const key of keys) expect(await mockKV.get(key)).toBeNull();
  });

  it('REQ-AUTH-018 AC3 / REQ-SEC-023 AC4: deletes every push-subscription prefix entry and preserves other users', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`pushsub:${bucketName}:digest-a`, { endpoint: 'https://fcm.googleapis.com/fcm/send/a' });
    mockKV._set(`pushsub:${bucketName}:digest-b`, { endpoint: 'https://web.push.apple.com/b' });
    mockKV._set('pushsub:codeflare-other-user:digest-c', { endpoint: 'https://fcm.googleapis.com/fcm/send/c' });

    await cleanupUserData(email, createEnv());

    expect(await mockKV.get(`pushsub:${bucketName}:digest-a`)).toBeNull();
    expect(await mockKV.get(`pushsub:${bucketName}:digest-b`)).toBeNull();
    expect(await mockKV.get('pushsub:codeflare-other-user:digest-c')).not.toBeNull();
  });

  it('REQ-AUTH-018 AC3: follows paginated push-subscription cursors until complete', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`pushsub:${bucketName}:digest-page-1`, { endpoint: 'https://push.example/1' });
    mockKV._set(`pushsub:${bucketName}:digest-page-2`, { endpoint: 'https://push.example/2' });
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
    expect(await mockKV.get(`pushsub:${bucketName}:digest-page-1`)).toBeNull();
    expect(await mockKV.get(`pushsub:${bucketName}:digest-page-2`)).toBeNull();
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

  it('REQ-AUTH-018 AC3: bucket failure preserves retry records and refuses success', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    // Bucket delete returns error (no objects emptied = only 1 attempt)
    mockFetch.mockResolvedValueOnce(new Response('BucketNotEmpty', { status: 409 }));

    mockKV._set(`user:${email}`, { role: 'user' });
    mockKV._set(`r2token:${email}`, { tokenId: 'retry-token' });
    await expect(cleanupUserData(email, createEnv())).rejects.toThrow();
    expect(await mockKV.get(`user:${email}`)).not.toBeNull();
    expect(await mockKV.get(`r2token:${email}`, 'json')).toMatchObject({ tokenId: 'retry-token' });
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await cleanupUserData(email, createEnv());
    expect(await mockKV.get(`user:${email}`)).toBeNull();
    expect(await mockKV.get(`r2token:${email}`)).toBeNull();
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

  it('REQ-AUTH-018 AC3: failed container cleanup retains session recovery rows', async () => {
    mockKV._set(`session:${bucketName}:abcdef0123456789`, { id: 'abcdef0123456789', name: 'S1', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._set(`session:${bucketName}:fedcba9876543210`, { id: 'fedcba9876543210', name: 'S2', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._store.set('setup:account_id', 'test-account-id');

    // First container destroy fails, second succeeds
    mockContainerDestroy
      .mockRejectedValueOnce(new Error('Container not found'))
      .mockResolvedValueOnce(undefined);

    await expect(cleanupUserData(email, createEnv())).rejects.toThrow();
    expect(await mockKV.get(`session:${bucketName}:abcdef0123456789`)).not.toBeNull();
    expect(await mockKV.get(`session:${bucketName}:fedcba9876543210`)).not.toBeNull();
  });

  it('REQ-AUTH-018 AC3: remote revoke failure retains credentials and user for a convergent retry', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`user:${email}`, { role: 'user' });
    mockKV._set(`r2token:${email}`, { tokenId: 'retry-token', bucketName });
    mockDeleteScopedR2Token.mockRejectedValueOnce(new Error('remote unavailable'));
    await expect(cleanupUserData(email, createEnv())).rejects.toThrow();
    expect(await mockKV.get(`r2token:${email}`, 'json')).toMatchObject({ tokenId: 'retry-token' });
    expect(await mockKV.get(`user:${email}`)).not.toBeNull();
    await cleanupUserData(email, createEnv());
    expect(await mockKV.get(`r2token:${email}`)).toBeNull();
    expect(await mockKV.get(`user:${email}`)).toBeNull();
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
    expect(await mockKV.get(`r2token:${email}`)).toBeNull();
  });

  it('REQ-AUTH-018 AC3: missing cleanup authority refuses deletion and preserves user', async () => {
    mockKV._store.delete('setup:account_id');
    mockKV._set(`user:${email}`, { role: 'user' });
    await expect(cleanupUserData(email, createEnv())).rejects.toThrow();
    expect(await mockKV.get(`user:${email}`)).not.toBeNull();
    // No fetch calls for bucket deletion
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('REQ-AUTH-018 AC3: missing API authority cannot report successful cleanup', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    await expect(cleanupUserData(email, createEnv({ CLOUDFLARE_API_TOKEN: '' } as Partial<Env>))).rejects.toThrow();
  });

  it('REQ-AUTH-018 AC3: local credential cleanup failure is not success', async () => {
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

    await expect(cleanupUserData(email, createEnv())).rejects.toThrow('KV delete failed');
    expect(await mockKV.get(`r2token:${email}`)).not.toBeNull();
  });

  it.each(['success', 'github', 'cloudflare'] as const)(
    'REQ-AUTH-018 AC3 / REQ-SEC-003 AC6: provider %s preserves storage authority until revocation and retry converges', async failure => {
      // Real provider helpers read this shared KV entry (not an R2 object).
      const credentials = {
        githubToken: 'gho_retry', githubTokenSource: 'oauth',
        cloudflareApiToken: 'cf_access', cloudflareTokenSource: 'oauth',
        cloudflareRefreshToken: 'cf_refresh', cloudflareAccountId: 'user-account',
      };
      mockKV._set(`deploy-keys:${bucketName}`, credentials);
      mockKV._set(`user:${email}`, { role: 'user' });
      mockKV._set(`r2token:${email}`, { tokenId: 'retry-token', bucketName });
      mockKV._store.set('setup:cloudflare_oauth_client_id', 'cf-client');
      mockKV._set('setup:cloudflare_oauth_client_secret', { secret: 'cf-secret' });
      const env = createEnv({ OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec' });
      const providerActive = { github: true, cloudflare: true };
      mockKV._set(`session:${bucketName}:abcdef0123456789`, {
        id: 'abcdef0123456789', name: 'Active session', userId: email, createdAt: '', lastAccessedAt: '',
      });
      let containerLive = true;
      let providerSawLiveContainer = false;
      mockContainerDestroy.mockImplementation(async () => { containerLive = false; });
      const bucketObjects = new Map([['workspace/retry.txt', 'retained user bytes']]);
      let bucketExists = true;
      let scopedTokenActive = true;
      let destroyedBeforeRevocation = false;
      let failedProvider: string | null = failure === 'success' ? null : failure;
      const observeDestruction = () => {
        destroyedBeforeRevocation ||= providerActive.github || providerActive.cloudflare;
      };
      mockDeleteScopedR2Token.mockImplementation(async () => {
        observeDestruction();
        scopedTokenActive = false;
      });
      mockEmptyR2Bucket.mockImplementation(async () => {
        observeDestruction();
        bucketObjects.clear();
        return 0;
      });
      mockFetch.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/applications/oauth-cid/token')) {
          providerSawLiveContainer ||= containerLive;
          expect(JSON.parse(String(init?.body))).toEqual({ access_token: 'gho_retry' });
          if (failedProvider === 'github') return new Response(null, { status: 503 });
          providerActive.github = false;
          return new Response(null, { status: 204 });
        }
        if (url === 'https://dash.cloudflare.com/oauth2/revoke') {
          providerSawLiveContainer ||= containerLive;
          const body = new URLSearchParams(String(init?.body));
          expect(body.get('token')).toBe('cf_refresh');
          if (failedProvider === 'cloudflare') return new Response(null, { status: 503 });
          providerActive.cloudflare = false;
          return new Response(null, { status: 200 });
        }
        if (url.endsWith(`/r2/buckets/${bucketName}`)) {
          observeDestruction();
          bucketExists = false;
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected fixture request: ${url}`);
      });

      if (failure !== 'success') {
        await expect(cleanupUserData(email, env)).rejects.toThrow();
        expect(providerActive[failure]).toBe(true);
        expect(bucketExists).toBe(true);
        expect(bucketObjects.get('workspace/retry.txt')).toBe('retained user bytes');
        expect(scopedTokenActive).toBe(true);
        expect(await mockKV.get(`r2token:${email}`, 'json')).toMatchObject({ tokenId: 'retry-token' });
        expect(await mockKV.get(`user:${email}`)).not.toBeNull();
        expect(await mockKV.get(`deploy-keys:${bucketName}`, 'json')).toMatchObject(
          failure === 'github' ? credentials : {
            cloudflareApiToken: 'cf_access', cloudflareRefreshToken: 'cf_refresh',
          },
        );
        failedProvider = null;
      }

      await expect(cleanupUserData(email, env)).resolves.toMatchObject({ bucketDeleted: true, tokenDeleted: true });
      expect(providerActive).toEqual({ github: false, cloudflare: false });
      expect(containerLive).toBe(false);
      expect(providerSawLiveContainer).toBe(false);
      expect(destroyedBeforeRevocation).toBe(false);
      expect(bucketExists).toBe(false);
      expect(bucketObjects.size).toBe(0);
      expect(scopedTokenActive).toBe(false);
      expect(await mockKV.get(`deploy-keys:${bucketName}`)).toBeNull();
      expect(await mockKV.get(`r2token:${email}`)).toBeNull();
      expect(await mockKV.get(`user:${email}`)).toBeNull();
    },
  );

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
    expect(await mockKV.get(`deploy-keys:${bucketName}`)).toBeNull();
  });

  it('REQ-AUTH-018 AC3: offboarding retains provider retry credentials and user after failed revocation', async () => {
    mockKV._set(`user:${email}`, { role: 'user' });
    mockKV._set(`deploy-keys:${bucketName}`, { githubToken: 'gho_retry', githubTokenSource: 'oauth' });
    mockFetch.mockImplementation((input: string | URL | Request) => Promise.resolve(new Response('{}', {
      status: String(input).includes('/applications/') ? 503 : 200,
    })));
    const env = createEnv({ OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec' } as Partial<Env>);
    await expect(cleanupUserData(email, env)).rejects.toThrow();
    expect(await mockKV.get(`deploy-keys:${bucketName}`, 'json')).toMatchObject({ githubToken: 'gho_retry' });
    expect(await mockKV.get(`user:${email}`)).not.toBeNull();
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await cleanupUserData(email, env);
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
    expect(await mockKV.get(`user:${email}`)).toBeNull();
  });

  async function mcpCleanupFixture(lifetime = 3600, connected = true) {
    const f = await mcpPortalFixture({ ...createEnv(), ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, mockKV);
    await f.owners.claim(bucketName, email);
    mockKV._set(`user:${email}`, { role: 'user' });
    f.expiry(lifetime);
    if (connected) { await f.begin(bucketName); await f.finish(bucketName); }
    return f;
  }

  it('REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2/7: offboarding invalidates target grants and pending flows without touching another owner', async () => {
    const f = await mcpCleanupFixture();
    const other = 'codeflare-other-example-com';
    await f.owners.claim(other, 'other@example.com');
    await f.begin(other); await f.finish(other);
    const otherPending = await f.begin(other);
    const targetPending = await f.begin(bucketName);
    await expect(cleanupUserData(email, f.env)).resolves.toMatchObject({ bucketDeleted: true });
    expect(await getMcpPortalGrant(f.env, bucketName, portal)).toBeNull();
    expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
    f.visitAuthorization(targetPending.href);
    await expect(f.finish(bucketName)).rejects.toThrow();
    expect(await getValidMcpPortalToken(f.env, other, portal, f.send)).toBe(access);
    f.visitAuthorization(otherPending.href);
    await f.finish(other);
    expect(await getValidMcpPortalToken(f.env, other, portal, f.send)).toBe(access);
    expect(await mockKV.get(`user:${email}`)).toBeNull();
  });

  it.each(['callback', 'refresh'] as const)(
    'REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2/5: cleanup during %s exchange cannot publish or return provider credentials', async operation => {
      const f = await mcpCleanupFixture(operation === 'refresh' ? 30 : 3600);
      if (operation === 'callback') await f.begin(bucketName);
      f.expiry(3600);
      f.beforeToken(async () => { await cleanupUserData(email, f.env); });
      if (operation === 'callback') await expect(f.finish(bucketName)).rejects.toThrow();
      else expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
      expect(await getMcpPortalGrant(f.env, bucketName, portal)).toBeNull();
      expect(await mockKV.get(`user:${email}`)).toBeNull();
      f.owners.reconstruct(bucketName);
      expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
    });

  it.each(['callback', 'refresh'] as const)(
    'REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2/5: offboarding between the final %s observation and commit cannot be overwritten', async operation => {
      const f = await mcpCleanupFixture(operation === 'refresh' ? 30 : 3600);
      if (operation === 'callback') await f.begin(bucketName);
      f.expiry(3600);
      f.beforeConnectionWrite(async () => { await cleanupUserData(email, f.env); });
      if (operation === 'callback') await expect(f.finish(bucketName)).rejects.toThrow();
      else expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
      expect(await mockKV.get(`user:${email}`)).toBeNull();
      expect(await getMcpPortalGrant(f.env, bucketName, portal)).toBeNull();
    });

  it('REQ-AUTH-026 AC2 / REQ-AGENT-226 AC1/2: Connect admitted before discovery cannot save pending state after cleanup', async () => {
    const f = await mcpCleanupFixture();
    f.beforeDiscovery(async () => { await cleanupUserData(email, f.env); });
    await expect(f.begin(bucketName)).rejects.toThrow();
    expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
    expect(await mockKV.get(`user:${email}`)).toBeNull();
  });

  it('REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2/4: permanently stale legacy reads cannot resurrect credentials after owner recreation', async () => {
    const f = await mcpCleanupFixture();
    const old = (await getMcpPortalGrant(f.env, bucketName, portal))!;
    const legacy = await legacyCiphertext(f.env, old);
    const key = legacyConnectionKey(bucketName);
    await mockKV.put(key, legacy);
    const pending = await f.begin(bucketName);
    const read = mockKV.get.getMockImplementation()!;
    mockKV.get.mockImplementation((name, type) => name === key ? Promise.resolve(legacy) : read(name, type));
    await cleanupUserData(email, f.env);
    expect(mockKV._store.has(key)).toBe(false);
    for (let attempt = 0; attempt < 3; attempt++) expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
    mockKV._set(`user:${email}`, { role: 'user', addedAt: new Date().toISOString() });
    f.owners.reconstruct(bucketName);
    expect(await getMcpPortalGrant(f.env, bucketName, portal)).toBeNull();
    f.visitAuthorization(pending.href);
    await expect(f.finish(bucketName)).rejects.toThrow();
    await f.begin(bucketName); await f.finish(bucketName);
    expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBe(access);
    expect((await getMcpPortalGrant(f.env, bucketName, portal))?.id).not.toBe(old.id);
  });

  it('REQ-AUTH-026 AC2 / REQ-AGENT-226 AC4: a legacy import delayed across cleanup cannot commit against the reopened owner', async () => {
    const source = await mcpCleanupFixture();
    const old = (await getMcpPortalGrant(source.env, bucketName, portal))!;
    const f = await mcpCleanupFixture(3600, false);
    const key = legacyConnectionKey(bucketName);
    const legacy = await legacyCiphertext(f.env, old);
    await mockKV.put(key, legacy);
    const reached = deferred(); const release = deferred();
    const read = mockKV.get.getMockImplementation()!;
    let held = false;
    mockKV.get.mockImplementation(async (name, type) => {
      if (name === key && !held) { held = true; reached.resolve(); await release.promise; return legacy; }
      return read(name, type);
    });
    const importing = getMcpPortalGrant(f.env, bucketName, portal);
    await reached.promise;
    try { await cleanupUserData(email, f.env); }
    finally { release.resolve(); }
    expect(await importing).toBeNull();
    expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
  });

  it.each(['bucket', 'legacy-purge'] as const)(
    'REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2: failed %s cleanup and reconstruction remain closed until an authorized retry succeeds', async failure => {
      const f = await mcpCleanupFixture();
      const old = (await getMcpPortalGrant(f.env, bucketName, portal))!;
      const key = legacyConnectionKey(bucketName, 'removed-portal');
      await mockKV.put(key, await legacyCiphertext(f.env, { ...old, portal: { ...portal, name: 'removed-portal' } }));
      if (failure === 'bucket') mockFetch.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
      const remove = mockKV.delete.getMockImplementation()!;
      if (failure === 'legacy-purge') mockKV.delete.mockImplementation(async name => {
        if (name === key) throw new Error('legacy deletion unavailable');
        return remove(name);
      });
      await expect(cleanupUserData(email, f.env)).rejects.toThrow();
      expect(await mockKV.get(`user:${email}`)).not.toBeNull();
      expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
      await expect(f.begin(bucketName)).rejects.toThrow();
      f.owners.reconstruct(bucketName);
      expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
      await expect(f.begin(bucketName)).rejects.toThrow();
      mockKV.delete.mockImplementation(remove);
      await cleanupUserData(email, f.env);
      expect(await mockKV.get(`user:${email}`)).toBeNull();
      expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
      mockKV._set(`user:${email}`, { role: 'user' });
      await f.begin(bucketName); await f.finish(bucketName);
      expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBe(access);
    });

  it('REQ-AUTH-026 AC2: paginated legacy purge includes removed portals, preserves neighboring owners and precedes user deletion', async () => {
    const f = await mcpCleanupFixture();
    const prefix = legacyConnectionKey(bucketName, '');
    const removed = `${prefix}removed`;
    const configured = `${prefix}${portal.name}`;
    const neighbor = legacyConnectionKey(`${bucketName}-neighbor`);
    mockKV._store.set(removed, 'old encrypted record');
    mockKV._store.set(configured, 'old encrypted record');
    mockKV._store.set(neighbor, 'other owner encrypted record');
    const list = mockKV.list.getMockImplementation()!;
    mockKV.list.mockImplementation(async options => {
      if (options?.prefix !== prefix) return list(options);
      return options.cursor ? { keys: [{ name: removed, metadata: null }], list_complete: true }
        : { keys: [{ name: configured, metadata: null }], list_complete: false, cursor: 'removed-portals' };
    });
    const remove = mockKV.delete.getMockImplementation()!;
    mockKV.delete.mockImplementation(async name => {
      if (name === `user:${email}`) {
        expect(mockKV._store.has(removed)).toBe(false);
        expect(mockKV._store.has(configured)).toBe(false);
        expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
      }
      return remove(name);
    });
    await cleanupUserData(email, f.env);
    expect(mockKV._store.has(removed)).toBe(false);
    expect(mockKV._store.has(configured)).toBe(false);
    expect(await mockKV.get(neighbor)).toBe('other owner encrypted record');
    expect(await mockKV.get(`user:${email}`)).toBeNull();
  });

  it('REQ-AUTH-026 AC2: rejected parallel KV deletion retains live cleanup exclusion until all started deletes settle', async () => {
    const f = await mcpCleanupFixture();
    const failedKey = `storage-stats:${bucketName}`;
    const heldKeys = [`presets:${bucketName}`, `user-prefs:${bucketName}`];
    for (const key of [failedKey, ...heldKeys]) mockKV._set(key, { retained: key });
    const started = new Set<string>();
    const allStarted = deferred(); const rejectDelete = deferred(); const rejectionRaised = deferred();
    const heldDeletes = heldKeys.map(() => deferred());
    const completedDeletes = heldKeys.map(() => deferred());
    const remove = mockKV.delete.getMockImplementation()!;
    mockKV.delete.mockImplementation(async key => {
      if (key === failedKey || heldKeys.includes(key)) {
        started.add(key);
        if (started.size === heldKeys.length + 1) allStarted.resolve();
      }
      if (key === failedKey) {
        await rejectDelete.promise;
        rejectionRaised.resolve();
        throw new Error('synthetic parallel KV deletion unavailable');
      }
      const index = heldKeys.indexOf(key);
      if (index !== -1) await heldDeletes[index]!.promise;
      await remove(key);
      if (index !== -1) completedDeletes[index]!.resolve();
    });
    let firstSettled = false;
    const first = cleanupUserData(email, f.env).then(
      value => { firstSettled = true; return { status: 'fulfilled' as const, value }; },
      reason => { firstSettled = true; return { status: 'rejected' as const, reason }; },
    );
    try {
      await allStarted.promise;
      rejectDelete.resolve();
      await rejectionRaised.promise;
      // Let the rejection propagate through the real owner RPC. No pending
      // deletion can complete on this turn: only the explicit gates release it.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(firstSettled).toBe(false);
      await expect(cleanupUserData(email, f.env)).rejects.toMatchObject({
        code: 'user_cleanup_incomplete', statusCode: 503,
      });
      expect(await mockKV.get(`user:${email}`, 'json')).toEqual({ role: 'user' });
      for (const key of heldKeys) expect(await mockKV.get(key, 'json')).toEqual({ retained: key });
      expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
      await expect(f.begin(bucketName)).rejects.toThrow();
      // Waiting for just one successful sibling is also insufficient.
      heldDeletes[0]!.resolve();
      await completedDeletes[0]!.promise;
      expect(await mockKV.get(heldKeys[0]!)).toBeNull();
      expect(firstSettled).toBe(false);
      await expect(cleanupUserData(email, f.env)).rejects.toMatchObject({
        code: 'user_cleanup_incomplete', statusCode: 503,
      });
      expect(await mockKV.get(`user:${email}`, 'json')).toEqual({ role: 'user' });
    } finally {
      rejectDelete.resolve();
      for (const gate of heldDeletes) gate.resolve();
      await first;
    }
    expect(await first).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    for (const key of heldKeys) expect(await mockKV.get(key)).toBeNull();
    expect(await mockKV.get(failedKey, 'json')).toEqual({ retained: failedKey });
    expect(await mockKV.get(`user:${email}`, 'json')).toEqual({ role: 'user' });
    expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
    await expect(f.begin(bucketName)).rejects.toThrow();
  });

  it('REQ-AUTH-026 AC2: live cleanup exclusion rejects a second deletion rather than erasing a recreated generation', async () => {
    const f = await mcpCleanupFixture();
    const reached = deferred(); const release = deferred();
    mockFetch.mockImplementationOnce(async () => { reached.resolve(); await release.promise; return new Response('{}'); });
    const first = cleanupUserData(email, f.env);
    await reached.promise;
    try {
      await expect(cleanupUserData(email, f.env)).rejects.toThrow();
      expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBeNull();
    } finally { release.resolve(); await first; }
    mockKV._set(`user:${email}`, { role: 'user', addedAt: 'recreated' });
    await f.begin(bucketName); await f.finish(bucketName);
    expect(await getValidMcpPortalToken(f.env, bucketName, portal, f.send)).toBe(access);
    expect(await mockKV.get(`user:${email}`, 'json')).toMatchObject({ addedAt: 'recreated' });
  });

});
