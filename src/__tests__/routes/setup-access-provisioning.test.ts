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

    // REQ-SETUP-003: session-OIDC mode (SaaS OR onboarding) + OAUTH_CLIENT_ID skips
    // CF Access provisioning; the Worker handles auth via its own GitHub-OIDC session
    // cookie. A stray Access app on a session-OIDC domain 302s the credential-less
    // vault service-worker registration (REQ-VAULT-017). Gate: isSessionOidcMode.
    describe('REQ-SETUP-003: CF Access provisioning gated by isSessionOidcMode + OAUTH_CLIENT_ID', () => {
      // A configure mock fetch whose Access handlers RECORD every call but never
      // perform real provisioning — so the assertions read the recorded calls.
      // accessAppFlowMocks() are included so the flow *could* provision if the gate
      // were gutted (the test then fails), making this gut-checkable.
      function isAccessProvisionCall(call: unknown[]): boolean {
        const url = typeof call[0] === 'string' ? call[0] : '';
        const method = (call[1] as RequestInit | undefined)?.method;
        const isWrite = method === 'POST' || method === 'PUT';
        return isWrite && (url.includes('/access/apps') || url.includes('/access/groups') || url.includes('/policies'));
      }

      it('SKIPS Access provisioning in onboarding mode with OAUTH_CLIENT_ID (THE BUG)', async () => {
        const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active', OAUTH_CLIENT_ID: 'x' } as Partial<Env>);
        // Onboarding needs Turnstile; provide the widget mock so the flow completes.
        globalThis.fetch = createUrlMockFetch({
          ...baseFlowMocks(),
          ...customDomainFlowMocks(),
          ...accessAppFlowMocks(),
          '~/challenges/widgets': () => new Response(
            JSON.stringify({ success: true, result: { sitekey: '0x4AAAAA-test', secret: 'turnstile-secret' } }),
            { status: 200, headers: jsonHeaders }
          ),
        });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        // No-op runStep keeps the wizard advancing: the step still reports success.
        expect(lines).toContainEqual(
          expect.objectContaining({ step: 'create_access_app', status: 'success' })
        );
        // But NO CF Access resources were created/updated.
        const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
        expect(mockFetch.mock.calls.filter(isAccessProvisionCall)).toHaveLength(0);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:access_app_id', expect.anything());
      });

      it('SKIPS Access provisioning in SaaS mode with OAUTH_CLIENT_ID (regression guard)', async () => {
        const app = createTestApp({ SAAS_MODE: 'active', OAUTH_CLIENT_ID: 'x' } as Partial<Env>);
        // SaaS also needs Turnstile; provide the widget mock so the flow completes.
        globalThis.fetch = createUrlMockFetch({
          ...baseFlowMocks(),
          ...customDomainFlowMocks(),
          ...accessAppFlowMocks(),
          '~/challenges/widgets': () => new Response(
            JSON.stringify({ success: true, result: { sitekey: '0x4AAAAA-test', secret: 'turnstile-secret' } }),
            { status: 200, headers: jsonHeaders }
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
          expect.objectContaining({ step: 'create_access_app', status: 'success' })
        );
        const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
        expect(mockFetch.mock.calls.filter(isAccessProvisionCall)).toHaveLength(0);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:access_app_id', expect.anything());
      });

      it('enterprise mode still PROVISIONS the host-wide Access app + the vault SW-bypass app', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...standardBody, dynamicRoutes: ['development'] }),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(lines).toContainEqual(
          expect.objectContaining({ step: 'create_access_app', status: 'success' })
        );

        const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
        // Host-wide enterprise Access app is created (POST to /access/apps).
        const hostAppCreate = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string'
            && call[0].includes('/access/apps')
            && (call[1] as RequestInit | undefined)?.method === 'POST'
            && JSON.parse(((call[1] as RequestInit).body as string) || '{}').domain === 'claude.example.com'
        );
        expect(hostAppCreate).toBeDefined();

        // SW-bypass app is created scoped to the vault service-worker script.
        const swBypassCreate = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string'
            && call[0].includes('/access/apps')
            && (call[1] as RequestInit | undefined)?.method === 'POST'
            && JSON.parse(((call[1] as RequestInit).body as string) || '{}').domain === 'claude.example.com/api/vault/*/service_worker.js'
        );
        expect(swBypassCreate).toBeDefined();
        // The SW-bypass app id is persisted to KV under the dedicated key.
        expect(mockKV.put).toHaveBeenCalledWith('setup:access_sw_bypass_app_id', expect.any(String));
      });

      it('default mode (no OAUTH_CLIENT_ID, no SaaS/onboarding) still PROVISIONS Access groups + app + policy', async () => {
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
        const groupCreate = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string'
            && call[0].includes('/access/groups')
            && (call[1] as RequestInit | undefined)?.method === 'POST'
        );
        const appCreate = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string'
            && call[0].includes('/access/apps')
            && (call[1] as RequestInit | undefined)?.method === 'POST'
        );
        const policyCreate = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string'
            && call[0].includes('/policies')
            && (call[1] as RequestInit | undefined)?.method === 'POST'
        );
        expect(groupCreate).toBeDefined();
        expect(appCreate).toBeDefined();
        expect(policyCreate).toBeDefined();
      });

      it('REQ-SETUP-004: a re-run in onboarding mode never creates an Access app (idempotent skip)', async () => {
        const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active', OAUTH_CLIENT_ID: 'x' } as Partial<Env>);
        // Both runs must execute the configure flow in bootstrap mode. The
        // idempotent case in REQ-SETUP-004 AC2 is retry-after-partial, where
        // setup:complete is unset on each retry. Without this, the first run's
        // setup:complete='true' write (backed by the mock KV) flips the second
        // run onto the auth-gated path (403) before it can re-run the flow.
        mockKV.get.mockResolvedValue(null);
        globalThis.fetch = createUrlMockFetch({
          ...baseFlowMocks(),
          ...customDomainFlowMocks(),
          ...accessAppFlowMocks(),
          '~/challenges/widgets': () => new Response(
            JSON.stringify({ success: true, result: { sitekey: '0x4AAAAA-test', secret: 'turnstile-secret' } }),
            { status: 200, headers: jsonHeaders }
          ),
        });

        for (let run = 0; run < 2; run++) {
          const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(standardBody),
          });
          expect(res.status).toBe(200);
          await readNdjson(res);
        }

        const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
        // Across BOTH runs: zero Access-app creation/update calls.
        const accessAppWrites = mockFetch.mock.calls.filter(
          (call) => typeof call[0] === 'string'
            && call[0].includes('/access/apps')
            && ((call[1] as RequestInit | undefined)?.method === 'POST'
              || (call[1] as RequestInit | undefined)?.method === 'PUT')
        );
        expect(accessAppWrites).toHaveLength(0);
      });
    });
  });
});
