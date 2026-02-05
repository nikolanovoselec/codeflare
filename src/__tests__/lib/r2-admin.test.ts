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

import { createBucketIfNotExists } from '../../lib/r2-admin';
import { parseCfResponse } from '../../lib/cf-api';

const mockParseCfResponse = parseCfResponse as ReturnType<typeof vi.fn>;
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
});
