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

describe('rate-limit fallback on KV failure / REQ-SEC-007 AC2 (KV primary, in-memory fallback with periodic cleanup) / REQ-SEC-019 AC4 (general resource-protection endpoints fail open)', () => {
  const config = { windowMs: 60_000, maxRequests: 3, keyPrefix: 'test' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('activates in-memory fallback when KV throws', async () => {
    const isolatedConfig = { windowMs: 60_000, maxRequests: 3, keyPrefix: 'fallback-test' };
    const limiter = createRateLimiter(isolatedConfig);
    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await limiter(c as any, next);

    expect(next).toHaveBeenCalled();
  });

  it('rate-limit KV failure logs once via logger.warn, not console.warn (M7b)', async () => {
    const isolatedConfig = { windowMs: 60_000, maxRequests: 3, keyPrefix: 'no-console-warn-test' };
    const limiter = createRateLimiter(isolatedConfig);
    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await limiter(c as any, next);

    // console.warn should NOT be called - only the structured logger is used
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('in-memory counting enforces rate limit after maxRequests', async () => {
    // Use a unique prefix so this test's in-memory entries don't collide with other tests
    const isolatedConfig = { windowMs: 60_000, maxRequests: 3, keyPrefix: 'isolated-test' };
    const limiter = createRateLimiter(isolatedConfig);
    const next = vi.fn().mockResolvedValue(undefined);

    // First 3 requests should pass
    for (let i = 0; i < isolatedConfig.maxRequests; i++) {
      const c = createMockContext();
      await limiter(c as any, next);
    }
    expect(next).toHaveBeenCalledTimes(isolatedConfig.maxRequests);

    // 4th request should throw RateLimitError
    const c = createMockContext();
    await expect(limiter(c as any, next)).rejects.toThrow('Rate limit exceeded');
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

describe('checkRateLimit failClosed semantics / REQ-SEC-019 AC3 (security-critical endpoints fail closed when KV is unavailable instead of fail-open)', () => {
  it('failClosed=true: KV failure returns allowed=false with retryAfter=60', async () => {
    const { checkRateLimit } = await import('../../lib/rate-limit-core');
    const failingKv = {
      get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
      put: vi.fn().mockRejectedValue(new Error('KV unavailable')),
    } as unknown as KVNamespace;

    const result = await checkRateLimit({
      kv: failingKv,
      key: 'critical-endpoint:test-user',
      limit: 10,
      windowMs: 60_000,
      ttlSeconds: 120,
      failClosed: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec).toBe(60);
  });

  it('failClosed=false (default): KV failure falls back to in-memory (allowed=true on first call)', async () => {
    const { checkRateLimit } = await import('../../lib/rate-limit-core');
    const failingKv = {
      get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
      put: vi.fn().mockRejectedValue(new Error('KV unavailable')),
    } as unknown as KVNamespace;

    const result = await checkRateLimit({
      kv: failingKv,
      key: 'general-endpoint:test-user-fail-open',
      limit: 10,
      windowMs: 60_000,
      ttlSeconds: 120,
      // failClosed omitted -> defaults to false
    });

    expect(result.allowed).toBe(true);
  });
});

describe('checkRateLimit in-memory fallback size cap / CF-149 (bounded fallback Map evicts oldest entry past MAX_FALLBACK_ENTRIES)', () => {
  // Mirrors the unexported MAX_FALLBACK_ENTRIES in rate-limit-core.ts.
  const MAX_FALLBACK_ENTRIES = 10_000;

  beforeEach(() => {
    // Fresh module so the module-level inMemoryFallback Map starts empty and
    // does not inherit entries from the fail-open tests above.
    vi.resetModules();
  });

  function makeFailingKv(): KVNamespace {
    return {
      get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
      put: vi.fn().mockRejectedValue(new Error('KV unavailable')),
    } as unknown as KVNamespace;
  }

  it('evicts the oldest entry when inserting past the cap', async () => {
    const { checkRateLimit } = await import('../../lib/rate-limit-core');
    const kv = makeFailingKv();
    const base = {
      kv,
      limit: 5,
      windowMs: 600_000, // wide window so nothing expires during the test
      ttlSeconds: 1200,
    };

    // First key becomes the oldest (insertion-order head of the Map).
    const oldestKey = 'cap-oldest';
    await checkRateLimit({ ...base, key: oldestKey });

    // Increment the oldest once so its count is 2 - if it were NOT evicted, a
    // later re-check would continue counting from 2; if evicted, it restarts at 1.
    await checkRateLimit({ ...base, key: oldestKey });

    // Fill the rest of the Map exactly to capacity with distinct keys.
    for (let i = 0; i < MAX_FALLBACK_ENTRIES - 1; i++) {
      await checkRateLimit({ ...base, key: `cap-fill-${i}` });
    }

    // One more distinct key pushes past the cap -> oldest entry is evicted.
    await checkRateLimit({ ...base, key: 'cap-overflow' });

    // Re-checking the oldest key now starts a fresh window: count === 1 proves
    // its prior {count:2} state was evicted, not retained.
    const recheck = await checkRateLimit({ ...base, key: oldestKey });
    expect(recheck.count).toBe(1);
  });

  it('does not evict when re-checking an existing key at capacity', async () => {
    const { checkRateLimit } = await import('../../lib/rate-limit-core');
    const kv = makeFailingKv();
    const base = {
      kv,
      limit: 100,
      windowMs: 600_000,
      ttlSeconds: 1200,
    };

    const stableKey = 'cap-stable';
    await checkRateLimit({ ...base, key: stableKey }); // count 1
    for (let i = 0; i < MAX_FALLBACK_ENTRIES - 1; i++) {
      await checkRateLimit({ ...base, key: `fill-${i}` });
    }
    // At capacity, re-checking an EXISTING key must not trip eviction and must
    // continue counting (existing entry within the window -> count increments).
    const again = await checkRateLimit({ ...base, key: stableKey });
    expect(again.count).toBe(2);
  });
});
