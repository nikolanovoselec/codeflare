import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import setupRoutes from '../../routes/setup';
import type { Env } from '../../types';
import { ValidationError, AuthError, SetupError, ForbiddenError } from '../../lib/error-types';
import { cfApiCB } from '../../lib/circuit-breakers';
import { resetAuthConfigCache } from '../../lib/access';
import { createMockKV } from '../helpers/mock-kv';
vi.mock('../../lib/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/access')>();
  return {
    ...actual,
    resolveBucketName: vi.fn(async (_env: unknown, email: string, workerName?: string) => actual.getBucketName(email, workerName)),
  };
});

// REQ-ENTERPRISE-022: per-route context windows persist, validate, and round-trip through setup.
// URL-based mock fetch factory - routes requests by URL pattern (and optionally method)
// instead of fragile positional mockResolvedValueOnce chaining.
//
// Pattern matching rules:
//   - Default: URL path (before '?') must END WITH the pattern. This prevents broad patterns
//     like '/accounts' from matching sub-resource URLs like '/accounts/acc123/workers/...'.
//   - Prefix '~': Uses includes() against the URL path - matches anywhere in the path.
//     Use this for patterns that need to match both base paths and sub-resource paths
//     (e.g., '~/dns_records' matches both '.../dns_records' and '.../dns_records/record-id').
//   - Contains '?': Uses includes() against the full URL (including query string).
//
// Patterns are sorted by length descending so more specific patterns match first.
// Default mock for identity_providers — always present so access setup tests don't break
const defaultIdpMock: Record<string, (url: string, init?: RequestInit) => Response> = {
  '/identity_providers': () => new Response(JSON.stringify({
    success: true, result: [
      { id: 'idp-google', type: 'google', name: 'Google' },
      { id: 'idp-github', type: 'github', name: 'GitHub' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
};

function createUrlMockFetch(responses: Record<string, ((url: string, init?: RequestInit) => Response | Promise<Response>)>) {
  const merged = { ...defaultIdpMock, ...responses };
  const sortedEntries = Object.entries(merged).sort((a, b) => b[0].length - a[0].length);
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

/** Helper: create a JSON Response with correct Content-Type header for CF API mocks. */
function _jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

// Standard mock responses for common Cloudflare API endpoints
const jsonHeaders = { 'Content-Type': 'application/json' };
const mockResponses = {
  accounts: () => new Response(
    JSON.stringify({ success: true, result: [{ id: 'acc123' }] }),
    { status: 200, headers: jsonHeaders }
  ),
  tokenVerify: () => new Response(
    JSON.stringify({ success: true, result: { id: 'r2-key-id', status: 'active' } }),
    { status: 200, headers: jsonHeaders }
  ),
  secretPut: () => new Response('', { status: 200 }),
  zoneLookup: () => new Response(
    JSON.stringify({ success: true, result: [{ id: 'zone123' }] }),
    { status: 200, headers: jsonHeaders }
  ),
  subdomainLookup: () => new Response(
    JSON.stringify({ success: true, result: { subdomain: 'test-account' } }),
    { status: 200, headers: jsonHeaders }
  ),
  dnsRecordLookupEmpty: () => new Response(
    JSON.stringify({ success: true, result: [] }),
    { status: 200, headers: jsonHeaders }
  ),
  dnsRecordCreate: () => new Response('', { status: 200 }),
  workerRouteCreate: () => new Response('', { status: 200 }),
  accessAppsLookupEmpty: () => new Response(
    JSON.stringify({ success: true, result: [] }),
    { status: 200, headers: jsonHeaders }
  ),
  accessAppCreate: () => new Response(
    JSON.stringify({ success: true, result: { id: 'app123' } }),
    { status: 200, headers: jsonHeaders }
  ),
  accessGroupsLookupEmpty: () => new Response(
    JSON.stringify({ success: true, result: [] }),
    { status: 200, headers: jsonHeaders }
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
      { status: 200, headers: jsonHeaders }
    );
  },
  accessPolicyCreate: () => new Response('', { status: 200 }),
};

/**
 * Helper to read an NDJSON response stream and return all parsed lines.
 * The last line with `done: true` is the summary.
 */
async function readNdjson(res: Response): Promise<Record<string, unknown>[]> {
  // Use arrayBuffer + TextDecoder instead of .text() to avoid workerd warning
  // about calling .text() on non-text content-type (application/x-ndjson)
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

/** Extract the final summary line from NDJSON lines (the one with `done: true`). */
function getNdjsonSummary(lines: Record<string, unknown>[]): Record<string, unknown> {
  const summary = lines.find(l => l.done === true);
  if (!summary) throw new Error('No summary line found in NDJSON response');
  return summary;
}

// Standard env token for configure tests
const TEST_TOKEN = 'env-api-token';
const TEST_WORKER_BASE_URL = 'https://codeflare.test.workers.dev';
const TEST_WORKER_NAME = new URL(TEST_WORKER_BASE_URL).hostname.split('.')[0] ?? 'codeflare';
const TEST_ADMIN_GROUP_NAME = `${TEST_WORKER_NAME}-admins`;
const TEST_USER_GROUP_NAME = `${TEST_WORKER_NAME}-users`;

// REQ-AGENT-064: Connect to Cloudflare via OAuth
describe('Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof globalThis.fetch;
  const _TEST_EMAIL = 'test@example.com';

  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
    resetAuthConfigCache();
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
      if (err instanceof ForbiddenError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
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

  describe('POST /api/setup/configure', () => {
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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);
      expect(summary.customDomainUrl).toBe('https://claude.example.com');
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'configure_custom_domain', status: 'success' })
      );
      expect(lines).toContainEqual(
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

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['alice@example.com', 'bob@example.com'],
          adminUsers: ['alice@example.com'],
        }),
      });
      await readNdjson(res);

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

      expect(res.status).toBe(200);
      const lines = await readNdjson(res);
      expect(lines).toContainEqual(
        expect.objectContaining({
          step: 'configure_custom_domain',
          status: 'error',
          error: expect.stringContaining('Zone permissions'),
        })
      );
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(false);
      expect(summary.error).toEqual(expect.stringContaining('Zone permissions'));
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

      expect(res.status).toBe(200);
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(false);
      expect(summary.error).toEqual(expect.stringContaining('Zone permissions'));
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

      expect(res.status).toBe(200);
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(false);
      expect(summary.error).toEqual(expect.stringContaining('Zone permissions'));
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
          // POST/PUT for create/update - return auth error
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

      expect(res.status).toBe(200);
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(false);
      expect(summary.error).toEqual(expect.stringContaining('DNS permissions'));
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
          // POST create - "already exists" error
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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);
      expect(lines).toContainEqual(
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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);
      expect(lines).toContainEqual(
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
      await readNdjson(res);

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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);

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

  });
});
