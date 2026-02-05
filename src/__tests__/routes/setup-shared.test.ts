import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getWorkerNameFromHostname, detectCloudflareAuthError } from '../../routes/setup/shared';
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
            { status: 200 }
          ));
        }
        // Not the right zone - return empty result
        return Promise.resolve(new Response(
          JSON.stringify({ success: true, result: [] }),
          { status: 200 }
        ));
      }

      // Workers subdomain lookup
      if (urlStr.includes('/workers/subdomain')) {
        return Promise.resolve(new Response(
          JSON.stringify({ success: true, result: { subdomain: 'test-account' } }),
          { status: 200 }
        ));
      }

      // DNS record lookup (GET)
      if (urlStr.includes('/dns_records') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(new Response(
          JSON.stringify({ success: true, result: [] }),
          { status: 200 }
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
