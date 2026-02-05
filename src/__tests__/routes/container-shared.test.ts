import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWithTimeout, getStoredBucketName } from '../../routes/container/shared';
import { createLogger } from '../../lib/logger';

vi.mock('../../lib/circuit-breakers', () => ({
  containerHealthCB: { execute: (fn: () => Promise<unknown>) => fn() },
  containerInternalCB: { execute: (fn: () => Promise<unknown>) => fn() },
  containerSessionsCB: { execute: (fn: () => Promise<unknown>) => fn() },
}));

describe('Container Shared Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchWithTimeout', () => {
    it('returns response when fetch completes before timeout', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      const fetchFn = vi.fn().mockResolvedValue(mockResponse);

      const result = await fetchWithTimeout(fetchFn, 5000);

      expect(result).toBe(mockResponse);
      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('returns null when fetch exceeds timeout', async () => {
      vi.useFakeTimers();
      const fetchFn = vi.fn(() => new Promise<Response>(() => {
        // Never resolves
      }));

      const resultPromise = fetchWithTimeout(fetchFn, 100);
      vi.advanceTimersByTime(200);
      const result = await resultPromise;

      expect(result).toBeNull();
      vi.useRealTimers();
    });

    it('propagates fetch errors', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('network error'));

      await expect(fetchWithTimeout(fetchFn, 5000)).rejects.toThrow('network error');
    });
  });

  describe('getStoredBucketName', () => {
    const logger = createLogger('test');

    it('returns bucket name from container response', async () => {
      const container = {
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ bucketName: 'codeflare-abc123' }), { status: 200 })
        ),
      };

      const result = await getStoredBucketName(container as any, logger);

      expect(result).toBe('codeflare-abc123');
    });

    it('returns null when container returns invalid response', async () => {
      const container = {
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ invalid: 'data' }), { status: 200 })
        ),
      };

      const result = await getStoredBucketName(container as any, logger);

      expect(result).toBeNull();
    });

    it('returns null when container fetch throws', async () => {
      const container = {
        fetch: vi.fn().mockRejectedValue(new Error('not found')),
      };

      const result = await getStoredBucketName(container as any, logger);

      expect(result).toBeNull();
    });

    it('returns null when container fetch throws network error', async () => {
      const container = {
        fetch: vi.fn().mockRejectedValue(new Error('Network connection failed')),
      };

      const result = await getStoredBucketName(container as any, logger);

      expect(result).toBeNull();
    });
  });
});
