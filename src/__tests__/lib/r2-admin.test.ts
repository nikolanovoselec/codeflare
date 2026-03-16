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
    // Helper: create a mock successful response for the /tokens endpoint
    function mockTokenResponse(id = 'token-id-123', value = 'raw-token-value') {
      return new Response(JSON.stringify({
        success: true,
        result: { id, value },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Helper: compute expected SHA-256 hex of a string (matches Workers crypto.subtle)
    async function sha256Hex(input: string): Promise<string> {
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(input));
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    it('should POST to CF API /accounts/{id}/tokens (not /r2/tokens)', async () => {
      mockFetch.mockResolvedValueOnce(mockTokenResponse());

      await createScopedR2Token('account-123', 'api-token', 'my-bucket');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/accounts/account-123/tokens'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer api-token',
          }),
        }),
      );
      // Must NOT contain /r2/tokens
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('/r2/tokens');
    });

    it('should send correct body with name, permission_groups, and resources', async () => {
      mockFetch.mockResolvedValueOnce(mockTokenResponse());

      await createScopedR2Token('account-123', 'api-token', 'my-bucket');

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.name).toBe('my-bucket');
      expect(body.policies).toHaveLength(1);
      expect(body.policies[0].effect).toBe('allow');
      expect(body.policies[0].permission_groups).toEqual([
        { id: '6a018a9f2fc74eb6b293b0c548f38b39' },
        { id: '2efd5506f9c8494dacb1fa10a3e7d5b6' },
      ]);
      expect(body.policies[0].resources).toEqual({
        'com.cloudflare.edge.r2.bucket.account-123_default_my-bucket': '*',
      });
    });

    it('should return accessKeyId=result.id, secretAccessKey=SHA-256(result.value), tokenId=result.id', async () => {
      const tokenValue = 'raw-token-value-xyz';
      mockFetch.mockResolvedValueOnce(mockTokenResponse('token-id-123', tokenValue));

      const result = await createScopedR2Token('account-123', 'api-token', 'my-bucket');

      const expectedSecret = await sha256Hex(tokenValue);
      expect(result).toEqual({
        accessKeyId: 'token-id-123',
        secretAccessKey: expectedSecret,
        tokenId: 'token-id-123',
      });
    });

    it('should retry 2x with exponential backoff on 5xx errors', async () => {
      // First two calls fail with 500, third succeeds
      mockFetch
        .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
        .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
        .mockResolvedValueOnce(mockTokenResponse('tok', 'val'));

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
        .mockResolvedValueOnce(mockTokenResponse('tok', 'val'));

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
      mockFetch.mockResolvedValueOnce(mockTokenResponse());

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
    it('should DELETE to CF API /accounts/{id}/tokens/{tokenId} (not /r2/tokens)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await deleteScopedR2Token('account-123', 'api-token', 'token-id-456');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/accounts/account-123/tokens/token-id-456'),
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            Authorization: 'Bearer api-token',
          }),
        }),
      );
      // Must NOT contain /r2/tokens
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('/r2/tokens');
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
      _value: string | null;
    };

    beforeEach(() => {
      mockKV = {
        get: vi.fn(async (_key: string, type?: string) => {
          const val = mockKV._value;
          if (!val) return null;
          if (type === 'json' && typeof val === 'string') {
            try { return JSON.parse(val); } catch { return val; }
          }
          return val;
        }),
        put: vi.fn(),
        delete: vi.fn(),
        _value: null as string | null,
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
      mockKV._value = JSON.stringify(cached);

      const result = await getOrCreateScopedR2Token(
        'user@example.com', 'account-123', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
      );

      expect(mockKV.get).toHaveBeenCalledWith('r2token:user@example.com', 'json');
      expect(result.accessKeyId).toBe('cached-ak');
      expect(result.secretAccessKey).toBe('cached-sk');
      // Should NOT have called fetch (no token creation)
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should create new token if KV returns null, write to KV, return creds', async () => {
      mockKV._value = null;

      // Mock the createScopedR2Token call (via fetch) - new /tokens format
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: { id: 'new-tok', value: 'new-raw-value' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const result = await getOrCreateScopedR2Token(
        'user@example.com', 'account-123', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
      );

      // Should have created a new token
      expect(mockFetch).toHaveBeenCalled();
      // accessKeyId = result.id from the API
      expect(result.accessKeyId).toBe('new-tok');
      // secretAccessKey = SHA-256 hex of result.value
      expect(result.secretAccessKey).toMatch(/^[0-9a-f]{64}$/);

      // Should have written to KV
      expect(mockKV.put).toHaveBeenCalledWith(
        'r2token:user@example.com',
        expect.stringContaining('new-tok'),
      );
    });

    it('should return creds directly (in-memory) without KV read-back', async () => {
      mockKV._value = null;

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: { id: 'new-tok', value: 'new-raw-value' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await getOrCreateScopedR2Token(
        'user@example.com', 'account-123', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
      );

      // KV.get should only be called once (initial check), NOT a second time for read-back
      expect(mockKV.get).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate concurrent getOrCreateScopedR2Token calls for the same email (FIX-7)', async () => {
      mockKV._value = null;

      // Mock token creation - should only be called ONCE despite two concurrent calls
      let createCount = 0;
      mockFetch.mockImplementation(async () => {
        createCount++;
        // Small delay to ensure concurrency
        await new Promise(r => setTimeout(r, 10));
        return new Response(JSON.stringify({
          success: true,
          result: { id: `tok-${createCount}`, value: 'raw-val' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      // Fire two concurrent calls for the same email
      const [result1, result2] = await Promise.all([
        getOrCreateScopedR2Token(
          'concurrent@example.com', 'account-123', 'api-token', 'my-bucket',
          mockKV as unknown as KVNamespace,
        ),
        getOrCreateScopedR2Token(
          'concurrent@example.com', 'account-123', 'api-token', 'my-bucket',
          mockKV as unknown as KVNamespace,
        ),
      ]);

      // Both should get the same token (dedup)
      expect(result1.accessKeyId).toBe(result2.accessKeyId);
      // Token creation should only happen once
      expect(createCount).toBe(1);
    });

    it('should self-heal: forceFresh=true deletes stale KV entry and creates fresh token', async () => {
      const staleToken = {
        accessKeyId: 'stale-ak',
        secretAccessKey: 'stale-sk',
        tokenId: 'stale-tok',
        bucketName: 'my-bucket',
        createdAt: '2024-01-01T00:00:00Z',
        _stale: true,
      };
      mockKV.get.mockResolvedValue(JSON.stringify(staleToken));

      // Mock: create new token after stale detection - new /tokens format
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: { id: 'fresh-tok', value: 'fresh-raw-value' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      // Call with forceFresh=true to simulate stale detection
      const result = await getOrCreateScopedR2Token(
        'user@example.com', 'account-123', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
        null,
        { forceFresh: true },
      );

      // Should have deleted the stale KV entry
      expect(mockKV.delete).toHaveBeenCalledWith('r2token:user@example.com');
      // Should have created a fresh token (accessKeyId = result.id)
      expect(result.accessKeyId).toBe('fresh-tok');
      // Should have written new token to KV
      expect(mockKV.put).toHaveBeenCalledWith(
        'r2token:user@example.com',
        expect.stringContaining('fresh-tok'),
      );
    });
  });
});
