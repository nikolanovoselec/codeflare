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

import { createBucketIfNotExists, deriveR2Credentials, getOrCreateR2Credentials } from '../../lib/r2-admin';
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
  // deriveR2Credentials
  // =========================================================================
  describe('deriveR2Credentials', () => {
    function mockVerifyResponse(id = 'token-id-123', status = 'active') {
      return new Response(JSON.stringify({
        success: true,
        result: { id, status },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    async function sha256Hex(input: string): Promise<string> {
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(input));
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    it('should call /user/tokens/verify to get token ID', async () => {
      mockFetch.mockResolvedValueOnce(mockVerifyResponse());

      await deriveR2Credentials('my-api-token');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/user/tokens/verify'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-api-token',
          }),
        }),
      );
    });

    it('should return accessKeyId=tokenId, secretAccessKey=SHA-256(apiToken)', async () => {
      const apiToken = 'my-api-token-value';
      mockFetch.mockResolvedValueOnce(mockVerifyResponse('tok-id-abc'));

      const result = await deriveR2Credentials(apiToken);

      const expectedSecret = await sha256Hex(apiToken);
      expect(result).toEqual({
        accessKeyId: 'tok-id-abc',
        secretAccessKey: expectedSecret,
      });
    });

    it('should throw on non-OK verify response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

      await expect(deriveR2Credentials('bad-token')).rejects.toThrow(/verify API token/);
    });

    it('should throw when verify returns no token ID', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        result: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      await expect(deriveR2Credentials('api-token')).rejects.toThrow(/verification failed/);
    });

    it('should use circuit breaker wrapping (r2AdminCB)', async () => {
      mockFetch.mockResolvedValueOnce(mockVerifyResponse());

      await deriveR2Credentials('api-token');

      expect(mockR2AdminCB.execute).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getOrCreateR2Credentials
  // =========================================================================
  describe('getOrCreateR2Credentials', () => {
    let mockKV: {
      get: ReturnType<typeof vi.fn>;
      put: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockKV = {
        get: vi.fn(),
        put: vi.fn(),
      };
    });

    it('should return cached credentials from KV if exists', async () => {
      const cached = {
        accessKeyId: 'cached-ak',
        secretAccessKey: 'cached-sk',
        bucketName: 'my-bucket',
        createdAt: '2024-01-01T00:00:00Z',
      };
      mockKV.get.mockResolvedValue(JSON.stringify(cached));

      const result = await getOrCreateR2Credentials(
        'user@example.com', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
      );

      expect(mockKV.get).toHaveBeenCalledWith('r2token:user@example.com');
      expect(result.accessKeyId).toBe('cached-ak');
      expect(result.secretAccessKey).toBe('cached-sk');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should derive and cache credentials if KV returns null', async () => {
      mockKV.get.mockResolvedValue(null);
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        result: { id: 'derived-id', status: 'active' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const result = await getOrCreateR2Credentials(
        'user@example.com', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
      );

      expect(mockFetch).toHaveBeenCalled();
      expect(result.accessKeyId).toBe('derived-id');
      expect(result.secretAccessKey).toMatch(/^[0-9a-f]{64}$/);
      expect(mockKV.put).toHaveBeenCalledWith(
        'r2token:user@example.com',
        expect.stringContaining('derived-id'),
      );
    });

    it('should only call KV.get once (no read-back after put)', async () => {
      mockKV.get.mockResolvedValue(null);
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        result: { id: 'tok', status: 'active' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      await getOrCreateR2Credentials(
        'user@example.com', 'api-token', 'my-bucket',
        mockKV as unknown as KVNamespace,
      );

      expect(mockKV.get).toHaveBeenCalledTimes(1);
    });
  });
});
