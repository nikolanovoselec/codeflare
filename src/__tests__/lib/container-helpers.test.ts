import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getContainerId, getSessionIdFromQuery } from '../../lib/container-helpers';
import type { HealthData } from '../../lib/container-helpers';
import { ValidationError } from '../../lib/error-types';
import type { DurableObjectStub } from '@cloudflare/workers-types';

/**
 * Test-local health check options and polling helpers.
 * Formerly exported from container-helpers.ts as @internal test utilities (FIX-38).
 * Moved here to avoid test-only exports in production code.
 */
interface HealthCheckOptions {
  maxAttempts?: number;
  delayMs?: number;
  onProgress?: (attempt: number, maxAttempts: number) => void;
}

async function waitForContainerHealth(
  container: DurableObjectStub,
  options?: HealthCheckOptions
): Promise<{ ok: boolean; data?: HealthData }> {
  const maxAttempts = options?.maxAttempts ?? 30;
  const delayMs = options?.delayMs ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options?.onProgress?.(attempt, maxAttempts);

    try {
      const response = await container.fetch(new Request('http://container/health'));
      if (response.ok) {
        const data = await response.json() as HealthData;
        return { ok: true, data };
      }
    } catch {
      // Expected during polling
    }

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { ok: false };
}

async function ensureBucketName(
  container: DurableObjectStub,
  expectedBucket: string
): Promise<void> {
  const response = await container.fetch(new Request('http://container/bucket-name'));
  if (!response.ok) {
    throw new Error('Failed to get container bucket name');
  }
  const { bucketName: containerBucket } = await response.json() as { bucketName: string };

  if (containerBucket !== expectedBucket) {
    throw new Error(`Bucket mismatch: expected ${expectedBucket}, got ${containerBucket}`);
  }
}

describe('getContainerId', () => {
  it('creates valid container ID from bucket and session', () => {
    expect(getContainerId('mybucket', 'abc12345')).toBe('mybucket-abc12345');
  });

  it('throws on empty sessionId', () => {
    expect(() => getContainerId('bucket', '')).toThrow();
  });

  it('throws on invalid sessionId format', () => {
    expect(() => getContainerId('bucket', 'short')).toThrow(); // too short
    expect(() => getContainerId('bucket', 'UPPERCASE1')).toThrow(); // uppercase
    expect(() => getContainerId('bucket', 'has-dash12')).toThrow(); // special char
  });

  it('accepts valid sessionId formats', () => {
    expect(() => getContainerId('bucket', 'validid1')).not.toThrow();
    expect(() => getContainerId('bucket', 'abcdefgh')).not.toThrow();
    expect(() => getContainerId('bucket', '12345678')).not.toThrow();
  });

  it('throws ValidationError (not generic Error) on invalid input', () => {
    expect(() => getContainerId('bucket', '../etc/passwd')).toThrow(ValidationError);
    expect(() => getContainerId('bucket', '')).toThrow(ValidationError);
  });

  it('error message does not contain attacker input', () => {
    const maliciousInput = '../../etc/passwd';
    try {
      getContainerId('bucket', maliciousInput);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(maliciousInput);
    }
  });
});

describe('getSessionIdFromQuery', () => {
  function createMockContext(query?: string) {
    return {
      req: {
        query: (name: string) => (name === 'sessionId' ? query : undefined),
      },
    } as any;
  }

  it('throws ValidationError for path traversal attempt', () => {
    const c = createMockContext('../../etc/passwd');
    expect(() => getSessionIdFromQuery(c)).toThrow(ValidationError);
  });

  it('throws ValidationError for empty string', () => {
    const c = createMockContext('');
    expect(() => getSessionIdFromQuery(c)).toThrow(ValidationError);
  });

  it('throws ValidationError for string with spaces', () => {
    const c = createMockContext('abc 12345');
    expect(() => getSessionIdFromQuery(c)).toThrow(ValidationError);
  });

  it('throws ValidationError for string with special characters', () => {
    const c = createMockContext('abc!@#$%');
    expect(() => getSessionIdFromQuery(c)).toThrow(ValidationError);
  });

  it('throws ValidationError when sessionId is missing entirely', () => {
    const c = createMockContext(undefined);
    expect(() => getSessionIdFromQuery(c)).toThrow(ValidationError);
  });

  it('returns valid sessionId from query parameter', () => {
    const c = createMockContext('abc12345');
    expect(getSessionIdFromQuery(c)).toBe('abc12345');
  });
});

describe('waitForContainerHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ok:true with data when health check succeeds on first attempt', async () => {
    const healthData: HealthData = { status: 'healthy', cpu: '10%', mem: '1.5/3.0G', hdd: '2.0/10.0G' };
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(healthData), { status: 200 })
      ),
    };

    const result = await waitForContainerHealth(mockContainer as any);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(healthData);
    expect(mockContainer.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on non-200 response and succeeds eventually', async () => {
    const healthData: HealthData = { status: 'healthy' };
    const mockContainer = {
      fetch: vi.fn()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValue(new Response(JSON.stringify(healthData), { status: 200 })),
    };

    const options: HealthCheckOptions = { maxAttempts: 5, delayMs: 100 };
    const resultPromise = waitForContainerHealth(mockContainer as any, options);

    // Advance through the delays
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(healthData);
    expect(mockContainer.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries on fetch error and succeeds eventually', async () => {
    const healthData: HealthData = { status: 'healthy' };
    const mockContainer = {
      fetch: vi.fn()
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValue(new Response(JSON.stringify(healthData), { status: 200 })),
    };

    const options: HealthCheckOptions = { maxAttempts: 3, delayMs: 50 };
    const resultPromise = waitForContainerHealth(mockContainer as any, options);

    await vi.advanceTimersByTimeAsync(50);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(mockContainer.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns ok:false when all attempts fail', async () => {
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(new Response('', { status: 503 })),
    };

    const options: HealthCheckOptions = { maxAttempts: 3, delayMs: 50 };
    const resultPromise = waitForContainerHealth(mockContainer as any, options);

    // Advance through all delays
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(mockContainer.fetch).toHaveBeenCalledTimes(3);
  });

  it('calls onProgress callback with correct attempt numbers', async () => {
    const mockContainer = {
      fetch: vi.fn()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    };

    const onProgress = vi.fn();
    const options: HealthCheckOptions = { maxAttempts: 5, delayMs: 50, onProgress };
    const resultPromise = waitForContainerHealth(mockContainer as any, options);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    await resultPromise;

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 5);
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 5);
    expect(onProgress).toHaveBeenNthCalledWith(3, 3, 5);
  });

  it('uses default values from constants when options not provided', async () => {
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      ),
    };

    await waitForContainerHealth(mockContainer as any);

    // Should use default URL
    expect(mockContainer.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://container/health',
      })
    );
  });
});

describe('ensureBucketName', () => {
  it('resolves when bucket names match', async () => {
    const expectedBucket = 'my-bucket';
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ bucketName: expectedBucket }), { status: 200 })
      ),
    };

    await expect(ensureBucketName(mockContainer as any, expectedBucket)).resolves.toBeUndefined();
    expect(mockContainer.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws when bucket names do not match', async () => {
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ bucketName: 'wrong-bucket' }), { status: 200 })
      ),
    };

    await expect(ensureBucketName(mockContainer as any, 'expected-bucket'))
      .rejects.toThrow('Bucket mismatch: expected expected-bucket, got wrong-bucket');
  });

  it('throws when fetch returns non-200 status', async () => {
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(new Response('', { status: 500 })),
    };

    await expect(ensureBucketName(mockContainer as any, 'my-bucket'))
      .rejects.toThrow('Failed to get container bucket name');
  });

  it('uses correct endpoint URL', async () => {
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ bucketName: 'bucket' }), { status: 200 })
      ),
    };

    await ensureBucketName(mockContainer as any, 'bucket');

    expect(mockContainer.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://container/bucket-name',
      })
    );
  });
});
