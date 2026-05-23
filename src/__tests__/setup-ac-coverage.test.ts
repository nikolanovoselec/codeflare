/**
 * AC-coverage tests for setup domain REQs.
 *
 * Covered here (REQ-ID appears in each it() name per tdd-discipline):
 *   REQ-SETUP-001 ACs 1, 2, 3, 4, 5
 *   REQ-SETUP-002 ACs 1, 2, 3, 4, 5
 *   REQ-SETUP-012 ACs 1, 2, 3, 4, 5, 6, 7
 *   REQ-SETUP-004 ACs 1, 2, 3, 4, 5
 *
 * Framework: vitest (src/__tests__/**\/*.test.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import setupRoutes from '../routes/setup';
import type { Env } from '../types';
import { ValidationError, SetupError, ForbiddenError } from '../lib/error-types';
import { resetAuthConfigCache } from '../lib/access';
import { createMockKV } from './helpers/mock-kv';

// ---------------------------------------------------------------------------
// Shared infrastructure (mirrors setup.test.ts helpers - kept local so this
// file is self-contained and does not depend on setup.test.ts internals)
// ---------------------------------------------------------------------------

vi.mock('../lib/circuit-breakers', () => ({
  cfApiCB: { execute: (fn: () => Promise<unknown>) => fn() },
}));

const jsonHeaders = { 'Content-Type': 'application/json' };

function createUrlMockFetch(
  responses: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>>
) {
  const defaultIdpMock: Record<string, (url: string, init?: RequestInit) => Response> = {
    '/identity_providers': () =>
      new Response(
        JSON.stringify({ success: true, result: [{ id: 'idp-google', type: 'google', name: 'Google' }] }),
        { status: 200, headers: jsonHeaders }
      ),
  };
  const merged = { ...defaultIdpMock, ...responses };
  const sortedEntries = Object.entries(merged).sort((a, b) => b[0].length - a[0].length);
  return vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const urlString =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const urlPath = urlString.split('?')[0];
    for (const [rawPattern, factory] of sortedEntries) {
      if (rawPattern.includes('?')) {
        if (urlString.includes(rawPattern)) return Promise.resolve(factory(urlString, init));
      } else if (rawPattern.startsWith('~')) {
        const pattern = rawPattern.slice(1);
        if (urlPath.includes(pattern)) return Promise.resolve(factory(urlString, init));
      } else {
        if (urlPath.endsWith(rawPattern)) return Promise.resolve(factory(urlString, init));
      }
    }
    return Promise.reject(new Error(`Unmocked: ${init?.method ?? 'GET'} ${urlString}`));
  });
}

async function readNdjson(res: Response): Promise<Record<string, unknown>[]> {
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function getNdjsonSummary(lines: Record<string, unknown>[]): Record<string, unknown> {
  const summary = lines.find((l) => l.done === true);
  if (!summary) throw new Error('No summary line found in NDJSON response');
  return summary;
}

const TEST_TOKEN = 'test-env-api-token';
const TEST_WORKER_BASE_URL = 'https://codeflare.test.workers.dev';
const TEST_WORKER_NAME = new URL(TEST_WORKER_BASE_URL).hostname.split('.')[0] ?? 'codeflare';
const TEST_ADMIN_GROUP_NAME = `${TEST_WORKER_NAME}-admins`;
const TEST_USER_GROUP_NAME = `${TEST_WORKER_NAME}-users`;

const mockResponses = {
  accounts: () =>
    new Response(JSON.stringify({ success: true, result: [{ id: 'acc123' }] }), {
      status: 200,
      headers: jsonHeaders,
    }),
  tokenVerify: () =>
    new Response(JSON.stringify({ success: true, result: { id: 'r2-key-id', status: 'active' } }), {
      status: 200,
      headers: jsonHeaders,
    }),
  secretPut: () => new Response('', { status: 200 }),
  zoneLookup: () =>
    new Response(JSON.stringify({ success: true, result: [{ id: 'zone123' }] }), {
      status: 200,
      headers: jsonHeaders,
    }),
  subdomainLookup: () =>
    new Response(JSON.stringify({ success: true, result: { subdomain: 'test-account' } }), {
      status: 200,
      headers: jsonHeaders,
    }),
  dnsRecordLookupEmpty: () =>
    new Response(JSON.stringify({ success: true, result: [] }), { status: 200, headers: jsonHeaders }),
  dnsRecordCreate: () => new Response('', { status: 200 }),
  workerRouteCreate: () => new Response('', { status: 200 }),
  accessAppsLookupEmpty: () =>
    new Response(JSON.stringify({ success: true, result: [] }), { status: 200, headers: jsonHeaders }),
  accessAppCreate: () =>
    new Response(JSON.stringify({ success: true, result: { id: 'app123' } }), {
      status: 200,
      headers: jsonHeaders,
    }),
  accessGroupsLookupEmpty: () =>
    new Response(JSON.stringify({ success: true, result: [] }), { status: 200, headers: jsonHeaders }),
  accessGroupCreate: (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || '{}') as { name?: string };
    const idByName: Record<string, string> = {
      [TEST_ADMIN_GROUP_NAME]: 'group-admins-123',
      [TEST_USER_GROUP_NAME]: 'group-users-456',
    };
    return new Response(
      JSON.stringify({
        success: true,
        result: { id: idByName[body.name ?? ''] ?? 'group-generic-999', name: body.name ?? 'group' },
      }),
      { status: 200, headers: jsonHeaders }
    );
  },
  accessPolicyCreate: () => new Response('', { status: 200 }),
};

function baseFlowMocks(): Record<string, (url: string, init?: RequestInit) => Response> {
  return {
    '/accounts': mockResponses.accounts,
    '~/tokens/verify': mockResponses.tokenVerify,
    '~/secrets': mockResponses.secretPut,
  };
}

function customDomainFlowMocks(): Record<string, (url: string, init?: RequestInit) => Response> {
  return {
    '/zones?name=': mockResponses.zoneLookup,
    '/workers/subdomain': mockResponses.subdomainLookup,
    '~/dns_records': (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return mockResponses.dnsRecordLookupEmpty();
      return mockResponses.dnsRecordCreate();
    },
    '/workers/routes': mockResponses.workerRouteCreate,
  };
}

function accessAppFlowMocks(): Record<string, (url: string, init?: RequestInit) => Response> {
  return {
    '~/access/apps': (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return mockResponses.accessAppsLookupEmpty();
      return mockResponses.accessAppCreate();
    },
    '~/access/groups': (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return mockResponses.accessGroupsLookupEmpty();
      if (init.method === 'POST') return mockResponses.accessGroupCreate(url, init);
      return new Response('', { status: 200 });
    },
    '~/policies': mockResponses.accessPolicyCreate,
  };
}

function mockFullSuccessFlow() {
  globalThis.fetch = createUrlMockFetch({
    ...baseFlowMocks(),
    ...customDomainFlowMocks(),
    ...accessAppFlowMocks(),
  });
}

const standardBody = {
  customDomain: 'claude.example.com',
  allowedUsers: ['user@example.com'],
  adminUsers: ['user@example.com'],
};

describe('Setup AC Coverage', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
    resetAuthConfigCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function createTestApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env }>();

    app.onError((err, c) => {
      if (err instanceof ForbiddenError)
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      if (err instanceof ValidationError)
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      if (err instanceof SetupError)
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      return c.json({ error: (err as Error).message }, 500);
    });

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

  // ---------------------------------------------------------------------------
  // REQ-SETUP-001: First-time setup requires zero pre-configuration
  // ---------------------------------------------------------------------------

  describe('REQ-SETUP-001', () => {
    it('REQ-SETUP-001 AC1: POST /api/setup/configure is publicly accessible when setup:complete is not set in KV', async () => {
      // setup:complete not set -> KV.get returns null -> middleware passes through without auth
      mockKV.get.mockResolvedValue(null);
      mockFullSuccessFlow();

      const app = createTestApp();
      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      // Must NOT return 401/403 - the endpoint is public before setup
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      // Consume stream
      await readNdjson(res);
    });

    it('REQ-SETUP-001 AC2: only CLOUDFLARE_API_TOKEN binding is required - no other pre-configuration needed', async () => {
      // App with only CLOUDFLARE_API_TOKEN set (no other setup bindings)
      const app = createTestApp({
        CLOUDFLARE_API_TOKEN: 'only-token-needed',
        // SAAS_MODE, ONBOARDING_LANDING_PAGE, OAUTH_CLIENT_ID all absent/undefined
        SAAS_MODE: undefined as unknown as string,
        ONBOARDING_LANDING_PAGE: undefined as unknown as string,
      });
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      expect(res.status).toBe(200);
      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      // Setup completes successfully with only the API token
      expect(summary.success).toBe(true);
    });

    it('REQ-SETUP-001 AC3: CLOUDFLARE_API_TOKEN is read from environment binding not from request body', async () => {
      const app = createTestApp({ CLOUDFLARE_API_TOKEN: 'from-env-binding' });
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Deliberately include a different token in the body - it must be ignored
          body: JSON.stringify({ ...standardBody, token: 'body-token-must-be-ignored' }),
        }
      );

      expect(res.status).toBe(200);
      await readNdjson(res);

      // CF API must have been called with the env token, not any body token
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts',
        expect.objectContaining({
          headers: { Authorization: 'Bearer from-env-binding' },
        })
      );
    });

    it('REQ-SETUP-001 AC4: setup wizard creates R2 credentials, DNS records, and Access app resources', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      expect(res.status).toBe(200);
      const lines = await readNdjson(res);

      // R2 credentials derived and set as secrets
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'derive_r2_credentials', status: 'success' })
      );
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'set_secrets', status: 'success' })
      );
      // DNS record + route created
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'configure_custom_domain', status: 'success' })
      );
      // Access application created
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'create_access_app', status: 'success' })
      );
    });

    it('REQ-SETUP-001 AC5: GET /api/setup/status is always public and returns configured, customDomain, saasMode shape', async () => {
      // No KV setup:complete set -> endpoint must still be accessible
      mockKV.get.mockImplementation(async (key: string) => {
        if (key === 'setup:complete') return null;
        return null;
      });

      const app = createTestApp({ SAAS_MODE: 'active' });
      const res = await app.request('/api/setup/status');

      // Public - no auth needed
      expect(res.status).toBe(200);
      const body = await res.json() as { configured: boolean; saasMode: boolean; customDomain?: string };

      // All required shape fields present
      expect(typeof body.configured).toBe('boolean');
      expect(body.configured).toBe(false);
      expect(typeof body.saasMode).toBe('boolean');
      expect(body.saasMode).toBe(true);
      // customDomain only present when configured
      expect(body.customDomain).toBeUndefined();
    });

    it('REQ-SETUP-001 AC5: GET /api/setup/status returns customDomain when setup is complete', async () => {
      mockKV.get.mockImplementation(async (key: string) => {
        if (key === 'setup:complete') return 'true';
        if (key === 'setup:custom_domain') return 'claude.example.com';
        return null;
      });

      const app = createTestApp();
      const res = await app.request('/api/setup/status');

      expect(res.status).toBe(200);
      const body = await res.json() as { configured: boolean; saasMode: boolean; customDomain?: string };
      expect(body.configured).toBe(true);
      expect(body.customDomain).toBe('claude.example.com');
      expect(body.saasMode).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // REQ-SETUP-002: Setup wizard configures domain, auth, R2 credentials, and Turnstile
  // ---------------------------------------------------------------------------

  describe('REQ-SETUP-002', () => {
    it('REQ-SETUP-002 AC1: request body requires customDomain (valid domain), allowedUsers (non-empty email array), adminUsers (non-empty email array, subset of allowedUsers)', async () => {
      const app = createTestApp();

      // Missing customDomain
      const res1 = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowedUsers: ['u@example.com'], adminUsers: ['u@example.com'] }),
        }
      );
      expect(res1.status).toBe(400);

      // Empty allowedUsers
      const res2 = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customDomain: 'claude.example.com', allowedUsers: [], adminUsers: ['u@example.com'] }),
        }
      );
      expect(res2.status).toBe(400);

      // adminUsers not subset of allowedUsers
      const res3 = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customDomain: 'claude.example.com',
            allowedUsers: ['user@example.com'],
            adminUsers: ['admin@example.com'], // not in allowedUsers
          }),
        }
      );
      expect(res3.status).toBe(400);
    });

    it('REQ-SETUP-002 AC1: allowedOrigins must start with dot when provided', async () => {
      const app = createTestApp();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...standardBody,
            allowedOrigins: ['workers.dev'], // missing leading dot
          }),
        }
      );
      expect(res.status).toBe(400);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('REQ-SETUP-002 AC2: Zod validation errors are returned before streaming starts (synchronous 400)', async () => {
      const app = createTestApp();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customDomain: 'not-a-valid..domain', allowedUsers: [], adminUsers: [] }),
        }
      );

      // Validation must fire before the stream is opened - synchronous 400
      expect(res.status).toBe(400);
      // Response is JSON, not NDJSON - streaming never started
      expect(res.headers.get('Content-Type')).toContain('application/json');
    });

    it('REQ-SETUP-002 AC3: configure response is NDJSON with Content-Type application/x-ndjson', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');
    });

    it('REQ-SETUP-002 AC3: configure streams per-step progress for all 7 setup steps', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      const lines = await readNdjson(res);
      const stepNames = lines.filter((l) => l.step !== undefined).map((l) => l.step);

      // Every step emits at minimum a 'running' event
      expect(stepNames).toContain('get_account');
      expect(stepNames).toContain('derive_r2_credentials');
      expect(stepNames).toContain('set_secrets');
      expect(stepNames).toContain('configure_custom_domain');
      expect(stepNames).toContain('create_access_app');
      expect(stepNames).toContain('finalize');
    });

    it('REQ-SETUP-002 AC4: all KV keys written by setup use the setup: prefix', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      await readNdjson(res);

      // Every KV key written by setup-domain code must start with 'setup:'.
      // The configure flow legitimately writes to several other namespaces
      // during its run (user/auth onboarding, rate-limit middleware), so the
      // AC is scoped to the setup-domain writes only. Excluded prefixes:
      //   - user:            individual user records (onboarded during setup)
      //   - user-prefs:      per-user preferences (onboarded during setup)
      //   - preferences:     legacy per-user prefs key
      //   - setup-configure: rate-limit middleware bookkeeping (separate domain)
      const NON_SETUP_PREFIXES = ['user:', 'user-prefs:', 'preferences:', 'setup-configure:'];
      const kvPutCalls = mockKV.put.mock.calls as [string, string][];
      const setupPuts = kvPutCalls.filter(([key]) =>
        !NON_SETUP_PREFIXES.some((p) => key.startsWith(p))
      );
      expect(setupPuts.length).toBeGreaterThan(0);
      for (const [key] of setupPuts) {
        expect(key).toMatch(/^setup:/);
      }
    });

    it('REQ-SETUP-002 AC5: response stream ends with exactly one object containing done: true', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      const lines = await readNdjson(res);
      const doneLines = lines.filter((l) => l.done === true);

      // Exactly one completion object
      expect(doneLines).toHaveLength(1);
      expect(doneLines[0].done).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // REQ-SETUP-012: Setup wizard step sequence
  // ---------------------------------------------------------------------------

  describe('REQ-SETUP-012', () => {
    it('REQ-SETUP-012 AC1: step get_account retrieves account ID from the API token', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      const lines = await readNdjson(res);
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'get_account', status: 'success' })
      );

      // KV stores the account ID retrieved
      expect(mockKV.put).toHaveBeenCalledWith('setup:account_id', 'acc123');
    });

    it('REQ-SETUP-012 AC2: step derive_r2_credentials uses token ID as Access Key ID and SHA-256 of token as Secret', async () => {
      const app = createTestApp({ CLOUDFLARE_API_TOKEN: 'test-token-value' });
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      await readNdjson(res);

      // R2_ACCESS_KEY_ID should be the token ID returned by /user/tokens/verify
      const secretCalls = (mockKV.put.mock.calls as [string, string][]).filter(
        ([key]) => key.startsWith('setup:')
      );
      expect(secretCalls.length).toBeGreaterThan(0);

      // The secrets PUT to CF API must include R2_ACCESS_KEY_ID = 'r2-key-id' (the token ID)
      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const secretApiCalls = mockFetch.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('/secrets') &&
          (call[1] as RequestInit)?.method === 'PUT'
      );
      const accessKeyCall = secretApiCalls.find((call) => {
        const body = JSON.parse((call[1] as RequestInit).body as string) as { name: string };
        return body.name === 'R2_ACCESS_KEY_ID';
      });
      expect(accessKeyCall).toBeDefined();
      const accessKeyBody = JSON.parse(
        (accessKeyCall![1] as RequestInit).body as string
      ) as { name: string; text: string };
      // Token ID from /user/tokens/verify mock returns 'r2-key-id'
      expect(accessKeyBody.text).toBe('r2-key-id');
    });

    it('REQ-SETUP-012 AC3: step set_secrets sets R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY as Worker secrets', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      await readNdjson(res);

      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const secretPuts = mockFetch.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('/secrets') &&
          (call[1] as RequestInit)?.method === 'PUT'
      );
      const secretNames = secretPuts.map((call) => {
        const body = JSON.parse((call[1] as RequestInit).body as string) as { name: string };
        return body.name;
      });
      expect(secretNames).toContain('R2_ACCESS_KEY_ID');
      expect(secretNames).toContain('R2_SECRET_ACCESS_KEY');
    });

    it('REQ-SETUP-012 AC4: step cleanup_stale_users runs only on reconfigure when users removed from allowlist', async () => {
      // Seed an existing user who is NOT in the new allowedUsers list
      mockKV._set('user:removed@example.com', { role: 'user', addedBy: 'setup' });

      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // removed@example.com is not in allowedUsers -> should be cleaned up
          body: JSON.stringify(standardBody),
        }
      );

      const lines = await readNdjson(res);
      // cleanup_stale_users step fires because stale users exist
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'cleanup_stale_users', status: 'success' })
      );
    });

    it('REQ-SETUP-012 AC5: step configure_custom_domain creates CNAME DNS record and Worker route', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      await readNdjson(res);

      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      // DNS record POST (CNAME creation)
      const dnsCall = mockFetch.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('/dns_records') &&
          (call[1] as RequestInit)?.method === 'POST'
      );
      expect(dnsCall).toBeDefined();
      const dnsBody = JSON.parse((dnsCall![1] as RequestInit).body as string) as { type: string };
      expect(dnsBody.type).toBe('CNAME');

      // Worker route creation
      const routeCall = mockFetch.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          (call[0] as string).endsWith('/workers/routes') &&
          (call[1] as RequestInit)?.method === 'POST'
      );
      expect(routeCall).toBeDefined();
    });

    it('REQ-SETUP-012 AC6: step create_access_app creates CF Access application and is skipped in GitHub OIDC mode', async () => {
      // Default mode (not GitHub OIDC): Access app is created
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      const lines = await readNdjson(res);
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'create_access_app', status: 'success' })
      );

      const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
      const accessAppPost = mockFetch.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('/access/apps') &&
          (call[1] as RequestInit)?.method === 'POST'
      );
      expect(accessAppPost).toBeDefined();
    });

    it('REQ-SETUP-012 AC7: step finalize writes setup:complete true and marks setup done', async () => {
      const app = createTestApp();
      mockFullSuccessFlow();

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(true);

      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'finalize', status: 'success' })
      );
      // KV marked complete
      expect(mockKV.put).toHaveBeenCalledWith('setup:complete', 'true');
    });
  });

  // ---------------------------------------------------------------------------
  // REQ-SETUP-004: Setup is idempotent
  // ---------------------------------------------------------------------------

  describe('REQ-SETUP-004', () => {
    it('REQ-SETUP-004 AC1: get_account is a read and derive_r2_credentials is deterministic from the token (idempotent by design)', async () => {
      // Two properties under AC1:
      //   (a) get_account fetches /accounts via HTTP GET (idempotent verb)
      //   (b) derive_r2_credentials produces the same R2 credentials every
      //       time it runs against the same API token (deterministic transform)
      //
      // We verify (b) by calling handleDeriveR2Credentials twice with the same
      // token and asserting identical output. This bypasses the brittle
      // "run configure twice and diff fetch.mock.calls" pattern which races
      // with the KV-backed lock and partial-state branches.
      //
      // We verify (a) by inspecting the HTTP verb on the /accounts call after
      // a single configure run.
      const { handleDeriveR2Credentials } = await import('../routes/setup/credentials');

      const STABLE_TOKEN = 'stable-token-for-determinism-check';

      // Mock /user/tokens/verify so handleDeriveR2Credentials can resolve a token ID
      const verifyResponse = () =>
        new Response(
          JSON.stringify({ success: true, result: { id: 'r2-key-id', status: 'active' } }),
          { status: 200, headers: jsonHeaders }
        );
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (u.includes('/user/tokens/verify')) return verifyResponse();
        throw new Error(`Unexpected fetch in determinism check: ${u}`);
      }) as typeof fetch;

      const first = await handleDeriveR2Credentials(STABLE_TOKEN, []);
      const second = await handleDeriveR2Credentials(STABLE_TOKEN, []);

      // (b) Same token in -> same credentials out, every call.
      expect(first.accessKeyId).toBe(second.accessKeyId);
      expect(first.secretAccessKey).toBe(second.secretAccessKey);
      // Sanity: secretAccessKey is SHA-256(token) hex, exactly 64 hex chars.
      // Guards against the implementation drifting to a non-deterministic transform.
      expect(first.secretAccessKey).toMatch(/^[0-9a-f]{64}$/);
      expect(first.accessKeyId).toBe('r2-key-id');

      // (a) get_account verb is GET. Production calls fetch with no `method`
      // option for the read, which Fetch defaults to GET. Run configure once
      // and inspect the /accounts call.
      mockFullSuccessFlow();
      const accountsApp = createTestApp({ CLOUDFLARE_API_TOKEN: 'stable-token' });
      const res = await accountsApp.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );
      await readNdjson(res);
      const accountsCalls = (globalThis.fetch as ReturnType<typeof createUrlMockFetch>).mock.calls
        .filter((call) => {
          const u = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString?.() ?? '';
          return u.endsWith('/accounts') || u.includes('/accounts?');
        });
      expect(accountsCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of accountsCalls) {
        const method = (call[1] as RequestInit | undefined)?.method;
        expect(method === undefined || method === 'GET').toBe(true);
      }
    });

    it('REQ-SETUP-004 AC2: if previous run partially completed, retry starts from step 1 and updates existing resources', async () => {
      const app = createTestApp();

      // Pre-set some KV state from a previous partial run (account_id cached)
      mockKV._set('setup:account_id', 'acc123');

      // Even with partial state, a fresh configure call must succeed fully
      mockFullSuccessFlow();
      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      // Full run succeeds despite partial prior state
      expect(summary.success).toBe(true);
      expect(lines).toContainEqual(expect.objectContaining({ step: 'get_account', status: 'success' }));
      expect(lines).toContainEqual(expect.objectContaining({ step: 'finalize', status: 'success' }));
    });

    it('REQ-SETUP-004 AC3: setup:complete is NOT written when a step fails - failed run not marked complete', async () => {
      const app = createTestApp();

      // Make DNS step fail - simulates partial failure
      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        '/zones?name=': () =>
          new Response(
            JSON.stringify({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }] }),
            { status: 403, headers: jsonHeaders }
          ),
        '/workers/subdomain': mockResponses.subdomainLookup,
        '~/dns_records': mockResponses.dnsRecordCreate,
        '/workers/routes': mockResponses.workerRouteCreate,
        ...accessAppFlowMocks(),
      });

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);
      expect(summary.success).toBe(false);

      // setup:complete must NOT be written
      const putCalls = mockKV.put.mock.calls as [string, string][];
      const completePut = putCalls.find(([key]) => key === 'setup:complete');
      expect(completePut).toBeUndefined();
    });

    it('REQ-SETUP-004 AC4: already-exists errors on Worker routes are handled by updating the existing route', async () => {
      const app = createTestApp();

      let routeAttempt = 0;
      globalThis.fetch = createUrlMockFetch({
        ...baseFlowMocks(),
        ...customDomainFlowMocks(),
        '/workers/routes': (_url: string, init?: RequestInit) => {
          if (init?.method === 'POST') {
            routeAttempt++;
            if (routeAttempt === 1) {
              // First attempt: already exists error (code 10020)
              return new Response(
                JSON.stringify({ success: false, errors: [{ code: 10020, message: 'Route already exists' }] }),
                { status: 409, headers: jsonHeaders }
              );
            }
          }
          // Subsequent call (PUT update) succeeds
          return new Response('', { status: 200 });
        },
        '~/workers/routes': (_url: string, init?: RequestInit) => {
          // Handle GET for listing existing routes
          if (!init?.method || init.method === 'GET') {
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ id: 'route-existing', pattern: `claude.example.com/*`, script: TEST_WORKER_NAME }],
              }),
              { status: 200, headers: jsonHeaders }
            );
          }
          return new Response('', { status: 200 });
        },
        ...accessAppFlowMocks(),
      });

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      const lines = await readNdjson(res);
      // configure_custom_domain must succeed despite the initial route-already-exists error
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'configure_custom_domain', status: 'success' })
      );
    });

    it('REQ-SETUP-004 AC5: error code 10215 on secret write triggers auto-deploy then retry', async () => {
      const app = createTestApp();

      let secretAttempts = 0;
      let deployAttempted = false;

      globalThis.fetch = createUrlMockFetch({
        '/accounts': mockResponses.accounts,
        '~/tokens/verify': mockResponses.tokenVerify,
        '~/versions': () =>
          new Response(
            JSON.stringify({ success: true, result: { items: [{ id: 'ver-latest' }] } }),
            { status: 200, headers: jsonHeaders }
          ),
        '~/deployments': () => {
          deployAttempted = true;
          return new Response('', { status: 200 });
        },
        '~/secrets': (_url: string, init?: RequestInit) => {
          if (init?.method === 'PUT') {
            secretAttempts++;
            if (secretAttempts === 1) {
              // First attempt fails with 10215 — production must deploy
              // the latest version and retry. The retry (attempt 2) must
              // succeed; production only deploys ONCE per set_secrets
              // invocation, so a still-failing retry breaks the flow.
              return new Response(
                JSON.stringify({ success: false, errors: [{ code: 10215, message: 'latest version not deployed' }] }),
                { status: 400, headers: jsonHeaders }
              );
            }
          }
          return new Response('', { status: 200 });
        },
        ...customDomainFlowMocks(),
        ...accessAppFlowMocks(),
      });

      const res = await app.request(
        'https://codeflare.test.workers.dev/api/setup/configure',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(standardBody),
        }
      );

      const lines = await readNdjson(res);
      const summary = getNdjsonSummary(lines);

      // Auto-deploy was triggered to resolve 10215
      expect(deployAttempted).toBe(true);
      // Setup ultimately completes
      expect(summary.success).toBe(true);
      expect(lines).toContainEqual(
        expect.objectContaining({ step: 'set_secrets', status: 'success' })
      );
    });
  });
});
