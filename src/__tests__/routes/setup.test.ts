import { createMockSetupNamespace } from '../helpers/mock-factories';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import setupRoutes from '../../routes/setup';
import type { Env } from '../../types';
import { AppError, ValidationError, AuthError, SetupError, ForbiddenError } from '../../lib/error-types';
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
      if (err instanceof AppError) {
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
      c.env.CONTAINER = createMockSetupNamespace(c.env);
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

  describe('setup helper admission', () => {
    it.each(['prefill', 'detect-token', 'configure'] as const)(
      'REQ-SETUP-008 AC3: mixed setup requests exhaust the shared limiter before %s', async target => {
        const app = createTestApp({ CLOUDFLARE_API_TOKEN: undefined });
        const request = (endpoint: string) => app.request(`/api/setup/${endpoint}`, endpoint === 'configure'
          ? { method: 'POST', headers: jsonHeaders, body: '{}' }
          : undefined);
        // Each endpoint stays below its independent limit; only the shared five-request bucket expires.
        for (const endpoint of ['prefill', 'detect-token', 'configure', 'prefill', 'detect-token']) {
          expect((await request(endpoint)).status).toBe(endpoint === 'configure' ? 400 : 200);
        }
        const denied = await request(target);
        expect(denied.status).toBe(429);
        expect(await denied.json()).toMatchObject({ code: 'RATE_LIMIT_ERROR' });
        expect(denied.headers.get('X-RateLimit-Remaining')).toBe('0');
        expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
      },
    );

    it.each(['prefill', 'detect-token'] as const)(
      'REQ-SETUP-008 AC4: %s permits bootstrap, then requires authenticated admin', async endpoint => {
        const owners = new Map<string, string>();
        const container = {
          idFromName: (name: string) => name,
          get: (id: string) => ({
            claimBucketOwner: async (email: string, allowInitialClaim: boolean) => {
              const owner = owners.get(id);
              if (owner === email) return 'owned';
              if (owner) return 'conflict';
              if (!allowInitialClaim) return 'ambiguous';
              owners.set(id, email);
              return 'owned';
            },
          }),
        } as unknown as Env['CONTAINER'];
        const app = createTestApp({ CLOUDFLARE_API_TOKEN: undefined, CONTAINER: container });
        expect((await app.request(`/api/setup/${endpoint}`)).status).toBe(200);
        mockKV._store.set('setup:complete', 'true');
        mockKV._set('user:regular@example.com', { role: 'user', addedBy: 'setup', addedAt: '2024-01-01' });
        mockKV._set('user:admin@example.com', { role: 'admin', addedBy: 'setup', addedAt: '2024-01-01' });
        globalThis.fetch = async () => { throw new Error('Helper admission must not contact a provider'); };
        expect((await app.request(`/api/setup/${endpoint}`)).status).toBe(401);
        const regular = await app.request(`/api/setup/${endpoint}`, {
          headers: { 'cf-access-authenticated-user-email': 'regular@example.com' },
        });
        expect(regular.status).toBe(403);
        expect(await regular.json()).toMatchObject({ code: 'FORBIDDEN' });
        const admin = await app.request(`/api/setup/${endpoint}`, {
          headers: { 'cf-access-authenticated-user-email': 'admin@example.com' },
        });
        expect(admin.status).toBe(200);
        expect(await admin.json()).toMatchObject(endpoint === 'prefill'
          ? { adminUsers: [], allowedUsers: [] }
          : { detected: false });
      },
    );
  });

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
          { status: 200, headers: jsonHeaders }
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

    it.each(['{', JSON.stringify({ ...standardBody, allowedUsers: ['not-an-email'] })])(
      'REQ-SEC-009 AC1: invalid setup body %s returns JSON validation before provisioning', async body => {
        const app = createTestApp();
        mockKV._set('user:existing@example.com', { role: 'admin' });
        mockKV._store.set('setup:custom_domain', 'existing.example.com');
        const before = [...mockKV._store.entries()];
        globalThis.fetch = vi.fn(async () => { throw new Error('Provisioning must not start'); }) as typeof fetch;
        const res = await app.request(`${TEST_WORKER_BASE_URL}/api/setup/configure`, {
          method: 'POST', headers: jsonHeaders, body,
        });
        expect(res.status).toBe(400);
        expect(res.headers.get('Content-Type')).toContain('application/json');
        expect(await res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
        for (const [key, value] of before) expect(mockKV._store.get(key)).toBe(value);
        expect(await mockKV.get('setup:configuring')).toBeNull();
        expect(await mockKV.get('setup:complete')).toBeNull();
        expect(await mockKV.get('user:user@example.com')).toBeNull();
      },
    );

    it('REQ-SETUP-011 AC2: failed configure ends with the cumulative attempted-step outcomes', async () => {
      const app = createTestApp();
      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/secrets': () => new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'Secret write refused' }] }), { status: 403, headers: jsonHeaders }),
      });
      const res = await app.request(`${TEST_WORKER_BASE_URL}/api/setup/configure`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify(standardBody),
      });
      expect(res.status).toBe(200);
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      const steps = [
        { step: 'get_account', status: 'success' },
        { step: 'derive_r2_credentials', status: 'success' },
        { step: 'set_secrets', status: 'error', error: expect.any(String) },
      ];
      expect(summary).toEqual({ done: true, success: false, steps, error: expect.any(String) });
      expect(lines.at(-1)).toEqual(summary);
      expect(lines.filter(line => line.done === true)).toEqual([summary]);
      expect(lines.filter(line => line.status !== 'running' && !line.done)).toEqual(steps);
      expect(await mockKV.get('setup:complete')).toBeNull();
    });

    it('REQ-SETUP-004 AC3: failed reconfiguration preserves completion and the existing admin gate', async () => {
      mockKV._store.set('setup:complete', 'true');
      mockKV._store.set('setup:completed_at', '2025-01-01T00:00:00.000Z');
      mockKV._store.set('setup:custom_domain', 'existing.example.com');
      mockKV._set('user:admin@example.com', { role: 'admin', subscriptionTier: 'unlimited' });
      const before = [...mockKV._store.entries()];
      const container = {
        idFromName: (name: string) => name,
        get: () => ({ claimBucketOwner: async () => 'owned' }),
      } as unknown as Env['CONTAINER'];
      const app = createTestApp({ CONTAINER: container });
      globalThis.fetch = createUrlMockFetch({ '/accounts': () => new Response(JSON.stringify({ success: false, result: [] }), { headers: jsonHeaders }) });
      const failed = await app.request(`${TEST_WORKER_BASE_URL}/api/setup/configure`, {
        method: 'POST', headers: { ...jsonHeaders, 'cf-access-authenticated-user-email': 'admin@example.com' },
        body: JSON.stringify(standardBody),
      });
      expect(failed.status).toBe(200);
      expect(getNdjsonSummary(await readNdjson(failed))).toMatchObject({ done: true, success: false });
      // A failed rerun must not turn the completed instance back into public bootstrap.
      const denied = await app.request(`${TEST_WORKER_BASE_URL}/api/setup/configure`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify(standardBody),
      });
      expect(denied.status).toBe(401);
      for (const [key, value] of before) expect(mockKV._store.get(key)).toBe(value);
      expect(await mockKV.get('user:user@example.com')).toBeNull();
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
      // Consume NDJSON to ensure async work completes
      await readNdjson(res);

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

      expect(res.status).toBe(200);
      const lines = await readNdjson(res);
      // Should have a running then error line for get_account
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'get_account', status: 'error' })
      );
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(false);
    });

    it('REQ-SETUP-004 AC2 / REQ-SETUP-002 AC4: retry preserves partial resources and canonical user ownership', async () => {
      const app = createTestApp();
      const secrets = new Map<string, string>();
      let dnsRecord: Record<string, unknown> | null = null;
      let refuseRoute = true;
      const dnsWrites: { method: string; path: string }[] = [];
      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(), ...customDomainFlowMocks(), ...accessAppFlowMocks(),
        '/secrets': (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { name: string; text: string };
          secrets.set(body.name, body.text);
          return new Response('', { status: 200 });
        },
        '~/dns_records': (url, init) => {
          if (!init?.method || init.method === 'GET') return _jsonResponse({ success: true, result: dnsRecord ? [dnsRecord] : [] });
          dnsWrites.push({ method: init.method, path: new URL(url).pathname });
          dnsRecord = { ...JSON.parse(String(init.body)), id: 'dns_retained' };
          return _jsonResponse({ success: true, result: dnsRecord });
        },
        '/workers/routes': () => refuseRoute
          ? _jsonResponse({ success: false, errors: [{ code: 1000, message: 'Route refused' }] }, 403)
          : mockResponses.workerRouteCreate(),
      });
      const request = () => app.request(`${TEST_WORKER_BASE_URL}/api/setup/configure`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify(standardBody),
      });
      const failed = await readNdjson(await request());
      expect(getNdjsonSummary(failed)).toMatchObject({ success: false });
      expect(await mockKV.get('setup:complete')).toBeNull();
      expect(dnsRecord).toMatchObject({ id: 'dns_retained', type: 'CNAME', proxied: true });
      const retainedSecrets = [...secrets];
      expect(retainedSecrets.map(([name]) => name).sort()).toEqual(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
      refuseRoute = false;
      const retried = await readNdjson(await request());
      expect(retried[0]).toEqual({ step: 'get_account', status: 'running' });
      expect(getNdjsonSummary(retried)).toMatchObject({ success: true });
      expect([...secrets]).toEqual(retainedSecrets);
      expect(dnsWrites).toEqual([
        { method: 'POST', path: '/client/v4/zones/zone123/dns_records' },
        { method: 'PUT', path: '/client/v4/zones/zone123/dns_records/dns_retained' },
      ]);
      expect(dnsRecord).toMatchObject({ id: 'dns_retained', content: 'codeflare.test-account.workers.dev', proxied: true });
      expect(await mockKV.get('setup:complete')).toBe('true');
      expect(await mockKV.get('setup:custom_domain')).toBe(standardBody.customDomain);
      expect(await mockKV.get('user:user@example.com', 'json')).toMatchObject({ role: 'admin', addedBy: 'setup' });
      expect(await mockKV.get('setup:user:user@example.com')).toBeNull();
      expect(await mockKV.get('user-prefs:user@example.com')).toBeNull();
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
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);
      // Each step should have running + success lines
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'get_account', status: 'success' })
      );
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'derive_r2_credentials', status: 'success' })
      );
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'set_secrets', status: 'success' })
      );
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'finalize', status: 'success' })
      );
    });

    it('sets only 2 secrets (R2 credentials, not CLOUDFLARE_API_TOKEN or ADMIN_SECRET)', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });
      await readNdjson(res);

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
      await readNdjson(res);

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

    describe('REQ-ENTERPRISE-018 AC1 + REQ-ENTERPRISE-019 AC1: configure server storage flag persistence', () => {
      const flags = [
        { field: 'r2SseDisabled', key: 'setup:r2_sse_disabled', step: 'configure_r2_sse' },
        { field: 'downloadsDisabled', key: 'setup:downloads_disabled', step: 'configure_downloads_disabled' },
      ] as const;

      it.each(flags.flatMap(flag => [
        { ...flag, enabled: true, expected: 'active', previous: 'inactive' },
        { ...flag, enabled: false, expected: 'inactive', previous: 'active' },
      ]))('persists $field=$enabled in enterprise and reports completed progress', async ({ field, key, step, enabled, expected, previous }) => {
        mockKV._store.set(key, previous);
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();
        const res = await app.request(`${TEST_WORKER_BASE_URL}/api/setup/configure`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...standardBody, dynamicRoutes: ['fixture-route'], [field]: enabled }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('application/x-ndjson');
        const lines = await readNdjson(res);
        const summary = getNdjsonSummary(lines);
        // REQ-ENTERPRISE-305 AC1: explicit false retains the configure wire contract.
        expect(Object.keys(summary).sort()).toEqual(['customDomainUrl', 'done', 'steps', 'success', 'workersDevUrl']);
        expect(summary).toMatchObject({ done: true, success: true, workersDevUrl: TEST_WORKER_BASE_URL, customDomainUrl: `https://${standardBody.customDomain}` });
        expect(await mockKV.get(key)).toBe(expected);
        expect(lines).toContainEqual(expect.objectContaining({ step, status: 'running' }));
        expect(lines).toContainEqual(expect.objectContaining({ step, status: 'success' }));
      });

      it.each(flags.flatMap(flag => [
        { ...flag, enabled: true, enterpriseMode: undefined, previous: null },
        { ...flag, enabled: false, enterpriseMode: 'inactive', previous: 'active' },
      ]))('leaves $field unchanged outside enterprise with prior value $previous', async ({ field, key, step, enabled, enterpriseMode, previous }) => {
        if (previous !== null) mockKV._store.set(key, previous);
        const app = createTestApp({ ENTERPRISE_MODE: enterpriseMode });
        mockFullSuccessFlow();
        const res = await app.request(`${TEST_WORKER_BASE_URL}/api/setup/configure`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...standardBody, [field]: enabled }),
        });
        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(getNdjsonSummary(lines).success).toBe(true);
        expect(await mockKV.get(key)).toBe(previous);
        expect(lines.some(line => line.step === step)).toBe(false);
      });

      it.each(flags)('preserves $field when omitted from enterprise configure', async ({ key, step }) => {
        mockKV._store.set(key, 'active');
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();
        const res = await app.request(`${TEST_WORKER_BASE_URL}/api/setup/configure`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...standardBody, dynamicRoutes: ['fixture-route'] }),
        });
        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(getNdjsonSummary(lines).success).toBe(true);
        expect(await mockKV.get(key)).toBe('active');
        expect(lines.some(line => line.step === step)).toBe(false);
      });
    });

    it('stores setup completion in KV', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardBody),
      });
      await readNdjson(res);

      expect(mockKV.put).toHaveBeenCalledWith('setup:complete', 'true');
      expect(mockKV.put).toHaveBeenCalledWith('setup:account_id', 'acc123');
      expect(mockKV.put).toHaveBeenCalledWith('setup:completed_at', expect.any(String));
    });

  });
});
