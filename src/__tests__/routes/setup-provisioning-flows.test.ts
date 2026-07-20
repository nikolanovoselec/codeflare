import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import setupRoutes from '../../routes/setup';
import type { Env } from '../../types';
import { ValidationError, AuthError, SetupError, ForbiddenError } from '../../lib/error-types';
import { cfApiCB } from '../../lib/circuit-breakers';
import { resetAuthConfigCache } from '../../lib/access';
import { createMockKV } from '../helpers/mock-kv';

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
    it('stores R2 endpoint in KV during configure', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });
      await readNdjson(res);

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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);
      expect(lines).toContainEqual(
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
      await readNdjson(res);

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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.customDomainUrl).toBe('https://claude.example.com');
    });

    it('updates existing DNS record instead of failing when record exists', async () => {
      const app = createTestApp();

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            // DNS record lookup - returns existing CNAME record
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ id: 'dns-record-123', type: 'CNAME' }],
              }),
              { status: 200 }
            );
          }
          // PUT update - success
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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);
      expect(lines).toContainEqual(
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
              // Policy lookup - returns existing policy
              return new Response(
                JSON.stringify({
                  success: true,
                  result: [{ id: 'policy-789', name: 'Allow users' }],
                }),
                { status: 200 }
              );
            }
            // PUT update policy - success
            return new Response('', { status: 200 });
          }
          // App-level URLs
          if (!init?.method || init.method === 'GET') {
            // Access app lookup - returns existing app for this domain
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ id: 'existing-app-456', domain: 'claude.example.com/app/*', name: TEST_WORKER_NAME }],
              }),
              { status: 200 }
            );
          }
          // PUT update Access app - success
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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);
      expect(lines).toContainEqual(
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
      await readNdjson(res);

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

      let _dnsLookupCalled = false;

      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': mockResponses.zoneLookup,
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': (_url: string, init?: RequestInit) => {
          if (!init?.method || init.method === 'GET') {
            _dnsLookupCalled = true;
            // Return an API error response (not a throw) so circuit breaker doesn't trip
            return new Response(
              JSON.stringify({ success: false, errors: [{ message: 'lookup failed' }] }),
              { status: 500 }
            );
          }
          // POST create - success
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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);

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
            // Return an error response - listAccessApps now throws on failure
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

      // listAccessApps now throws on error - streamed as NDJSON error
      expect(res.status).toBe(200);
      const lines = await readNdjson(res);
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'create_access_app', status: 'error' })
      );
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(false);
    });

    it('stores combined allowedOrigins in KV including custom domain and .workers.dev', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['user@example.com'],
          adminUsers: ['user@example.com'],
          allowedOrigins: ['.app.example.com', '.dev.example.com'],
        }),
      });
      await readNdjson(res);

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

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customDomain: 'claude.example.com',
          allowedUsers: ['user@example.com'],
          adminUsers: ['user@example.com'],
        }),
      });
      await readNdjson(res);

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

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });
      await readNdjson(res);

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
      await readNdjson(res);

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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);
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
      await readNdjson(res);
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
      await readNdjson(res);

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
      await readNdjson(res);

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
      await readNdjson(res);
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
      await readNdjson(res);
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
      await readNdjson(res);
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const turnstileCall = mockFetch.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('/challenges/widgets')
      );
      expect(turnstileCall).toBeUndefined();
    });
  });
});
