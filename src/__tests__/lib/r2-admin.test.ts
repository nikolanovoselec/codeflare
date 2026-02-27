import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock circuit breaker to pass through
vi.mock('../../lib/circuit-breakers', () => ({
  r2AdminCB: {
    execute: vi.fn((fn: () => Promise<Response>) => fn()),
  },
}));

// Mock logger
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  })),
}));

// Mock cf-api parseCfResponse
vi.mock('../../lib/cf-api', () => ({
  parseCfResponse: vi.fn(),
}));

import { createBucketIfNotExists, createScopedR2Token, deleteScopedR2Token, getOrCreateScopedR2Token } from '../../lib/r2-admin';
import { parseCfResponse } from '../../lib/cf-api';
import { r2AdminCB } from '../../lib/circuit-breakers';

const mockParseCfResponse = parseCfResponse as ReturnType<typeof vi.fn>;
const mockR2AdminCB = r2AdminCB as unknown as { execute: ReturnType<typeof vi.fn> };
const mockFetch = vi.fn();

describe('r2-admin', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockFetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('createBucketIfNotExists', () => {
    it('returns success with created=false when bucket already exists', async () => {
      // GET check returns 200 (bucket exists)
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await createBucketIfNotExists('account-123', 'token-abc', 'my-bucket');

      expect(result).toEqual({ success: true, created: false });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/r2/buckets/my-bucket'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('creates bucket when it does not exist', async () => {
      // GET check returns 404 (doesn't exist)
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 404 }));
      // POST create returns 200
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      mockParseCfResponse.mockResolvedValueOnce({
        success: true,
        errors: [],
        result: { name: 'my-bucket', creation_date: '2024-01-01', location: 'wnam' },
      });

      const result = await createBucketIfNotExists('account-123', 'token-abc', 'my-bucket');

      expect(result).toEqual({ success: true, created: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Second call should be POST to create bucket
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.stringContaining('/r2/buckets'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'my-bucket' }),
        }),
      );
    });

    it('handles already-exists race condition gracefully', async () => {
      // GET check returns 404 (doesn't exist at check time)
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 404 }));
      // POST create returns error (another request created it first)
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 409 }));
      mockParseCfResponse.mockResolvedValueOnce({
        success: false,
        errors: [{ code: 10006, message: 'Bucket already exists' }],
      });

      const result = await createBucketIfNotExists('account-123', 'token-abc', 'my-bucket');

      // Should treat "already exists" error as success
      expect(result).toEqual({ success: true, created: false });
    });

    it('returns error for non-recoverable API failure', async () => {
      // GET check returns 404
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 404 }));
      // POST create returns server error
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 500 }));
      mockParseCfResponse.mockResolvedValueOnce({
        success: false,
        errors: [{ code: 10000, message: 'Internal server error' }],
      });

      const result = await createBucketIfNotExists('account-123', 'token-abc', 'my-bucket');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Internal server error');
    });

    it('uses correct Authorization header', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await createBucketIfNotExists('account-123', 'my-secret-token', 'my-bucket');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-secret-token',
          }),
        }),
      );
    });

    it('uses correct account ID in URL', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await createBucketIfNotExists('test-account-id', 'token', 'bucket-name');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/accounts/test-account-id/r2/buckets/bucket-name'),
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // Scoped R2 Token: createScopedR2Token
  // =========================================================================
  describe('createScopedR2Token', () => {
    it('should POST to CF API /r2/tokens with bucket permission boundary', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: {
            id: 'token-id-123',
            access_key_id: 'ak-123',
            secret_access_key: 'sk-456',
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await createScopedR2Token('account-123', 'api-token', 'my-bucket');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/accounts/account-123/r2/tokens'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer api-token',
          }),
        }),
      );

      // Verify the body includes bucket permission boundary
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.policies).toBeDefined();
      expect(body.policies[0].permissionGroups).toBeDefined();
      expect(body.policies[0].condition).toBeDefined();
      // Condition should scope to the specific bucket
      expect(JSON.stringify(body.policies[0].condition)).toContain('my-bucket');
    });

    it('should return { accessKeyId, secretAccessKey, tokenId }', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: {
            id: 'token-id-123',
            access_key_id: 'ak-123',
            secret_access_key: 'sk-456',
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const result = await createScopedR2Token('account-123', 'api-token', 'my-bucket');

      expect(result).toEqual({
        accessKeyId: 'ak-123',
        secretAccessKey: 'sk-456',
        tokenId: 'token-id-123',
      });
    });

    it('should retry 2x with exponential backoff on 5xx errors', async () => {
      // First two calls fail with 500, third succeeds
      mockFetch
        .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
        .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            success: true,
            result: { id: 'tok', access_key_id: 'ak', secret_access_key: 'sk' },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        );

      const result = await createScopedR2Token('acc', 'tok', 'bucket');

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result.tokenId).toBe('tok');
    });

    it('should NOT retry on 4xx errors (except 429)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: 'Bad request' }],
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      );

      await expect(
        createScopedR2Token('acc', 'tok', 'bucket')
      ).rejects.toThrow();

      // Should NOT have retried
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on 429 errors', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('Rate limited', { status: 429 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            success: true,
            result: { id: 'tok', access_key_id: 'ak', secret_access_key: 'sk' },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        );

      const result = await createScopedR2Token('acc', 'tok', 'bucket');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.tokenId).toBe('tok');
    });

    it('should throw with descriptive error including bucket name on failure', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: false,
          errors: [{ code: 1001, message: 'Permission denied' }],
        }), { status: 403, headers: { 'Content-Type': 'application/json' } })
      );

      await expect(
        createScopedR2Token('acc', 'tok', 'my-special-bucket')
      ).rejects.toThrow(/my-special-bucket/);
    });

    it('should use circuit breaker wrapping (r2AdminCB)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: { id: 'tok', access_key_id: 'ak', secret_access_key: 'sk' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await createScopedR2Token('acc', 'tok', 'bucket');

      // The circuit breaker execute should have been called
      expect(mockR2AdminCB.execute).toHaveBeenCalled();
    });

    it('should NOT retry on network errors beyond retry limit', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'));

      await expect(
        createScopedR2Token('acc', 'tok', 'bucket')
      ).rejects.toThrow(/Network error/);

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // Scoped R2 Token: deleteScopedR2Token
  // =========================================================================
  describe('deleteScopedR2Token', () => {
    it('should DELETE to CF API /r2/tokens/{tokenId}', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await deleteScopedR2Token('account-123', 'api-token', 'token-id-456');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/accounts/account-123/r2/tokens/token-id-456'),
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            Authorization: 'Bearer api-token',
          }),
        }),
      );
    });

    it('should succeed silently on 404 (already deleted)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      // Should NOT throw
      await expect(
        deleteScopedR2Token('account-123', 'api-token', 'token-id-456')
      ).resolves.toBeUndefined();
    });

    it('should throw on other errors', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

      await expect(
        deleteScopedR2Token('account-123', 'api-token', 'token-id-456')
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // Scoped R2 Token: getOrCreateScopedR2Token
  // =========================================================================
  describe('getOrCreateScopedR2Token', () => {
    let mockKV: {
      get: ReturnType<typeof vi.fn>;
      put: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockKV = {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
      };
    });

    it('should return cached token from KV r2token:{email} if exists', async () => {
      const cached = {
        accessKeyId: 'cached-ak',
        secretAccessKey: 'cached-sk',
        tokenId: 'cached-tok',
        bucketName: 'my-bucket',
        createdAt: '2024-01-01T00:00:00Z',
      };
      mockKV.get.mockResolvedValue(JSON.stringify(cached));

      const result = await getOrCreateScopedR2Token(
        'user@example.com', 'account-123', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
      );

      expect(mockKV.get).toHaveBeenCalledWith('r2token:user@example.com');
      expect(result.accessKeyId).toBe('cached-ak');
      expect(result.secretAccessKey).toBe('cached-sk');
      // Should NOT have called fetch (no token creation)
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should create new token if KV returns null, write to KV, return creds', async () => {
      mockKV.get.mockResolvedValue(null);

      // Mock the createScopedR2Token call (via fetch)
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: { id: 'new-tok', access_key_id: 'new-ak', secret_access_key: 'new-sk' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const result = await getOrCreateScopedR2Token(
        'user@example.com', 'account-123', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
      );

      // Should have created a new token
      expect(mockFetch).toHaveBeenCalled();
      expect(result.accessKeyId).toBe('new-ak');
      expect(result.secretAccessKey).toBe('new-sk');

      // Should have written to KV
      expect(mockKV.put).toHaveBeenCalledWith(
        'r2token:user@example.com',
        expect.stringContaining('new-ak'),
      );
    });

    it('should return creds directly (in-memory) without KV read-back', async () => {
      mockKV.get.mockResolvedValue(null);

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: { id: 'new-tok', access_key_id: 'new-ak', secret_access_key: 'new-sk' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await getOrCreateScopedR2Token(
        'user@example.com', 'account-123', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
      );

      // KV.get should only be called once (initial check), NOT a second time for read-back
      expect(mockKV.get).toHaveBeenCalledTimes(1);
    });

    it('should self-heal: if cached token exists but R2 returns 403, delete stale KV entry and create fresh token', async () => {
      const staleToken = {
        accessKeyId: 'stale-ak',
        secretAccessKey: 'stale-sk',
        tokenId: 'stale-tok',
        bucketName: 'my-bucket',
        createdAt: '2024-01-01T00:00:00Z',
        _stale: true,
      };
      mockKV.get.mockResolvedValue(JSON.stringify(staleToken));

      // First call with cached creds results in a 403 (simulated via the selfHeal flag
      // or by the function detecting staleness — depends on implementation)
      // For TDD: we expect the function to accept an optional `validate` callback
      // or check token validity internally. We'll test the full flow:
      // getOrCreateScopedR2Token should have a mechanism to handle stale tokens.
      // The implementation will need to validate the cached token.

      // Mock: create new token after stale detection
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: { id: 'fresh-tok', access_key_id: 'fresh-ak', secret_access_key: 'fresh-sk' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      // Call with forceFresh=true to simulate stale detection
      const result = await getOrCreateScopedR2Token(
        'user@example.com', 'account-123', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
        { forceFresh: true },
      );

      // Should have deleted the stale KV entry
      expect(mockKV.delete).toHaveBeenCalledWith('r2token:user@example.com');
      // Should have created a fresh token
      expect(result.accessKeyId).toBe('fresh-ak');
      // Should have written new token to KV
      expect(mockKV.put).toHaveBeenCalledWith(
        'r2token:user@example.com',
        expect.stringContaining('fresh-ak'),
      );
    });
  });
});
