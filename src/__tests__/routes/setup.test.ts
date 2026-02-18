import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import setupRoutes from '../../routes/setup';
import type { Env } from '../../types';
import { ValidationError, AuthError, SetupError } from '../../lib/error-types';
import { cfApiCB } from '../../lib/circuit-breakers';
import { createMockKV } from '../helpers/mock-kv';

// URL-based mock fetch factory — routes requests by URL pattern (and optionally method)
// instead of fragile positional mockResolvedValueOnce chaining.
//
// Pattern matching rules:
//   - Default: URL path (before '?') must END WITH the pattern. This prevents broad patterns
//     like '/accounts' from matching sub-resource URLs like '/accounts/acc123/workers/...'.
//   - Prefix '~': Uses includes() against the URL path — matches anywhere in the path.
//     Use this for patterns that need to match both base paths and sub-resource paths
//     (e.g., '~/dns_records' matches both '.../dns_records' and '.../dns_records/record-id').
//   - Contains '?': Uses includes() against the full URL (including query string).
//
// Patterns are sorted by length descending so more specific patterns match first.
function createUrlMockFetch(responses: Record<string, ((url: string, init?: RequestInit) => Response | Promise<Response>)>) {
  const sortedEntries = Object.entries(responses).sort((a, b) => b[0].length - a[0].length);
  return vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const urlPath = urlString.split('?')[0];
    for (const [rawPattern, factory] of sortedEntries) {
      if (rawPattern.includes('?')) {
        // Query-string patterns: includes() against the full URL
        if (urlString.includes(rawPattern)) return Promise.resolve(factory(urlString, init));
      } else if (rawPattern.startsWith('~')) {
        // Prefix '~': includes() against the URL path (for sub-resource matching)
        const pattern = rawPattern.slice(1);
        if (urlPath.includes(pattern)) return Promise.resolve(factory(urlString, init));
      } else {
        // Default: endsWith() against the URL path
        if (urlPath.endsWith(rawPattern)) return Promise.resolve(factory(urlString, init));
      }
    }
    return Promise.reject(new Error(`Unmocked: ${init?.method || 'GET'} ${urlString}`));
  });
}

// Standard mock responses for common Cloudflare API endpoints
const mockResponses = {
  accounts: () => new Response(
    JSON.stringify({ success: true, result: [{ id: 'acc123' }] }),
    { status: 200 }
  ),
  tokenVerify: () => new Response(
    JSON.stringify({ success: true, result: { id: 'r2-key-id', status: 'active' } }),
    { status: 200 }
  ),
  secretPut: () => new Response('', { status: 200 }),
  zoneLookup: () => new Response(
    JSON.stringify({ success: true, result: [{ id: 'zone123' }] }),
    { status: 200 }
  ),
  subdomainLookup: () => new Response(
    JSON.stringify({ success: true, result: { subdomain: 'test-account' } }),
    { status: 200 }
  ),
  dnsRecordLookupEmpty: () => new Response(
    JSON.stringify({ success: true, result: [] }),
    { status: 200 }
  ),
  dnsRecordCreate: () => new Response('', { status: 200 }),
  workerRouteCreate: () => new Response('', { status: 200 }),
  accessAppsLookupEmpty: () => new Response(
    JSON.stringify({ success: true, result: [] }),
    { status: 200 }
  ),
  accessAppCreate: () => new Response(
    JSON.stringify({ success: true, result: { id: 'app123' } }),
    { status: 200 }
  ),
  accessGroupsLookupEmpty: () => new Response(
    JSON.stringify({ success: true, result: [] }),
    { status: 200 }
  ),
  accessGroupCreate: (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}') as { name?: string };
    const idByName: Record<string, string> = {
      [TEST_ADMIN_GROUP_NAME]: 'group-admins-123',
      [TEST_USER_GROUP_NAME]: 'group-users-456',
    };
    return new Response(
      JSON.stringify({
        success: true,
        result: { id: idByName[body.name || ''] || 'group-generic-999', name: body.name || 'group' },
      }),
      { status: 200 }
    );
  },
  accessPolicyCreate: () => new Response('', { status: 200 }),
};

// Standard env token for configure tests
const TEST_TOKEN = 'env-api-token';
const TEST_WORKER_BASE_URL = 'https://codeflare.test.workers.dev';
const TEST_WORKER_NAME = new URL(TEST_WORKER_BASE_URL).hostname.split('.')[0] ?? 'codeflare';
const TEST_ADMIN_GROUP_NAME = `${TEST_WORKER_NAME}-admins`;
const TEST_USER_GROUP_NAME = `${TEST_WORKER_NAME}-users`;

describe('Setup Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
    cfApiCB.reset();
  });

  function createTestApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env }>();

    // Error handler
    app.onError((err, c) => {
      if (err instanceof ValidationError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      if (err instanceof AuthError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      if (err instanceof SetupError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: err.message }, 500);
    });

    // Set up mock env
    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        DEV_MODE: 'false',
        CLOUDFLARE_API_TOKEN: TEST_TOKEN,
        CLOUDFLARE_WORKER_NAME: TEST_WORKER_NAME,
        ...envOverrides,
      } as Env;
      return next();
    });

    app.route('/api/setup', setupRoutes);
    return app;
  }

  // Helper: build URL-based mock fetch for the successful base flow (accounts + R2 creds + 3 secrets)
  function baseFlowMocks(): Record<string, (url: string, init?: RequestInit) => Response> {
    return {
      '/accounts': mockResponses.accounts,
      '/user/tokens/verify': mockResponses.tokenVerify,
      '/secrets': mockResponses.secretPut,
    };
  }

  // Helper: build URL-based mocks for custom domain flow (zone + subdomain + DNS lookup + DNS create + route)
  function customDomainFlowMocks(): Record<string, (url: string, init?: RequestInit) => Response> {
    return {
      '/zones?name=': mockResponses.zoneLookup,
      '/workers/subdomain': mockResponses.subdomainLookup,
      // '~' prefix: includes-match so both .../dns_records and .../dns_records/{id} are handled
      '~/dns_records': (_url: string, init?: RequestInit) => {
        // GET for lookup, POST/PUT for create/update
        if (!init?.method || init.method === 'GET') {
          return mockResponses.dnsRecordLookupEmpty();
        }
        return mockResponses.dnsRecordCreate();
      },
      '/workers/routes': mockResponses.workerRouteCreate,
    };
  }

  // Helper: build URL-based mocks for access app creation flow
  function accessAppFlowMocks(): Record<string, (url: string, init?: RequestInit) => Response> {
    return {
      // '~' prefix: includes-match so both .../access/apps and .../access/apps/{id} are handled
      '~/access/apps': (_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') {
          return mockResponses.accessAppsLookupEmpty();
        }
        return mockResponses.accessAppCreate();
      },
      '~/access/groups': (url: string, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') {
          return mockResponses.accessGroupsLookupEmpty();
        }
        if (init.method === 'POST') {
          return mockResponses.accessGroupCreate(url, init);
        }
        return new Response('', { status: 200 });
      },
      '~/policies': mockResponses.accessPolicyCreate,
    };
  }

  // Helper: install URL-based mock fetch for a complete successful configure flow
  function mockFullSuccessFlow() {
    globalThis.fetch = createUrlMockFetch({
      ...baseFlowMocks(),
      ...customDomainFlowMocks(),
      ...accessAppFlowMocks(),
    });
  }

  // Standard body for configure requests
  const standardBody = {
    customDomain: 'claude.example.com',
    allowedUsers: ['user@example.com'],
    adminUsers: ['user@example.com'],
  };

  describe('GET /api/setup/status', () => {
    it('returns configured: false without tokenDetected when setup is not complete', async () => {
      const app = createTestApp();
      mockKV.get.mockResolvedValue(null);

      const res = await app.request('/api/setup/status');
      expect(res.status).toBe(200);

      const body = await res.json() as { configured: boolean };
      expect(body.configured).toBe(false);
      expect((body as Record<string, unknown>).tokenDetected).toBeUndefined();
    });

    it('returns configured: true without tokenDetected when setup is complete', async () => {
      const app = createTestApp();
      mockKV.get.mockResolvedValue('true');

      const res = await app.request('/api/setup/status');
      expect(res.status).toBe(200);

      const body = await res.json() as { configured: boolean; tokenDetected?: boolean };
      expect(body.configured).toBe(true);
      expect(body.tokenDetected).toBeUndefined();
    });

    it('returns only configured when CLOUDFLARE_API_TOKEN is not set', async () => {
      const app = createTestApp({ CLOUDFLARE_API_TOKEN: '' as unknown as string });
      mockKV.get.mockResolvedValue(null);

      const res = await app.request('/api/setup/status');
      expect(res.status).toBe(200);

      const body = await res.json() as { configured: boolean };
      expect(body.configured).toBe(false);
      expect((body as Record<string, unknown>).tokenDetected).toBeUndefined();
    });

    it('checks setup:complete key in KV', async () => {
      const app = createTestApp();
      await app.request('/api/setup/status');

      expect(mockKV.get).toHaveBeenCalledWith('setup:complete');
    });
  });

  describe('GET /api/setup/prefill', () => {
    it('returns empty prefill when CLOUDFLARE_API_TOKEN is not set', async () => {
      const app = createTestApp({ CLOUDFLARE_API_TOKEN: '' as unknown as string });

      const res = await app.request('/api/setup/prefill');
      expect(res.status).toBe(200);

      const body = await res.json() as { adminUsers: string[]; allowedUsers: string[] };
      expect(body.adminUsers).toEqual([]);
      expect(body.allowedUsers).toEqual([]);
    });

    it('prefills admin/users from Access groups without custom domain', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        '/accounts': mockResponses.accounts,
        '~/access/groups': () => new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                id: 'group-admins-123',
                name: TEST_ADMIN_GROUP_NAME,
                include: [
                  { email: { email: 'Admin@Example.com' } },
                  { email: { email: 'admin@example.com' } },
                ],
              },
              {
                id: 'group-users-456',
                name: TEST_USER_GROUP_NAME,
                include: [{ email: { email: 'member@example.com' } }],
              },
            ],
          }),
          { status: 200 }
        ),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/prefill');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        adminUsers: string[];
        allowedUsers: string[];
      };
      expect((body as Record<string, unknown>).customDomain).toBeUndefined();
      expect(body.adminUsers).toEqual(['admin@example.com']);
      expect(body.allowedUsers).toEqual(['member@example.com']);
    });
  });

  describe('POST /api/setup/configure', () => {
    it('returns 400 when customDomain is missing', async () => {
      const app = createTestApp();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedUsers: ['user@example.com'], adminUsers: ['user@example.com'] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when allowedUsers is missing', async () => {
      const app = createTestApp();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customDomain: 'claude.example.com', adminUsers: ['admin@example.com'] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when allowedUsers is empty array', async () => {
      const app = createTestApp();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customDomain: 'claude.example.com', allowedUsers: [], adminUsers: ['admin@example.com'] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('reads token from env, not from request body', async () => {
      const app = createTestApp({ CLOUDFLARE_API_TOKEN: 'my-env-token' });
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);

      // Verify CF API was called with the env token, not a body token
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts',
        expect.objectContaining({
          headers: { Authorization: 'Bearer my-env-token' },
        })
      );
    });

    it('returns error when get_account step fails', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        '/accounts': () => new Response(
          JSON.stringify({ success: false, result: [] }),
          { status: 200 }
        ),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { success: boolean; steps: Array<{ step: string; status: string }> };
      expect(body.success).toBe(false);
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'get_account', status: 'error' })
      );
    });

    it('progresses through steps correctly on success', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        steps: Array<{ step: string; status: string }>;
      };
      expect(body.success).toBe(true);
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'get_account', status: 'success' })
      );
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'derive_r2_credentials', status: 'success' })
      );
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'set_secrets', status: 'success' })
      );
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'finalize', status: 'success' })
      );
    });

    it('sets only 2 secrets (R2 credentials, not CLOUDFLARE_API_TOKEN or ADMIN_SECRET)', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      // Find all secret-setting calls (PUT to /secrets)
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const secretCalls = mockFetch.mock.calls.filter(
        call => typeof call[0] === 'string' &&
          call[0].includes('/secrets') &&
          (call[1] as RequestInit)?.method === 'PUT'
      );
      expect(secretCalls).toHaveLength(2);

      // Extract secret names
      const secretNames = secretCalls.map(call => {
        const body = JSON.parse((call[1] as RequestInit).body as string);
        return body.name;
      });
      expect(secretNames).toContain('R2_ACCESS_KEY_ID');
      expect(secretNames).toContain('R2_SECRET_ACCESS_KEY');
      expect(secretNames).not.toContain('ADMIN_SECRET');
      expect(secretNames).not.toContain('CLOUDFLARE_API_TOKEN');
    });

    it('stores users in KV as user:{email} entries', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['alice@example.com', 'bob@example.com'],
          adminUsers: ['alice@example.com'],
        }),
      });

      expect(res.status).toBe(200);

      // Verify user entries stored in KV with correct roles
      expect(mockKV.put).toHaveBeenCalledWith(
        'user:alice@example.com',
        expect.stringContaining('"role":"admin"')
      );
      expect(mockKV.put).toHaveBeenCalledWith(
        'user:bob@example.com',
        expect.stringContaining('"role":"user"')
      );
    });

    it('stores setup completion in KV', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(mockKV.put).toHaveBeenCalledWith('setup:complete', 'true');
      expect(mockKV.put).toHaveBeenCalledWith('setup:account_id', 'acc123');
      expect(mockKV.put).toHaveBeenCalledWith('setup:completed_at', expect.any(String));
    });

    it('handles custom domain configuration with DNS and route', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['user@example.com'],
          adminUsers: ['user@example.com'],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        customDomainUrl: string | null;
        steps: Array<{ step: string; status: string }>;
      };
      expect(body.success).toBe(true);
      expect(body.customDomainUrl).toBe('https://claude.example.com');
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'configure_custom_domain', status: 'success' })
      );
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'create_access_app', status: 'success' })
      );

      // Verify DNS record creation was called with correct parameters
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const dnsCall = mockFetch.mock.calls.find(
        call => typeof call[0] === 'string' &&
          call[0].includes('/dns_records') &&
          (call[1] as RequestInit)?.body !== undefined
      );
      expect(dnsCall).toBeDefined();
      const dnsBody = JSON.parse(dnsCall![1]?.body as string);
      expect(dnsBody.type).toBe('CNAME');
      expect(dnsBody.name).toBe('claude');
      expect(dnsBody.content).toBe('codeflare.test-account.workers.dev');
      expect(dnsBody.proxied).toBe(true);
    });

    it('uses Access group includes for access policy', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['alice@example.com', 'bob@example.com'],
          adminUsers: ['alice@example.com'],
        }),
      });

      // Find the access policy creation call
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const policyCall = mockFetch.mock.calls.find(
        call => typeof call[0] === 'string' &&
          call[0].includes('/policies') &&
          (call[1] as RequestInit)?.method === 'POST'
      );
      expect(policyCall).toBeDefined();
      const policyBody = JSON.parse(policyCall![1]?.body as string);
      expect(policyBody.include).toEqual([
        { group: { id: 'group-admins-123' } },
        { group: { id: 'group-users-456' } },
      ]);
    });

    it('returns permission error when zones API returns 403 for custom domain', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': () => new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: 'Authentication error' }],
            result: [],
          }),
          { status: 403 }
        ),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as {
        success: boolean;
        error: string;
        steps: Array<{ step: string; status: string; error?: string }>;
      };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Zone permissions');
      expect(body.steps).toContainEqual(
        expect.objectContaining({
          step: 'configure_custom_domain',
          status: 'error',
          error: expect.stringContaining('Zone permissions'),
        })
      );
    });

    it('returns permission error when zones API returns authentication error message', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': () => new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 9103, message: 'Unknown X-Auth-Key or X-Auth-Email' }],
            result: null,
          }),
          { status: 400 }
        ),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as {
        success: boolean;
        error: string;
        steps: Array<{ step: string; status: string; error?: string }>;
      };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Zone permissions');
    });

    it('returns permission error when worker route creation returns auth error', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.dnsRecordLookupEmpty();
          }
          return mockResponses.dnsRecordCreate();
        },
        '/workers/routes': () => new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: 'Authentication error' }],
          }),
          { status: 403 }
        ),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as {
        success: boolean;
        error: string;
        steps: Array<{ step: string; status: string; error?: string }>;
      };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Zone permissions');
      expect(body.error).toContain('worker route');
    });

    it('returns permission error when DNS record creation returns auth error', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.dnsRecordLookupEmpty();
          }
          // POST/PUT for create/update — return auth error
          return new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 10000, message: 'Authentication error' }],
            }),
            { status: 403 }
          );
        },
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as {
        success: boolean;
        error: string;
        steps: Array<{ step: string; status: string; error?: string }>;
      };
      expect(body.success).toBe(false);
      expect(body.error).toContain('DNS permissions');
    });

    it('continues when DNS record already exists (code 81057)', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.dnsRecordLookupEmpty();
          }
          // POST create — "already exists" error
          return new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 81057, message: 'The record already exists.' }],
            }),
            { status: 400 }
          );
        },
        '/workers/routes': mockResponses.workerRouteCreate,
        ...accessAppFlowMocks(),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        steps: Array<{ step: string; status: string }>;
      };
      expect(body.success).toBe(true);
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'configure_custom_domain', status: 'success' })
      );
    });

    it('updates existing worker route when creation returns already exists', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.dnsRecordLookupEmpty();
          }
          return mockResponses.dnsRecordCreate();
        },
        '~/workers/routes': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ id: 'route-123', pattern: 'claude.example.com/*' }],
              }),
              { status: 200 }
            );
          }
          if (init.method === 'POST') {
            return new Response(
              JSON.stringify({
                success: false,
                errors: [{ code: 10020, message: 'route already exists' }],
              }),
              { status: 409 }
            );
          }
          return new Response('', { status: 200 });
        },
        ...accessAppFlowMocks(),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        steps: Array<{ step: string; status: string }>;
      };
      expect(body.success).toBe(true);
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'configure_custom_domain', status: 'success' })
      );

      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const routeUpdateCall = mockFetch.mock.calls.find(
        call => typeof call[0] === 'string'
          && call[0].includes('/workers/routes/route-123')
          && (call[1] as RequestInit)?.method === 'PUT'
      );
      expect(routeUpdateCall).toBeDefined();
    });

    it('updates legacy /app/* worker route to domain/* when route already exists', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.dnsRecordLookupEmpty();
          }
          return mockResponses.dnsRecordCreate();
        },
        '~/workers/routes': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ id: 'route-legacy-app', pattern: 'claude.example.com/app/*', script: 'codeflare' }],
              }),
              { status: 200 }
            );
          }
          if (init.method === 'POST') {
            return new Response(
              JSON.stringify({
                success: false,
                errors: [{ code: 10020, message: 'route already exists' }],
              }),
              { status: 409 }
            );
          }
          return new Response('', { status: 200 });
        },
        ...accessAppFlowMocks(),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);

      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const routeUpdateCall = mockFetch.mock.calls.find(
        call => typeof call[0] === 'string'
          && call[0].includes('/workers/routes/route-legacy-app')
          && (call[1] as RequestInit)?.method === 'PUT'
      );
      expect(routeUpdateCall).toBeDefined();
      const routeUpdateBody = JSON.parse((routeUpdateCall![1] as RequestInit).body as string) as {
        pattern: string;
        script: string;
      };
      expect(routeUpdateBody.pattern).toBe('claude.example.com/*');
      expect(routeUpdateBody.script).toBe('codeflare');
    });

    it('uses hostname from workers.dev URL when subdomain API fails', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': () => new Response(
          JSON.stringify({ success: false, result: null }),
          { status: 200 }
        ),
        '~/dns_records': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.dnsRecordLookupEmpty();
          }
          return mockResponses.dnsRecordCreate();
        },
        '/workers/routes': mockResponses.workerRouteCreate,
        ...accessAppFlowMocks(),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);

      // Verify DNS record was created with fallback subdomain from hostname
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const dnsCall = mockFetch.mock.calls.find(
        call => typeof call[0] === 'string' &&
          call[0].includes('/dns_records') &&
          (call[1] as RequestInit)?.body !== undefined
      );
      expect(dnsCall).toBeDefined();
      const dnsBody = JSON.parse(dnsCall![1]?.body as string);
      // Should use hostname fallback from the worker request URL.
      expect(dnsBody.content).toBe(new URL(TEST_WORKER_BASE_URL).host);
    });

    it('stores R2 endpoint in KV during configure', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(mockKV.put).toHaveBeenCalledWith(
        'setup:r2_endpoint',
        'https://acc123.r2.cloudflarestorage.com'
      );
    });

    it('falls back to deploying latest version when secrets API returns error 10215', async () => {
      const app = createTestApp();

      // Track whether the deployment fallback has been triggered
      let secretAttempts = 0;
      let deployedVersion = false;

      globalThis.fetch = createUrlMockFetch({
        '/accounts': mockResponses.accounts,
        '/user/tokens/verify': mockResponses.tokenVerify,
        '/secrets': () => {
          secretAttempts++;
          // First secret attempt fails with 10215; after deploy, all succeed
          if (secretAttempts === 1 && !deployedVersion) {
            return new Response(
              JSON.stringify({
                success: false,
                errors: [{ code: 10215, message: 'Secret edit failed. Latest version not deployed.' }]
              }),
              { status: 400 }
            );
          }
          return new Response('', { status: 200 });
        },
        '/versions': () => {
          return new Response(
            JSON.stringify({
              success: true,
              result: { items: [{ id: 'version-abc-123' }] }
            }),
            { status: 200 }
          );
        },
        '/deployments': () => {
          deployedVersion = true;
          return new Response(
            JSON.stringify({ success: true, result: { id: 'deploy-123' } }),
            { status: 200 }
          );
        },
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.dnsRecordLookupEmpty();
          }
          return mockResponses.dnsRecordCreate();
        },
        '/workers/routes': mockResponses.workerRouteCreate,
        '~/access/apps': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.accessAppsLookupEmpty();
          }
          return mockResponses.accessAppCreate();
        },
        '~/access/groups': (url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.accessGroupsLookupEmpty();
          }
          if (init.method === 'POST') {
            return mockResponses.accessGroupCreate(url, init);
          }
          return new Response('', { status: 200 });
        },
        '~/policies': mockResponses.accessPolicyCreate,
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        steps: Array<{ step: string; status: string }>;
      };
      expect(body.success).toBe(true);
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'set_secrets', status: 'success' })
      );

      // Verify the versions list and deployment calls were made
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const fetchCalls = mockFetch.mock.calls.map(call => call[0]);
      expect(fetchCalls).toContainEqual(
        expect.stringContaining('/workers/scripts/codeflare/versions')
      );
      expect(fetchCalls).toContainEqual(
        expect.stringContaining('/workers/scripts/codeflare/deployments')
      );
    });

    it('only deploys latest version once even if multiple secrets fail with 10215', async () => {
      const app = createTestApp();

      let secretAttempts = 0;
      let deployedVersion = false;

      globalThis.fetch = createUrlMockFetch({
        '/accounts': mockResponses.accounts,
        '/user/tokens/verify': mockResponses.tokenVerify,
        '/secrets': () => {
          secretAttempts++;
          // First secret attempt fails with 10215; after deploy, all succeed
          if (secretAttempts === 1 && !deployedVersion) {
            return new Response(
              JSON.stringify({
                success: false,
                errors: [{ code: 10215, message: 'Latest version not deployed.' }]
              }),
              { status: 400 }
            );
          }
          return new Response('', { status: 200 });
        },
        '/versions': () => new Response(
          JSON.stringify({
            success: true,
            result: { items: [{ id: 'version-abc' }] }
          }),
          { status: 200 }
        ),
        '/deployments': () => {
          deployedVersion = true;
          return new Response(
            JSON.stringify({ success: true, result: { id: 'deploy-1' } }),
            { status: 200 }
          );
        },
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.dnsRecordLookupEmpty();
          }
          return mockResponses.dnsRecordCreate();
        },
        '/workers/routes': mockResponses.workerRouteCreate,
        '~/access/apps': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.accessAppsLookupEmpty();
          }
          return mockResponses.accessAppCreate();
        },
        '~/access/groups': (url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.accessGroupsLookupEmpty();
          }
          if (init.method === 'POST') {
            return mockResponses.accessGroupCreate(url, init);
          }
          return new Response('', { status: 200 });
        },
        '~/policies': mockResponses.accessPolicyCreate,
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);

      // Count deployment calls - should be exactly 1
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const deploymentCalls = mockFetch.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('/deployments')
      );
      expect(deploymentCalls).toHaveLength(1);
    });

    it('returns customDomainUrl in configure response', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { customDomainUrl: string };
      expect(body.customDomainUrl).toBe('https://claude.example.com');
    });

    it('updates existing DNS record instead of failing when record exists', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            // DNS record lookup — returns existing CNAME record
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ id: 'dns-record-123', type: 'CNAME' }],
              }),
              { status: 200 }
            );
          }
          // PUT update — success
          return new Response('', { status: 200 });
        },
        '/workers/routes': mockResponses.workerRouteCreate,
        ...accessAppFlowMocks(),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        steps: Array<{ step: string; status: string }>;
      };
      expect(body.success).toBe(true);
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'configure_custom_domain', status: 'success' })
      );

      // Verify DNS record was updated with PUT, not created with POST
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const dnsUpdateCall = mockFetch.mock.calls.find(
        call => typeof call[0] === 'string' &&
          call[0].includes('/dns_records/dns-record-123') &&
          (call[1] as RequestInit)?.method === 'PUT'
      );
      expect(dnsUpdateCall).toBeDefined();
    });

    it('updates existing Access app instead of failing when app exists', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        ...customDomainFlowMocks(),
        // Access app flow: existing app found, update instead of create
        // Use more specific patterns to differentiate policy URLs from app URLs
        '~/access/apps': (url: string, init?: RequestInit) => {
          // Policy-related URLs contain /policies
          if (url.includes('/policies')) {
            if (!init?.method || init.method === 'GET') {
              // Policy lookup — returns existing policy
              return new Response(
                JSON.stringify({
                  success: true,
                  result: [{ id: 'policy-789', name: 'Allow users' }],
                }),
                { status: 200 }
              );
            }
            // PUT update policy — success
            return new Response('', { status: 200 });
          }
          // App-level URLs
          if (!init?.method || init.method === 'GET') {
            // Access app lookup — returns existing app for this domain
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ id: 'existing-app-456', domain: 'claude.example.com/app/*', name: TEST_WORKER_NAME }],
              }),
              { status: 200 }
            );
          }
          // PUT update Access app — success
          return new Response(
            JSON.stringify({ success: true, result: { id: 'existing-app-456' } }),
            { status: 200 }
          );
        },
        '~/access/groups': (url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return new Response(
              JSON.stringify({
                success: true,
                result: [
                  { id: 'group-admins-123', name: TEST_ADMIN_GROUP_NAME },
                  { id: 'group-users-456', name: TEST_USER_GROUP_NAME },
                ],
              }),
              { status: 200 }
            );
          }
          if (init.method === 'POST') {
            return mockResponses.accessGroupCreate(url, init);
          }
          const groupId = url.includes('/group-admins-123') ? 'group-admins-123' : 'group-users-456';
          const groupName = groupId === 'group-admins-123' ? TEST_ADMIN_GROUP_NAME : TEST_USER_GROUP_NAME;
          return new Response(
            JSON.stringify({ success: true, result: { id: groupId, name: groupName } }),
            { status: 200 }
          );
        },
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['user@example.com'],
          adminUsers: ['user@example.com'],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        steps: Array<{ step: string; status: string }>;
      };
      expect(body.success).toBe(true);
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'create_access_app', status: 'success' })
      );

      // Verify Access app was updated with PUT, not created with POST
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const accessAppUpdateCall = mockFetch.mock.calls.find(
        call => typeof call[0] === 'string' &&
          call[0].includes('/access/apps/existing-app-456') &&
          (call[1] as RequestInit)?.method === 'PUT'
      );
      expect(accessAppUpdateCall).toBeDefined();

      // Verify Access policy was updated with PUT
      const policyUpdateCall = mockFetch.mock.calls.find(
        call => typeof call[0] === 'string' &&
          call[0].includes('/policies/policy-789') &&
          (call[1] as RequestInit)?.method === 'PUT'
      );
      expect(policyUpdateCall).toBeDefined();
    });

    it('updates existing managed Access app when custom domain changes', async () => {
      const app = createTestApp();
      // Simulate previously stored app ID so resolveManagedAccessApp finds it by stored ID
      mockKV.get.mockImplementation((key: string) => {
        if (key === 'setup:access_app_id') return Promise.resolve('old-app-999');
        return Promise.resolve(null);
      });

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        ...customDomainFlowMocks(),
        '~/access/apps': (url: string, init?: RequestInit) => {
          if (url.includes('/policies')) {
            if (!init?.method || init.method === 'GET') {
              return new Response(
                JSON.stringify({
                  success: true,
                  result: [{ id: 'policy-321', name: 'Allow users' }],
                }),
                { status: 200 }
              );
            }
            return new Response('', { status: 200 });
          }

          if (!init?.method || init.method === 'GET') {
            // Existing managed app for an old domain
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ id: 'old-app-999', domain: 'old.example.com/app/*', name: TEST_WORKER_NAME }],
              }),
              { status: 200 }
            );
          }

          return new Response(
            JSON.stringify({ success: true, result: { id: 'old-app-999', aud: 'aud-updated' } }),
            { status: 200 }
          );
        },
        '~/access/groups': (url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return new Response(
              JSON.stringify({
                success: true,
                result: [
                  { id: 'group-admins-123', name: TEST_ADMIN_GROUP_NAME },
                  { id: 'group-users-456', name: TEST_USER_GROUP_NAME },
                ],
              }),
              { status: 200 }
            );
          }
          if (init.method === 'POST') {
            return mockResponses.accessGroupCreate(url, init);
          }
          const groupId = url.includes('/group-admins-123') ? 'group-admins-123' : 'group-users-456';
          const groupName = groupId === 'group-admins-123' ? TEST_ADMIN_GROUP_NAME : TEST_USER_GROUP_NAME;
          return new Response(
            JSON.stringify({ success: true, result: { id: groupId, name: groupName } }),
            { status: 200 }
          );
        },
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'new.example.com',
          allowedUsers: ['admin@example.com'],
          adminUsers: ['admin@example.com'],
        }),
      });

      expect(res.status).toBe(200);

      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const updateCall = mockFetch.mock.calls.find(
        (call) => typeof call[0] === 'string'
          && String(call[0]).includes('/access/apps/old-app-999')
          && (call[1] as RequestInit)?.method === 'PUT'
      );
      expect(updateCall).toBeDefined();

      const updateBody = JSON.parse((updateCall![1] as RequestInit).body as string) as {
        domain: string;
        destinations: Array<{ type: string; uri: string }>;
      };
      expect(updateBody.domain).toBe('new.example.com/app/*');
      expect(updateBody.destinations).toEqual([
        { type: 'public', uri: 'new.example.com/app' },
        { type: 'public', uri: 'new.example.com/app/*' },
        { type: 'public', uri: 'new.example.com/api/*' },
        { type: 'public', uri: 'new.example.com/setup' },
        { type: 'public', uri: 'new.example.com/setup/*' },
      ]);

      expect(mockKV.put).toHaveBeenCalledWith('setup:access_app_id', 'old-app-999');
    });

    it('falls back to create when DNS record lookup fails', async () => {
      const app = createTestApp();

      let dnsLookupCalled = false;

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            dnsLookupCalled = true;
            // Return an API error response (not a throw) so circuit breaker doesn't trip
            return new Response(
              JSON.stringify({ success: false, errors: [{ message: 'lookup failed' }] }),
              { status: 500 }
            );
          }
          // POST create — success
          return new Response('', { status: 200 });
        },
        '/workers/routes': mockResponses.workerRouteCreate,
        ...accessAppFlowMocks(),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        steps: Array<{ step: string; status: string }>;
      };
      expect(body.success).toBe(true);

      // Verify DNS record was created with POST (fallback behavior)
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const dnsCreateCall = mockFetch.mock.calls.find(
        call => typeof call[0] === 'string' &&
          call[0].endsWith('/dns_records') &&
          (call[1] as RequestInit)?.method === 'POST'
      );
      expect(dnsCreateCall).toBeDefined();
    });

    it('propagates error when Access app lookup fails', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        ...customDomainFlowMocks(),
        '~/access/apps': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            // Return an error response — listAccessApps now throws on failure
            return new Response(
              JSON.stringify({ success: false, errors: [{ message: 'lookup failed' }] }),
              { status: 500 }
            );
          }
          return new Response(
            JSON.stringify({ success: true, result: { id: 'app123' } }),
            { status: 200 }
          );
        },
        '~/access/groups': (url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.accessGroupsLookupEmpty();
          }
          if (init.method === 'POST') {
            return mockResponses.accessGroupCreate(url, init);
          }
          return new Response('', { status: 200 });
        },
        '~/policies': mockResponses.accessPolicyCreate,
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      // listAccessApps now throws on error instead of silently returning []
      // SetupError returns 400
      expect(res.status).toBe(400);
      const body = await res.json() as {
        error: string;
        steps: Array<{ step: string; status: string }>;
      };
      expect(body.steps).toContainEqual(
        expect.objectContaining({ step: 'create_access_app', status: 'error' })
      );
    });

    it('stores combined allowedOrigins in KV including custom domain and .workers.dev', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['user@example.com'],
          adminUsers: ['user@example.com'],
          allowedOrigins: ['.app.example.com', '.dev.example.com'],
        }),
      });

      // Should contain user-provided origins + custom domain + .workers.dev
      const putCall = mockKV.put.mock.calls.find(
        (call: unknown[]) => call[0] === 'setup:allowed_origins'
      );
      expect(putCall).toBeDefined();
      const storedOrigins = JSON.parse(putCall![1]) as string[];
      expect(storedOrigins).toContain('.app.example.com');
      expect(storedOrigins).toContain('.dev.example.com');
      expect(storedOrigins).toContain('.claude.example.com');
      expect(storedOrigins).toContain('.workers.dev');
    });

    it('stores allowedOrigins with custom domain and .workers.dev even when no user origins provided', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['user@example.com'],
          adminUsers: ['user@example.com'],
        }),
      });

      const putCall = mockKV.put.mock.calls.find(
        (call: unknown[]) => call[0] === 'setup:allowed_origins'
      );
      expect(putCall).toBeDefined();
      const storedOrigins = JSON.parse(putCall![1]) as string[];
      expect(storedOrigins).toContain('.claude.example.com');
      expect(storedOrigins).toContain('.workers.dev');
    });

    it('stores custom domain in KV', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(mockKV.put).toHaveBeenCalledWith('setup:custom_domain', 'claude.example.com');
    });

    it('stores admin users with role admin and regular users with role user', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['admin1@example.com', 'admin2@example.com', 'viewer@example.com'],
          adminUsers: ['admin1@example.com', 'admin2@example.com'],
        }),
      });

      expect(res.status).toBe(200);

      // Admin users should have role: admin
      expect(mockKV.put).toHaveBeenCalledWith(
        'user:admin1@example.com',
        expect.stringContaining('"role":"admin"')
      );
      expect(mockKV.put).toHaveBeenCalledWith(
        'user:admin2@example.com',
        expect.stringContaining('"role":"admin"')
      );
      // Regular users should have role: user
      expect(mockKV.put).toHaveBeenCalledWith(
        'user:viewer@example.com',
        expect.stringContaining('"role":"user"')
      );
    });

    it('accepts adminUsers field in configure body', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['user@example.com'],
          adminUsers: ['user@example.com'],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('stores access_aud in KV when Access app is created', async () => {
      const app = createTestApp();

      // Custom mock that returns aud in the Access app create response
      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        ...customDomainFlowMocks(),
        '~/access/apps': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.accessAppsLookupEmpty();
          }
          return new Response(
            JSON.stringify({ success: true, result: { id: 'app123', aud: 'test-aud-tag-12345' } }),
            { status: 200 }
          );
        },
        '~/access/groups': (url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.accessGroupsLookupEmpty();
          }
          if (init.method === 'POST') {
            return mockResponses.accessGroupCreate(url, init);
          }
          return new Response('', { status: 200 });
        },
        '~/policies': mockResponses.accessPolicyCreate,
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      expect(mockKV.put).toHaveBeenCalledWith('setup:access_aud', 'test-aud-tag-12345');
    });

    it('creates one Access application with exact + wildcard /app and /setup destinations', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);

      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const createCalls = mockFetch.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string'
          && call[0].endsWith('/access/apps')
          && (call[1] as RequestInit)?.method === 'POST'
      );

      expect(createCalls).toHaveLength(1);
      const createBody = JSON.parse((createCalls[0][1] as RequestInit).body as string) as {
        name: string;
        domain: string;
        destinations: Array<{ type: string; uri: string }>;
      };
      expect(createBody.name).toBe(TEST_WORKER_NAME);
      expect(createBody.domain).toBe('claude.example.com/app/*');
      expect(createBody.destinations).toEqual([
        { type: 'public', uri: 'claude.example.com/app' },
        { type: 'public', uri: 'claude.example.com/app/*' },
        { type: 'public', uri: 'claude.example.com/api/*' },
        { type: 'public', uri: 'claude.example.com/setup' },
        { type: 'public', uri: 'claude.example.com/setup/*' },
      ]);
    });

    it('deletes legacy Access applications for root, /api, and /setup', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        ...customDomainFlowMocks(),
        '~/access/apps': (url: string, init?: RequestInit) => {
          if (url.includes('/policies')) {
            if (!init?.method || init.method === 'GET') {
              return new Response(
                JSON.stringify({ success: true, result: [{ id: 'policy-123', name: 'Allow users' }] }),
                { status: 200 }
              );
            }
            return new Response('', { status: 200 });
          }

          if (!init?.method || init.method === 'GET') {
            return new Response(
              JSON.stringify({
                success: true,
                result: [
                  { id: 'legacy-root-1', domain: 'claude.example.com', name: 'Codeflare' },
                  { id: 'legacy-root-2', domain: 'claude.example.com/*', name: 'Codeflare' },
                  { id: 'legacy-api', domain: 'claude.example.com/api/*', name: 'Codeflare API' },
                  { id: 'legacy-setup', domain: 'claude.example.com/setup/*', name: 'Codeflare Setup' },
                  { id: 'app-existing', domain: 'claude.example.com/app/*', name: TEST_WORKER_NAME },
                ],
              }),
              { status: 200 }
            );
          }

          if (init.method === 'DELETE') {
            return new Response('', { status: 200 });
          }

          return new Response(
            JSON.stringify({ success: true, result: { id: 'app-existing', aud: 'aud-app' } }),
            { status: 200 }
          );
        },
        '~/access/groups': (url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            return mockResponses.accessGroupsLookupEmpty();
          }
          if (init.method === 'POST') {
            return mockResponses.accessGroupCreate(url, init);
          }
          return new Response('', { status: 200 });
        },
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);

      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const deleteUrls = mockFetch.mock.calls
        .filter((call) => (call[1] as RequestInit | undefined)?.method === 'DELETE')
        .map((call) => String(call[0]));

      expect(deleteUrls).toContainEqual(expect.stringContaining('/access/apps/legacy-root-1'));
      expect(deleteUrls).toContainEqual(expect.stringContaining('/access/apps/legacy-root-2'));
      expect(deleteUrls).toContainEqual(expect.stringContaining('/access/apps/legacy-api'));
      expect(deleteUrls).toContainEqual(expect.stringContaining('/access/apps/legacy-setup'));
      expect(deleteUrls).not.toContainEqual(expect.stringContaining('/access/apps/app-existing'));

      const appUpdateCall = mockFetch.mock.calls.find(
        (call) => String(call[0]).includes('/access/apps/app-existing')
          && (call[1] as RequestInit | undefined)?.method === 'PUT'
      );
      expect(appUpdateCall).toBeDefined();

      const appUpdateBody = JSON.parse((appUpdateCall![1] as RequestInit).body as string) as {
        destinations: Array<{ type: string; uri: string }>;
      };
      expect(appUpdateBody.destinations).toEqual([
        { type: 'public', uri: 'claude.example.com/app' },
        { type: 'public', uri: 'claude.example.com/app/*' },
        { type: 'public', uri: 'claude.example.com/api/*' },
        { type: 'public', uri: 'claude.example.com/setup' },
        { type: 'public', uri: 'claude.example.com/setup/*' },
      ]);
    });

    it('creates Turnstile widget and stores site key when onboarding landing page is active', async () => {
      const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active' } as Partial<Env>);

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        ...customDomainFlowMocks(),
        ...accessAppFlowMocks(),
        '/challenges/widgets': () => new Response(
          JSON.stringify({
            success: true,
            result: { sitekey: '0x4AAAAA-test-site-key', secret: 'turnstile-secret-key' },
          }),
          { status: 200 }
        ),
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      expect(mockKV.put).toHaveBeenCalledWith('setup:turnstile_site_key', '0x4AAAAA-test-site-key');

      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const createWidgetCall = mockFetch.mock.calls.find(
        (call) => String(call[0]).includes('/challenges/widgets')
          && ((call[1] as RequestInit | undefined)?.method === 'POST')
      );
      expect(createWidgetCall).toBeDefined();
      const createWidgetBody = JSON.parse((createWidgetCall![1] as RequestInit).body as string) as {
        name: string;
      };
      expect(createWidgetBody.name).toBe(TEST_WORKER_NAME);
    });

    it('reuses existing Turnstile widget when create returns duplicate', async () => {
      const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active' } as Partial<Env>);
      let widgetListCount = 0;

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        ...customDomainFlowMocks(),
        ...accessAppFlowMocks(),
        '/challenges/widgets/0x4AAAAA-existing/rotate_secret': () => new Response(
          JSON.stringify({
            success: true,
            result: { secret: 'rotated-secret-key' },
          }),
          { status: 200 }
        ),
        '~/challenges/widgets': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            widgetListCount += 1;
            if (widgetListCount === 1) {
              return new Response(
                JSON.stringify({
                  success: true,
                  result: [],
                }),
                { status: 200 }
              );
            }
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ sitekey: '0x4AAAAA-existing', name: TEST_WORKER_NAME }],
              }),
              { status: 200 }
            );
          }
          if (init.method === 'POST') {
            return new Response(
              JSON.stringify({
                success: false,
                errors: [{ code: 110000, message: 'Widget already exists' }],
              }),
              { status: 409 }
            );
          }
          return new Response(
            JSON.stringify({
              success: true,
              result: { sitekey: '0x4AAAAA-existing' },
            }),
            { status: 200 }
          );
        },
      });

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      expect(mockKV.put).toHaveBeenCalledWith('setup:turnstile_site_key', '0x4AAAAA-existing');
      expect(mockKV.put).toHaveBeenCalledWith('setup:turnstile_secret_key', 'rotated-secret-key');
    });

    it('does not create Turnstile widget when onboarding landing page is inactive', async () => {
      const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'inactive' } as Partial<Env>);
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });

      expect(res.status).toBe(200);
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const turnstileCall = mockFetch.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('/challenges/widgets')
      );
      expect(turnstileCall).toBeUndefined();
    });
  });

  describe('POST /api/setup/reset-for-tests', () => {
    it('returns 401 when DEV_MODE is not true', async () => {
      const app = createTestApp({ DEV_MODE: 'false' });

      const res = await app.request('/api/setup/reset-for-tests', {
        method: 'POST',
      });

      expect(res.status).toBe(401);
    });

    it('clears setup:complete when DEV_MODE is true', async () => {
      const app = createTestApp({ DEV_MODE: 'true' });

      const res = await app.request('/api/setup/reset-for-tests', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
      expect(mockKV.delete).toHaveBeenCalledWith('setup:complete');
    });
  });

  describe('POST /api/setup/restore-for-tests', () => {
    it('returns 401 when DEV_MODE is not true', async () => {
      const app = createTestApp({ DEV_MODE: 'false' });

      const res = await app.request('/api/setup/restore-for-tests', {
        method: 'POST',
      });

      expect(res.status).toBe(401);
    });

    it('restores setup:complete when DEV_MODE is true', async () => {
      const app = createTestApp({ DEV_MODE: 'true' });

      const res = await app.request('/api/setup/restore-for-tests', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
      expect(mockKV.put).toHaveBeenCalledWith('setup:complete', 'true');
    });
  });
});
