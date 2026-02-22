import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getWorkerNameFromHostname, detectCloudflareAuthError, withSetupRetry } from '../../routes/setup/shared';
import { CircuitBreakerOpenError } from '../../lib/error-types';
import { handleConfigureCustomDomain } from '../../routes/setup/custom-domain';
import type { SetupStep } from '../../routes/setup/shared';

describe('getWorkerNameFromHostname()', () => {
  it('extracts first segment from workers.dev hostname', () => {
    const result = getWorkerNameFromHostname('https://codeflare.nikola-novoselec.workers.dev/api/setup');
    expect(result).toBe('codeflare');
  });

  it('extracts first segment from different workers.dev subdomain', () => {
    const result = getWorkerNameFromHostname('https://my-app.test-account.workers.dev');
    expect(result).toBe('my-app');
  });

  it('returns codeflare for custom domain', () => {
    const result = getWorkerNameFromHostname('https://claude.example.com/api/setup');
    expect(result).toBe('codeflare');
  });

  it('returns codeflare for localhost', () => {
    const result = getWorkerNameFromHostname('http://localhost:8787');
    expect(result).toBe('codeflare');
  });

  it('handles workers.dev with no path', () => {
    const result = getWorkerNameFromHostname('https://test-worker.someone.workers.dev');
    expect(result).toBe('test-worker');
  });
});

describe('detectCloudflareAuthError()', () => {
  it('detects 401 status as auth error', () => {
    const result = detectCloudflareAuthError(401, [{ code: 1000, message: 'Unauthorized' }]);
    expect(result).toContain('Authentication/permission error');
    expect(result).toContain('HTTP 401');
  });

  it('detects 403 status as auth error', () => {
    const result = detectCloudflareAuthError(403, [{ code: 1000, message: 'Forbidden' }]);
    expect(result).toContain('HTTP 403');
  });

  it('detects error code 9103 as auth error', () => {
    const result = detectCloudflareAuthError(200, [{ code: 9103, message: 'Authentication error' }]);
    expect(result).not.toBeNull();
  });

  it('detects error code 10000 as auth error', () => {
    const result = detectCloudflareAuthError(200, [{ code: 10000, message: 'Error' }]);
    expect(result).not.toBeNull();
  });

  it('detects permission message as auth error', () => {
    const result = detectCloudflareAuthError(200, [{ message: 'Insufficient permission' }]);
    expect(result).not.toBeNull();
  });

  it('returns null for non-auth errors', () => {
    const result = detectCloudflareAuthError(200, [{ code: 5000, message: 'Server error' }]);
    expect(result).toBeNull();
  });

  it('returns null for empty errors array', () => {
    const result = detectCloudflareAuthError(200, []);
    expect(result).toBeNull();
  });
});

describe('resolveZone() via handleConfigureCustomDomain (ccTLD support)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Helper: create a mock fetch that records zone lookups and returns zone for expected domain
  function createZoneMockFetch(expectedZoneDomain: string) {
    return vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      // Zone lookup
      if (urlStr.includes('/zones?name=')) {
        const zoneName = new URL(urlStr).searchParams.get('name');
        if (zoneName === expectedZoneDomain) {
          return Promise.resolve(new Response(
            JSON.stringify({ success: true, result: [{ id: 'zone-found' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        // Not the right zone - return empty result
        return Promise.resolve(new Response(
          JSON.stringify({ success: true, result: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ));
      }

      // Workers subdomain lookup
      if (urlStr.includes('/workers/subdomain')) {
        return Promise.resolve(new Response(
          JSON.stringify({ success: true, result: { subdomain: 'test-account' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ));
      }

      // DNS record lookup (GET)
      if (urlStr.includes('/dns_records') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(new Response(
          JSON.stringify({ success: true, result: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ));
      }

      // DNS record create/update (POST/PUT)
      if (urlStr.includes('/dns_records')) {
        return Promise.resolve(new Response('', { status: 200 }));
      }

      // Worker routes
      if (urlStr.includes('/workers/routes')) {
        return Promise.resolve(new Response('', { status: 200 }));
      }

      return Promise.reject(new Error(`Unmocked: ${init?.method || 'GET'} ${urlStr}`));
    });
  }

  it('resolves zone for standard subdomain (claude.example.com -> example.com)', async () => {
    const mockFetch = createZoneMockFetch('example.com');
    globalThis.fetch = mockFetch;

    const steps: SetupStep[] = [];
    const zoneId = await handleConfigureCustomDomain(
      'test-token',
      'acc123',
      'claude.example.com',
      'https://codeflare.test-account.workers.dev/api/setup/configure',
      steps
    );

    expect(zoneId).toBe('zone-found');
    // Should have tried 'claude.example.com' first (no match), then 'example.com' (match)
    const zoneCalls = mockFetch.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/zones?name=')
    );
    expect(zoneCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves zone for ccTLD domain (claude.example.co.uk -> example.co.uk)', async () => {
    const mockFetch = createZoneMockFetch('example.co.uk');
    globalThis.fetch = mockFetch;

    const steps: SetupStep[] = [];
    const zoneId = await handleConfigureCustomDomain(
      'test-token',
      'acc123',
      'claude.example.co.uk',
      'https://codeflare.test-account.workers.dev/api/setup/configure',
      steps
    );

    expect(zoneId).toBe('zone-found');
  });

  it('resolves zone when domain IS the zone (example.com -> example.com)', async () => {
    const mockFetch = createZoneMockFetch('example.com');
    globalThis.fetch = mockFetch;

    const steps: SetupStep[] = [];
    const zoneId = await handleConfigureCustomDomain(
      'test-token',
      'acc123',
      'example.com',
      'https://codeflare.test-account.workers.dev/api/setup/configure',
      steps
    );

    expect(zoneId).toBe('zone-found');
  });
});

describe('withSetupRetry()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withSetupRetry(fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds on second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');

    const promise = withSetupRetry(fn, 'test');
    // Advance past the 1s backoff
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all retries (3 total attempts)', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error('persistent')));

    await expect(withSetupRetry(fn, 'test')).rejects.toThrow('persistent');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on CircuitBreakerOpenError', async () => {
    const fn = vi.fn().mockRejectedValue(new CircuitBreakerOpenError('cf-api'));

    await expect(withSetupRetry(fn, 'test')).rejects.toThrow(CircuitBreakerOpenError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
