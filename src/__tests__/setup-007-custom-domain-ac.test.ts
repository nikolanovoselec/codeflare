/**
 * AC-coverage tests for REQ-SETUP-007: Custom domain with DNS validation.
 *
 * ACs covered:
 *   AC1: Zone resolution tries progressively shorter suffixes (supports ccTLDs like .co.uk)
 *   AC2: Proxied CNAME record created/updated pointing to {workerName}.{subdomain}.workers.dev
 *   AC3: Worker route pattern {customDomain}/* created and mapped to the worker script
 *   AC4: Already-exists errors on Worker routes handled by updating the existing route
 *   AC5: Custom domain stored in KV as setup:custom_domain (lowercased)
 *   AC6: Dynamic origins cached in-memory for 5 minutes with KV as source of truth
 *   AC7: Post-setup workers.dev URL used only for initial setup; traffic routes via custom domain
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
import { isAllowedOrigin, resetCorsOriginsCache } from '../lib/cors-cache';

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
  if (!summary) throw new Error('No summary line in NDJSON');
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
      status: 200, headers: jsonHeaders,
    }),
  tokenVerify: () =>
    new Response(JSON.stringify({ success: true, result: { id: 'r2-key-id', status: 'active' } }), {
      status: 200, headers: jsonHeaders,
    }),
  secretPut: () => new Response('', { status: 200 }),
  zoneLookup: () =>
    new Response(JSON.stringify({ success: true, result: [{ id: 'zone123' }] }), {
      status: 200, headers: jsonHeaders,
    }),
  zoneNotFound: () =>
    new Response(JSON.stringify({ success: true, result: [] }), {
      status: 200, headers: jsonHeaders,
    }),
  subdomainLookup: () =>
    new Response(JSON.stringify({ success: true, result: { subdomain: 'test-account' } }), {
      status: 200, headers: jsonHeaders,
    }),
  dnsRecordLookupEmpty: () =>
    new Response(JSON.stringify({ success: true, result: [] }), { status: 200, headers: jsonHeaders }),
  dnsRecordCreate: () => new Response('', { status: 200 }),
  workerRouteCreate: () => new Response('', { status: 200 }),
  accessAppsLookupEmpty: () =>
    new Response(JSON.stringify({ success: true, result: [] }), { status: 200, headers: jsonHeaders }),
  accessAppCreate: () =>
    new Response(JSON.stringify({ success: true, result: { id: 'app123' } }), {
      status: 200, headers: jsonHeaders,
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

const standardBody = {
  customDomain: 'claude.example.com',
  allowedUsers: ['user@example.com'],
  adminUsers: ['user@example.com'],
};

describe('REQ-SETUP-007: Custom domain with DNS validation', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
    resetAuthConfigCache();
    resetCorsOriginsCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCorsOriginsCache();
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

  it('REQ-SETUP-007 AC1: zone resolution tries progressively shorter domain suffixes to support ccTLDs', async () => {
    const app = createTestApp();

    // Use a ccTLD domain: api.myapp.co.uk
    // Zone resolution should try: api.myapp.co.uk -> myapp.co.uk -> co.uk -> uk
    // returning the zone on the second attempt (myapp.co.uk)
    const zoneQueryUrls: string[] = [];
    globalThis.fetch = createUrlMockFetch({
      ...baseFlowMocks(),
      '/zones?name=': (url: string) => {
        zoneQueryUrls.push(url);
        // Anchor on full name= to avoid 'myapp.co.uk' matching 'co.uk'.
        // Order of attempts: api.myapp.co.uk, myapp.co.uk, co.uk, uk.
        if (
          url.includes('name=api.myapp.co.uk') ||
          url.includes('name=co.uk') ||
          url.includes('name=uk')
        ) {
          return mockResponses.zoneNotFound();
        }
        // name=myapp.co.uk hits this branch.
        return mockResponses.zoneLookup();
      },
      '/workers/subdomain': mockResponses.subdomainLookup,
      '~/dns_records': (_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') return mockResponses.dnsRecordLookupEmpty();
        return mockResponses.dnsRecordCreate();
      },
      '/workers/routes': mockResponses.workerRouteCreate,
      ...accessAppFlowMocks(),
    });

    const res = await app.request(
      'https://codeflare.test.workers.dev/api/setup/configure',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...standardBody,
          customDomain: 'api.myapp.co.uk',
        }),
      }
    );

    const lines = await readNdjson(res);
    const summary = getNdjsonSummary(lines);
    expect(summary.success).toBe(true);

    // Zone resolution must have queried multiple suffixes (progressively shorter)
    expect(zoneQueryUrls.length).toBeGreaterThan(1);
  });

  it('REQ-SETUP-007 AC2: proxied CNAME record is created pointing custom domain to workers.dev target', async () => {
    const app = createTestApp();

    globalThis.fetch = createUrlMockFetch({
      ...baseFlowMocks(),
      '/zones?name=': mockResponses.zoneLookup,
      '/workers/subdomain': mockResponses.subdomainLookup,
      '~/dns_records': (_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') return mockResponses.dnsRecordLookupEmpty();
        return mockResponses.dnsRecordCreate();
      },
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

    await readNdjson(res);

    const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
    const dnsCreateCall = mockFetch.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('/dns_records') &&
        (call[1] as RequestInit)?.method === 'POST'
    );
    expect(dnsCreateCall).toBeDefined();

    const dnsBody = JSON.parse(
      (dnsCreateCall![1] as RequestInit).body as string
    ) as { type: string; proxied: boolean; content: string };

    // Must be a proxied CNAME
    expect(dnsBody.type).toBe('CNAME');
    expect(dnsBody.proxied).toBe(true);
    // Content points to the workers.dev subdomain
    expect(dnsBody.content).toContain('workers.dev');
  });

  it('REQ-SETUP-007 AC3: Worker route pattern {customDomain}/* is created mapped to the worker script', async () => {
    const app = createTestApp();

    globalThis.fetch = createUrlMockFetch({
      ...baseFlowMocks(),
      '/zones?name=': mockResponses.zoneLookup,
      '/workers/subdomain': mockResponses.subdomainLookup,
      '~/dns_records': (_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') return mockResponses.dnsRecordLookupEmpty();
        return mockResponses.dnsRecordCreate();
      },
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

    await readNdjson(res);

    const mockFetch = globalThis.fetch as ReturnType<typeof createUrlMockFetch>;
    const routeCreateCall = mockFetch.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).endsWith('/workers/routes') &&
        (call[1] as RequestInit)?.method === 'POST'
    );
    expect(routeCreateCall).toBeDefined();

    const routeBody = JSON.parse(
      (routeCreateCall![1] as RequestInit).body as string
    ) as { pattern: string; script: string };

    // Pattern must include the custom domain and /* wildcard
    expect(routeBody.pattern).toContain('claude.example.com');
    expect(routeBody.pattern).toContain('/*');
    // Script name must match the worker
    expect(routeBody.script).toBe(TEST_WORKER_NAME);
  });

  it('REQ-SETUP-007 AC4: already-exists errors on Worker routes are handled by updating the existing route', async () => {
    const app = createTestApp();

    globalThis.fetch = createUrlMockFetch({
      ...baseFlowMocks(),
      '/zones?name=': mockResponses.zoneLookup,
      '/workers/subdomain': mockResponses.subdomainLookup,
      '~/dns_records': (_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') return mockResponses.dnsRecordLookupEmpty();
        return mockResponses.dnsRecordCreate();
      },
      // POST to /workers/routes returns already-exists; GET lists the existing route
      '~/workers/routes': (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Response(
            JSON.stringify({ success: false, errors: [{ code: 10020, message: 'Route already exists' }] }),
            { status: 409, headers: jsonHeaders }
          );
        }
        if (!init?.method || init.method === 'GET') {
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ id: 'route-existing-123', pattern: 'claude.example.com/*', script: TEST_WORKER_NAME }],
            }),
            { status: 200, headers: jsonHeaders }
          );
        }
        // PUT update
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
    // configure_custom_domain must succeed despite route-already-exists
    expect(lines).toContainEqual(
      expect.objectContaining({ step: 'configure_custom_domain', status: 'success' })
    );
    const summary = getNdjsonSummary(lines);
    expect(summary.success).toBe(true);
  });

  it('REQ-SETUP-007 AC5: custom domain is stored in KV as setup:custom_domain (lowercased)', async () => {
    const app = createTestApp();

    globalThis.fetch = createUrlMockFetch({
      ...baseFlowMocks(),
      '/zones?name=': mockResponses.zoneLookup,
      '/workers/subdomain': mockResponses.subdomainLookup,
      '~/dns_records': (_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') return mockResponses.dnsRecordLookupEmpty();
        return mockResponses.dnsRecordCreate();
      },
      '/workers/routes': mockResponses.workerRouteCreate,
      ...accessAppFlowMocks(),
    });

    // Submit with mixed-case domain - production lowercases it per RFC 4343
    const res = await app.request(
      'https://codeflare.test.workers.dev/api/setup/configure',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...standardBody, customDomain: 'Claude.Example.COM' }),
      }
    );

    await readNdjson(res);

    // The KV key setup:custom_domain must hold the lowercased value
    expect(mockKV.put).toHaveBeenCalledWith('setup:custom_domain', 'claude.example.com');
  });

  it('REQ-SETUP-007 AC6: dynamic origins from KV are cached in-memory for 5 minutes (no KV re-read within TTL)', async () => {
    // Seed the KV store directly (simulating post-setup state)
    mockKV._store.set('setup:custom_domain', 'claude.example.com');

    const env = {
      KV: mockKV as unknown as KVNamespace,
      ALLOWED_ORIGINS: '.workers.dev',
    } as unknown as Env;

    // First call reads KV
    const result1 = await isAllowedOrigin('https://claude.example.com', env);
    expect(result1).toBe(true);
    const kvReadCount1 = mockKV.get.mock.calls.length;

    // Second call within TTL window must NOT re-read KV (cache hit)
    const result2 = await isAllowedOrigin('https://claude.example.com', env);
    expect(result2).toBe(true);
    const kvReadCount2 = mockKV.get.mock.calls.length;

    // Cache served the second call - no additional KV reads
    expect(kvReadCount2).toBe(kvReadCount1);
  });

  it('REQ-SETUP-007 AC6: resetCorsOriginsCache forces KV re-read on next request', async () => {
    mockKV._store.set('setup:custom_domain', 'claude.example.com');

    const env = {
      KV: mockKV as unknown as KVNamespace,
      ALLOWED_ORIGINS: '.workers.dev',
    } as unknown as Env;

    // Prime the cache
    await isAllowedOrigin('https://claude.example.com', env);
    const kvReadCount1 = mockKV.get.mock.calls.length;

    // Cache invalidated (as happens post-setup via resetSetupCache)
    resetCorsOriginsCache();

    // Next call must re-read KV
    await isAllowedOrigin('https://claude.example.com', env);
    const kvReadCount2 = mockKV.get.mock.calls.length;

    expect(kvReadCount2).toBeGreaterThan(kvReadCount1);
  });

  it('REQ-SETUP-007 AC7: configure response includes both workersDevUrl and customDomainUrl', async () => {
    // AC7: workers.dev URL for initial setup only; custom domain is the target
    const app = createTestApp();

    globalThis.fetch = createUrlMockFetch({
      ...baseFlowMocks(),
      '/zones?name=': mockResponses.zoneLookup,
      '/workers/subdomain': mockResponses.subdomainLookup,
      '~/dns_records': (_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === 'GET') return mockResponses.dnsRecordLookupEmpty();
        return mockResponses.dnsRecordCreate();
      },
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

    // Both URLs are returned so the caller knows which is which
    expect(typeof summary.workersDevUrl).toBe('string');
    expect(typeof summary.customDomainUrl).toBe('string');
    // workers.dev URL is distinct from custom domain URL
    expect(summary.workersDevUrl).toContain('workers.dev');
    expect(summary.customDomainUrl).toBe('https://claude.example.com');
  });
});
