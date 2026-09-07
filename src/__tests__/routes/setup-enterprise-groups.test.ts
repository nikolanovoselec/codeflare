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
    describe('Feature A/C: enterprise groups chip list + dynamic routes', () => {
      // Enterprise mode requires >=1 dynamic route (AC6), so the catalog is
      // present by default; route-specific tests override it via `extra`.
      function enterpriseBody(extra: Record<string, unknown>) {
        return { ...standardBody, dynamicRoutes: ['development'], ...extra };
      }

      it('persists the access groups comma-joined', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ enterpriseAccessGroup: ['team_a', 'team_b'] })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:enterprise_access_group', 'team_a,team_b');
      });

      it('clears the access-group key when the array is empty', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ enterpriseAccessGroup: [] })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.delete).toHaveBeenCalledWith('setup:enterprise_access_group');
      });

      it('persists dynamicRoutes as a JSON array', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ dynamicRoutes: ['development', 'prod'] })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:dynamic_routes', JSON.stringify(['development', 'prod']));
      });

      it('REQ-ENTERPRISE-012: persists the per-route context-window map as JSON', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const routeContextWindows = { development: 262144, prod: 1048576 };
        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ dynamicRoutes: ['development', 'prod'], routeContextWindows })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:route_context_windows', JSON.stringify(routeContextWindows));
      });

      it('REQ-ENTERPRISE-031 AC3: keeps context windows separate and writes profile assignments atomically', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            dynamicRoutes: ['development'],
            routeContextWindows: { development: 262144 },
            routeReasoningProfiles: { development: 'workers-ai-glm-thinking' },
          })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:route_context_windows', JSON.stringify({ development: 262144 }));
        const reasoningPut = mockKV.put.mock.calls.find(([key]) => key === 'setup:reasoning_configuration');
        expect(reasoningPut).toBeDefined();
        expect(JSON.parse(String(reasoningPut![1]))).toMatchObject({
          schemaVersion: 1,
          routeAssignments: {
            development: { activeProfile: { id: 'workers-ai-glm-thinking', revision: 1 } },
          },
        });
      });

      it('REQ-ENTERPRISE-012: clears the per-route context-window map when empty', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ routeContextWindows: {} })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.delete).toHaveBeenCalledWith('setup:route_context_windows');
      });

      it('REQ-ENTERPRISE-012: rejects a non-positive context window (boundary validation)', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ routeContextWindows: { development: 0 } })),
        });

        expect(res.status).toBe(400);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:route_context_windows', expect.anything());
      });

      it('REQ-BROWSER-007: persists the Browser Rendering token + account id', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ browserRenderToken: 'cf-br-token', browserRenderAccountId: 'acct123' })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        // Account id is non-secret -> stored verbatim. The token is written through
        // encryptAndStore (kv.put at the dedicated key); in production a configured
        // ENCRYPTION_KEY makes that ciphertext at rest.
        expect(mockKV.put).toHaveBeenCalledWith('setup:browser_render_account_id', 'acct123');
        expect(mockKV.put).toHaveBeenCalledWith('setup:browser_render_token', expect.any(String));
      });

      it('REQ-BROWSER-007: a blank token leaves the stored token untouched (no clobber)', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ browserRenderToken: '', browserRenderAccountId: 'acct123' })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        // Account id still written, but a blank token must not overwrite the stored one.
        expect(mockKV.put).toHaveBeenCalledWith('setup:browser_render_account_id', 'acct123');
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:browser_render_token', expect.anything());
      });

      // ─── REQ-GITHUB-008: enterprise GitHub provider config ──────────────────
      const ENC_KEY = 'A'.repeat(43) + '='; // base64 of 32 zero bytes — a valid AES-256 key

      // ─── REQ-ENTERPRISE-017: AI Gateway URL + token configured in the wizard ──
      it('REQ-ENTERPRISE-017: persists the AI Gateway URL (plain) + token (encrypted) and emits configure_ai_gateway', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: ENC_KEY });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ aigGatewayUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw', aigToken: 'aig-secret' })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        // URL is non-secret -> stored verbatim. The token rides encryptAndStore (kv.put at
        // its dedicated key) and the stored value must NOT contain the plaintext secret —
        // catches an accidental plaintext-storage regression of the token.
        expect(mockKV.put).toHaveBeenCalledWith('setup:aig_gateway_url', 'https://gateway.ai.cloudflare.com/v1/acct/gw');
        expect(mockKV.put).toHaveBeenCalledWith('setup:aig_token', expect.not.stringContaining('aig-secret'));
        // WS6: the step surfaces on the progress stream so the configuring screen shows it.
        expect(lines).toContainEqual(expect.objectContaining({ step: 'configure_ai_gateway', status: 'success' }));
      });

      it('REQ-ENTERPRISE-017: a blank AI Gateway token leaves the stored token untouched (no clobber)', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: ENC_KEY });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ aigGatewayUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw', aigToken: '' })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        // URL still written, but a blank token must not overwrite the stored one.
        expect(mockKV.put).toHaveBeenCalledWith('setup:aig_gateway_url', 'https://gateway.ai.cloudflare.com/v1/acct/gw');
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:aig_token', expect.anything());
      });

      it('REQ-ENTERPRISE-017: never writes the AI Gateway keys in non-enterprise mode (regression)', async () => {
        const app = createTestApp();
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ aigGatewayUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw', aigToken: 'aig-secret' })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:aig_gateway_url', expect.anything());
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:aig_token', expect.anything());
      });

      it('REQ-GITHUB-008: persists the provider type + client id (plain) and the secret (encrypted)', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: ENC_KEY });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            githubProviderType: 'app',
            githubAppClientId: 'Iv1.appcid',
            githubAppClientSecret: 'app-secret',
          })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:github_provider_type', 'app');
        expect(mockKV.put).toHaveBeenCalledWith('setup:github_app_client_id', 'Iv1.appcid');
        // The secret rides encryptAndStore (kv.put at its key); never plaintext-asserted.
        expect(mockKV.put).toHaveBeenCalledWith('setup:github_app_client_secret', expect.any(String));
      });

      it('REQ-GITHUB-008: a blank client secret leaves the stored secret untouched (no clobber)', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            githubProviderType: 'oauth',
            githubOauthClientId: 'oauth-cid',
            githubOauthClientSecret: '',
          })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:github_oauth_client_id', 'oauth-cid');
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:github_oauth_client_secret', expect.anything());
      });

      it('REQ-SETUP-024: omitted client IDs preserve stored values during internal initialization compatibility calls', async () => {
        const app = createTestApp({ ENCRYPTION_KEY: ENC_KEY });
        mockFullSuccessFlow();
        await mockKV.put('setup:github_app_client_id', 'saved-github-app');
        await mockKV.put('setup:github_oauth_client_id', 'saved-github-oauth');
        await mockKV.put('setup:cloudflare_oauth_client_id', 'saved-cloudflare-oauth');

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...standardBody,
            githubProviderType: 'app',
            cloudflareOauthClientSecret: 'replacement-secret',
          }),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(await mockKV.get('setup:github_app_client_id')).toBe('saved-github-app');
        expect(await mockKV.get('setup:github_oauth_client_id')).toBe('saved-github-oauth');
        expect(await mockKV.get('setup:cloudflare_oauth_client_id')).toBe('saved-cloudflare-oauth');
      });

      it('REQ-GITHUB-008: rejects a client secret with no ENCRYPTION_KEY (fail closed, no write)', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' }); // no ENCRYPTION_KEY

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ githubProviderType: 'app', githubAppClientSecret: 'app-secret' })),
        });

        expect(res.status).toBe(400);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:github_app_client_secret', expect.anything());
      });

      // ─── Provider config persists in non-enterprise too (admin, any mode) ───
      it('persists the GitHub provider config in non-enterprise (no ENTERPRISE_MODE)', async () => {
        const app = createTestApp({ ENCRYPTION_KEY: ENC_KEY }); // no ENTERPRISE_MODE
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...standardBody, githubProviderType: 'oauth', githubOauthClientId: 'oauth-cid', githubOauthClientSecret: 'oauth-secret' }),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:github_provider_type', 'oauth');
        expect(mockKV.put).toHaveBeenCalledWith('setup:github_oauth_client_id', 'oauth-cid');
        expect(mockKV.put).toHaveBeenCalledWith('setup:github_oauth_client_secret', expect.any(String));
      });

      it('persists the Cloudflare OAuth client (id plain, secret encrypted) in non-enterprise', async () => {
        const app = createTestApp({ ENCRYPTION_KEY: ENC_KEY }); // no ENTERPRISE_MODE
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...standardBody, cloudflareOauthClientId: 'cf-cid', cloudflareOauthClientSecret: 'cf-secret' }),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:cloudflare_oauth_client_id', 'cf-cid');
        expect(mockKV.put).toHaveBeenCalledWith('setup:cloudflare_oauth_client_secret', expect.any(String));
      });

      it('rejects a Cloudflare client secret with no ENCRYPTION_KEY (fail closed, no write)', async () => {
        const app = createTestApp({}); // no ENCRYPTION_KEY, no ENTERPRISE_MODE

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...standardBody, cloudflareOauthClientSecret: 'cf-secret' }),
        });

        expect(res.status).toBe(400);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:cloudflare_oauth_client_secret', expect.anything());
      });

      // ─── REQ-ENTERPRISE-013: per-group routing ──────────────────────────────
      it('REQ-ENTERPRISE-013: persists the per-group routing map as JSON', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const groupRouting = { developers: { routes: ['code_review'], defaultRoute: 'code_review', reasoning: 'high' } };
        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            enterpriseAccessGroup: ['developers'],
            dynamicRoutes: ['code_review', 'development'],
            groupRouting,
          })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:group_routing', JSON.stringify(groupRouting));
      });

      it('REQ-ENTERPRISE-013: clears the per-group routing map when empty', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ groupRouting: {} })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.delete).toHaveBeenCalledWith('setup:group_routing');
      });

      it("REQ-ENTERPRISE-013: rejects a group whose defaultRoute isn't in its routes", async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            enterpriseAccessGroup: ['developers'],
            dynamicRoutes: ['code_review', 'development'],
            groupRouting: { developers: { routes: ['code_review'], defaultRoute: 'development', reasoning: 'off' } },
          })),
        });

        expect(res.status).toBe(400);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:group_routing', expect.anything());
      });

      it('REQ-ENTERPRISE-013: rejects a group route not in the global catalog', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            enterpriseAccessGroup: ['developers'],
            dynamicRoutes: ['code_review'],
            groupRouting: { developers: { routes: ['nonexistent'], defaultRoute: 'nonexistent', reasoning: 'off' } },
          })),
        });

        expect(res.status).toBe(400);
      });

      it('returns 400 and writes nothing when enterprise mode has no dynamic routes (AC6)', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ dynamicRoutes: [] })),
        });

        expect(res.status).toBe(400);
        const body = await res.json() as { code: string };
        expect(body.code).toBe('VALIDATION_ERROR');
        // Rejected before any KV write — no partial setup state.
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:dynamic_routes', expect.anything());
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:custom_domain', expect.anything());
      });

      it('persists defaultRoute as JSON', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            dynamicRoutes: ['development'],
            defaultRoute: { route: 'development', reasoning: 'medium' },
          })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:default_route', JSON.stringify({ route: 'development', reasoning: 'medium' }));
      });

      it('persists a defaultRoute with a new Pi thinking level (xhigh)', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            dynamicRoutes: ['development'],
            defaultRoute: { route: 'development', reasoning: 'xhigh' },
          })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:default_route', JSON.stringify({ route: 'development', reasoning: 'xhigh' }));
      });

      it('returns 400 for a reasoning level outside the Pi enum', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            dynamicRoutes: ['development'],
            defaultRoute: { route: 'development', reasoning: 'turbo' },
          })),
        });

        expect(res.status).toBe(400);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:default_route', expect.anything());
      });

      it('clears the default-route key when defaultRoute is null', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ dynamicRoutes: ['x'], defaultRoute: null })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.delete).toHaveBeenCalledWith('setup:default_route');
      });

      it('returns 400 when a group name contains a comma', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ enterpriseAccessGroup: ['bad,name'] })),
        });

        expect(res.status).toBe(400);
        const body = await res.json() as { code: string };
        expect(body.code).toBe('VALIDATION_ERROR');
      });

      it('returns 400 when a route name contains a newline', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ dynamicRoutes: ['bad\nroute'] })),
        });

        expect(res.status).toBe(400);
        const body = await res.json() as { code: string };
        expect(body.code).toBe('VALIDATION_ERROR');
      });

      it('returns 400 when a name exceeds 256 characters', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ enterpriseAccessGroup: ['a'.repeat(257)] })),
        });

        expect(res.status).toBe(400);
        const body = await res.json() as { code: string };
        expect(body.code).toBe('VALIDATION_ERROR');
      });

      it('returns 400 when defaultRoute.route is not in the catalog', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            dynamicRoutes: ['a'],
            defaultRoute: { route: 'b', reasoning: 'off' },
          })),
        });

        expect(res.status).toBe(400);
        const body = await res.json() as { code: string };
        expect(body.code).toBe('VALIDATION_ERROR');
      });

      it('returns 400 when reasoning is outside the enum', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({
            dynamicRoutes: ['a'],
            defaultRoute: { route: 'a', reasoning: 'extreme' },
          })),
        });

        expect(res.status).toBe(400);
        const body = await res.json() as { code: string };
        expect(body.code).toBe('VALIDATION_ERROR');
      });

      it('ignores the fields in non-enterprise mode (regression)', async () => {
        const app = createTestApp();
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ enterpriseAccessGroup: ['x'] })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(getNdjsonSummary(lines).success).toBe(true);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:enterprise_access_group', expect.anything());
      });

      it('trims each group name before joining', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ enterpriseAccessGroup: ['  team_a  '] })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:enterprise_access_group', 'team_a');
      });

      // ─── REQ-ENTERPRISE-014: admin Access groups ────────────────────────────
      it('REQ-ENTERPRISE-014: persists the admin access groups comma-joined', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ adminAccessGroup: ['ops_admins', 'security_admins'] })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:enterprise_admin_access_group', 'ops_admins,security_admins');
      });

      it('REQ-ENTERPRISE-014: clears the admin access-group key when the array is empty', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ adminAccessGroup: [] })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.delete).toHaveBeenCalledWith('setup:enterprise_admin_access_group');
      });

      it('REQ-ENTERPRISE-014: ignores adminAccessGroup in non-enterprise mode (regression)', async () => {
        const app = createTestApp();
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ adminAccessGroup: ['ops_admins'] })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(getNdjsonSummary(lines).success).toBe(true);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:enterprise_admin_access_group', expect.anything());
      });

      // ─── REQ-ENTERPRISE-016: strict gateway egress toggle ───────────────────
      it('REQ-ENTERPRISE-016: persists the toggle as active when true (EGRESS bound)', async () => {
        // EGRESS bound -> the enable guardrail passes and the toggle persists 'active'.
        const app = createTestApp({ ENTERPRISE_MODE: 'active', EGRESS: { fetch: async () => new Response(null) } as unknown as Env['EGRESS'] });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ strictGatewayEgress: true })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:strict_egress', 'active');
        // WS6: the toggle persistence surfaces as its own progress step.
        expect(lines).toContainEqual(expect.objectContaining({ step: 'configure_strict_egress', status: 'success' }));
      });

      it('REQ-ENTERPRISE-016: refuses to enable the toggle when EGRESS is unbound (no brick)', async () => {
        // Enabling strict egress without the EGRESS VPC binding would 503 every
        // container call; the handler must reject pre-stream and never persist 'active'.
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ strictGatewayEgress: true })),
        });

        expect(res.status).toBe(400);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:strict_egress', 'active');
      });

      it('REQ-ENTERPRISE-016: persists the toggle as inactive when false', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ strictGatewayEgress: false })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:strict_egress', 'inactive');
      });

      it('REQ-ENTERPRISE-016: never writes the toggle in non-enterprise mode (regression)', async () => {
        const app = createTestApp();
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ strictGatewayEgress: true })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(getNdjsonSummary(lines).success).toBe(true);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:strict_egress', expect.anything());
      });

      // ─── REQ-ENTERPRISE-018: Governed Mode (R2 SSE-C disable) toggle ──────────
      it('REQ-ENTERPRISE-018: persists the toggle as active when true', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ r2SseDisabled: true })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:r2_sse_disabled', 'active');
        expect(lines).toContainEqual(expect.objectContaining({ step: 'configure_r2_sse', status: 'success' }));
      });

      it('REQ-ENTERPRISE-018: persists the toggle as inactive when false', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ r2SseDisabled: false })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:r2_sse_disabled', 'inactive');
      });

      it('REQ-ENTERPRISE-018: defaults OFF — never writes the toggle when the field is absent', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({})),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:r2_sse_disabled', expect.anything());
      });

      it('REQ-ENTERPRISE-018: never writes the toggle in non-enterprise mode (regression)', async () => {
        const app = createTestApp();
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ r2SseDisabled: true })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(getNdjsonSummary(lines).success).toBe(true);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:r2_sse_disabled', expect.anything());
      });

      // ─── View-only storage (downloads disabled) toggle ────────────────────────
      it('REQ-ENTERPRISE-019: persists the downloads-disabled toggle as active when true', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ downloadsDisabled: true })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:downloads_disabled', 'active');
        expect(lines).toContainEqual(expect.objectContaining({ step: 'configure_downloads_disabled', status: 'success' }));
      });

      it('REQ-ENTERPRISE-019: persists the downloads-disabled toggle as inactive when false', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ downloadsDisabled: false })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:downloads_disabled', 'inactive');
      });

      it('REQ-ENTERPRISE-019: defaults OFF — never writes the downloads-disabled toggle when the field is absent', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({})),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:downloads_disabled', expect.anything());
      });

      it('REQ-ENTERPRISE-019: never writes the downloads-disabled toggle in non-enterprise mode (regression)', async () => {
        const app = createTestApp();
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ downloadsDisabled: true })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(getNdjsonSummary(lines).success).toBe(true);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:downloads_disabled', expect.anything());
      });

      // ─── Active coding agents (REQ-ENTERPRISE-025) ────────────────────────────
      it('REQ-ENTERPRISE-025: persists the active-agent selection as JSON with its own step', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ activeAgents: ['pi'] })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:active_agents', '["pi"]');
        expect(lines).toContainEqual(expect.objectContaining({ step: 'configure_active_agents', status: 'success' }));
      });

      it('REQ-ENTERPRISE-025: canonicalizes the stored selection (deduped, catalog order)', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ activeAgents: ['pi', 'pi', 'copilot'] })),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).toHaveBeenCalledWith('setup:active_agents', '["copilot","pi"]');
      });

      it('REQ-ENTERPRISE-025: rejects an empty active-agent selection with 400', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ activeAgents: [] })),
        });

        expect(res.status).toBe(400);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:active_agents', expect.anything());
      });

      it('REQ-ENTERPRISE-025: rejects a selection containing a non-capable agent with 400', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ activeAgents: ['pi', 'claude-code'] })),
        });

        expect(res.status).toBe(400);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:active_agents', expect.anything());
      });

      it('REQ-ENTERPRISE-025 AC3: rejects a capable agent whose CLI is omitted from the image', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active', CODING_AGENTS: 'pi' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ activeAgents: ['copilot'] })),
        });

        expect(res.status).toBe(400);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:active_agents', expect.anything());
      });

      it('REQ-ENTERPRISE-025: never writes the selection when the field is absent', async () => {
        const app = createTestApp({ ENTERPRISE_MODE: 'active' });
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({})),
        });

        expect(res.status).toBe(200);
        await readNdjson(res);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:active_agents', expect.anything());
      });

      it('REQ-ENTERPRISE-025: never writes the selection in non-enterprise mode (regression)', async () => {
        const app = createTestApp();
        mockFullSuccessFlow();

        const res = await app.request('https://codeflare.test.workers.dev/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enterpriseBody({ activeAgents: ['pi'] })),
        });

        expect(res.status).toBe(200);
        const lines = await readNdjson(res);
        expect(getNdjsonSummary(lines).success).toBe(true);
        expect(mockKV.put).not.toHaveBeenCalledWith('setup:active_agents', expect.anything());
      });
    });
  });
});
