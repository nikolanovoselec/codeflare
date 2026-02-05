import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRateLimiter } from '../../middleware/rate-limit';
import type { Env } from '../../types';

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

function createMockContext(kvOverride?: Partial<KVNamespace>) {
  const kv = {
    get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
    put: vi.fn().mockRejectedValue(new Error('KV unavailable')),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
    ...kvOverride,
  };

  const headers = new Map<string, string>();
  const c = {
    env: { KV: kv } as unknown as Env,
    req: {
      header: vi.fn((name: string) => {
        if (name === 'CF-Connecting-IP') return '1.2.3.4';
        return undefined;
      }),
    },
    get: vi.fn((key: string) => {
      if (key === 'bucketName') return 'test-bucket';
      return undefined;
    }),
    header: vi.fn((key: string, value: string) => headers.set(key, value)),
    _headers: headers,
  };

  return c;
}

describe('rate-limit fallback on KV failure', () => {
  const config = { windowMs: 60_000, maxRequests: 3, keyPrefix: 'test' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('activates in-memory fallback when KV throws', async () => {
    const isolatedConfig = { windowMs: 60_000, maxRequests: 3, keyPrefix: 'fallback-test' };
    const limiter = createRateLimiter(isolatedConfig);
    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await limiter(c as any, next);

    expect(next).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('KV failed'),
      expect.any(String),
    );
    consoleSpy.mockRestore();
  });

  it('in-memory counting enforces rate limit after maxRequests', async () => {
    // Use a unique prefix so this test's in-memory entries don't collide with other tests
    const isolatedConfig = { windowMs: 60_000, maxRequests: 3, keyPrefix: 'isolated-test' };
    const limiter = createRateLimiter(isolatedConfig);
    const next = vi.fn().mockResolvedValue(undefined);
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First 3 requests should pass
    for (let i = 0; i < isolatedConfig.maxRequests; i++) {
      const c = createMockContext();
      await limiter(c as any, next);
    }
    expect(next).toHaveBeenCalledTimes(isolatedConfig.maxRequests);

    // 4th request should throw RateLimitError
    const c = createMockContext();
    await expect(limiter(c as any, next)).rejects.toThrow('Rate limit exceeded');

    consoleSpy.mockRestore();
  });

  it('skips rate limiting when KV is not available at all', async () => {
    const limiter = createRateLimiter(config);
    const c = createMockContext();
    // Set KV to undefined
    (c.env as any).KV = undefined;
    const next = vi.fn().mockResolvedValue(undefined);

    await limiter(c as any, next);
    expect(next).toHaveBeenCalled();
  });
});
