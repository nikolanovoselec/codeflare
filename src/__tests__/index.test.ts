import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types';

// Create a minimal Hono app to use as mock route default export
const _mockHonoApp = new Hono();

// Mock all route modules to prevent import side effects and provide valid Hono apps
vi.mock('../routes/terminal', () => ({
  default: new Hono(),
  validateWebSocketRoute: vi.fn(() => ({ isWebSocketRoute: false })),
  handleWebSocketUpgrade: vi.fn(),
}));
vi.mock('../routes/user', () => ({ default: new Hono() }));
vi.mock('../routes/container/index', () => ({ default: new Hono() }));
vi.mock('../routes/session/index', () => ({ default: new Hono() }));
vi.mock('../routes/setup', () => {
  const app = new Hono();
  // Provide a minimal /status endpoint so tests for /api/setup/status work
  app.get('/status', (c) => c.json({ configured: false }));
  return { default: app };
});
vi.mock('../routes/admin', () => ({ default: new Hono() }));

// Import after mocks are set up
import worker from '../index';
import { resetSetupCache as resetSetupCacheShared } from '../lib/cache-reset';
import { validateWebSocketRoute, handleWebSocketUpgrade } from '../routes/terminal';
import { createMockKV } from './helpers/mock-kv';

function createMockEnv(): { env: Env; mockKV: ReturnType<typeof createMockKV>; mockAssets: { fetch: ReturnType<typeof vi.fn> } } {
  const mockKV = createMockKV();
  const mockAssets = {
    fetch: vi.fn(async () => new Response('SPA content', { status: 200 })),
  };

  const env = {
    KV: mockKV as unknown as KVNamespace,
    ASSETS: mockAssets as unknown as Fetcher,
    ONBOARDING_LANDING_PAGE: 'inactive',
  } as Env;

  return { env, mockKV, mockAssets };
}

function createMockCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('Edge-level setup redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the in-memory cache before each test
    resetSetupCacheShared();

    // Reset the terminal mock to default (not a WebSocket route)
    vi.mocked(validateWebSocketRoute).mockReturnValue({ isWebSocketRoute: false });
  });

  it('redirects GET / to /setup when setup:complete is not set in KV', async () => {
    const { env, mockKV } = createMockEnv();
    mockKV.get.mockResolvedValue(null);

    const request = new Request('https://example.com/');
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/setup');
  });

  it('does NOT redirect GET /setup (no redirect loop)', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    mockKV.get.mockResolvedValue(null);

    const request = new Request('https://example.com/setup');
    const response = await worker.fetch(request, env, createMockCtx());

    // Should pass through to ASSETS, not redirect
    expect(response.status).toBe(200);
    expect(mockAssets.fetch).toHaveBeenCalled();
  });

  it('does NOT redirect GET /api/health', async () => {
    const { env, mockKV } = createMockEnv();
    mockKV.get.mockResolvedValue(null);

    const request = new Request('https://example.com/api/health');
    const response = await worker.fetch(request, env, createMockCtx());

    // API routes go through Hono, not redirected
    expect(response.status).not.toBe(302);
    // /api/health returns JSON from Hono
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  it('does NOT redirect GET /api/setup/status', async () => {
    const { env, mockKV } = createMockEnv();
    mockKV.get.mockResolvedValue(null);

    const request = new Request('https://example.com/api/setup/status');
    const response = await worker.fetch(request, env, createMockCtx());

    // API routes go through Hono, not redirected
    expect(response.status).not.toBe(302);
    expect(response.status).toBe(200);
  });

  it('redirects GET / to /app when setup is complete and onboarding landing is inactive', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    mockKV.get.mockResolvedValue('true');

    const request = new Request('https://example.com/');
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/app/');
    expect(mockAssets.fetch).not.toHaveBeenCalled();
  });

  it('REQ-LANDING-001: serves the static landing at / when onboarding mode is active (unauthenticated)', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    env.ONBOARDING_LANDING_PAGE = 'active';
    mockKV.get.mockResolvedValue('true');

    const request = new Request('https://example.com/');
    const response = await worker.fetch(request, env, createMockCtx());

    // The request is rewritten to the prerendered landing app in assets.
    // (If the landing build is absent, SPA not_found_handling falls back to
    // the OnboardingLanding component — same 200 path.)
    expect(response.status).toBe(200);
    const fetchedRequest = mockAssets.fetch.mock.calls[0][0] as Request;
    expect(new URL(fetchedRequest.url).pathname).toBe('/landing/');
  });

  it('REQ-LANDING-001: serves the static landing at / in SaaS mode (unauthenticated)', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    env.SAAS_MODE = 'active';
    mockKV.get.mockResolvedValue('true');

    const request = new Request('https://example.com/');
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).toBe(200);
    const fetchedRequest = mockAssets.fetch.mock.calls[0][0] as Request;
    expect(new URL(fetchedRequest.url).pathname).toBe('/landing/');
  });

  it('REQ-LANDING-001: keeps redirecting / to /app in default mode (no landing)', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    mockKV.get.mockResolvedValue('true');

    const response = await worker.fetch(new Request('https://example.com/'), env, createMockCtx());

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/app/');
    expect(mockAssets.fetch).not.toHaveBeenCalled();
  });

  it('serves SPA assets for /app when setup is complete', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    mockKV.get.mockResolvedValue('true');

    const request = new Request('https://example.com/app');
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).toBe(200);
    expect(mockAssets.fetch).toHaveBeenCalled();
  });

  // REQ-LANDING-003: discoverability documents served at the deployment root,
  // mode-aware (public marketing surface advertises indexable docs; private
  // app deployments disallow all crawling and expose no sitemap/llms).
  it('REQ-LANDING-003: serves an indexable robots.txt with the sitemap in a public mode', async () => {
    const { env, mockAssets } = createMockEnv();
    env.SAAS_MODE = 'active';

    const response = await worker.fetch(new Request('https://example.com/robots.txt'), env, createMockCtx());

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    const body = await response.text();
    expect(body).toContain('Allow: /');
    expect(body).toContain('Sitemap: https://codeflare.ch/sitemap.xml');
    // Served before the setup gate and without touching the SPA assets.
    expect(mockAssets.fetch).not.toHaveBeenCalled();
  });

  it('REQ-LANDING-003: serves a disallow-all robots.txt with no sitemap in a private (default) mode', async () => {
    const { env } = createMockEnv();
    // Neither SaaS nor onboarding: a private app deployment.

    const response = await worker.fetch(new Request('https://example.com/robots.txt'), env, createMockCtx());

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Disallow: /');
    expect(body).not.toContain('Sitemap:');
  });

  it('REQ-LANDING-003: serves sitemap.xml + llms.txt in a public mode and 404s them in a private mode', async () => {
    const { env } = createMockEnv();
    env.ONBOARDING_LANDING_PAGE = 'active';

    const sitemap = await worker.fetch(new Request('https://example.com/sitemap.xml'), env, createMockCtx());
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('Content-Type')).toContain('application/xml');
    expect(await sitemap.text()).toContain('<loc>https://codeflare.ch/</loc>');

    const llms = await worker.fetch(new Request('https://example.com/llms.txt'), env, createMockCtx());
    expect(llms.status).toBe(200);
    expect(await llms.text()).toMatch(/^# Codeflare/);

    // Private deployment: the marketing-only documents do not exist.
    const { env: privateEnv } = createMockEnv();
    const sitemap404 = await worker.fetch(new Request('https://example.com/sitemap.xml'), privateEnv, createMockCtx());
    expect(sitemap404.status).toBe(404);
    const llms404 = await worker.fetch(new Request('https://example.com/llms.txt'), privateEnv, createMockCtx());
    expect(llms404.status).toBe(404);
  });

  it('does NOT affect WebSocket upgrade requests', async () => {
    const { env, mockKV } = createMockEnv();
    mockKV.get.mockResolvedValue(null);

    // Mock WebSocket route handling - use 200 since Workers runtime doesn't allow 101
    // In real Workers, WebSocket upgrades return 101 via the runtime, but mocks use 200
    const wsResponse = new Response(null, { status: 200 });
    vi.mocked(validateWebSocketRoute).mockReturnValue({
      isWebSocketRoute: true,
      errorResponse: undefined,
    } as ReturnType<typeof validateWebSocketRoute>);
    vi.mocked(handleWebSocketUpgrade).mockResolvedValue(wsResponse);

    const request = new Request('https://example.com/api/terminal/abc123-1/ws', {
      headers: { Upgrade: 'websocket' },
    });
    const response = await worker.fetch(request, env, createMockCtx());

    // WebSocket route was detected and handled (not redirected to /setup)
    expect(response.status).toBe(200);
    expect(handleWebSocketUpgrade).toHaveBeenCalled();
    // KV should NOT have been checked since WebSocket is handled before redirect logic
    expect(mockKV.get).not.toHaveBeenCalled();
  });

  it('caches setup status in memory after first KV check', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    mockKV.get.mockResolvedValue('true');

    const ctx = createMockCtx();

    // First request - should hit KV
    await worker.fetch(new Request('https://example.com/'), env, ctx);
    expect(mockKV.get).toHaveBeenCalledTimes(1);

    // Second request - should use cached value, not hit KV again
    await worker.fetch(new Request('https://example.com/app'), env, ctx);
    expect(mockKV.get).toHaveBeenCalledTimes(1);

    // Root path redirects, /app serves assets
    expect(mockAssets.fetch).toHaveBeenCalledTimes(1);
  });

  it('resetSetupCache clears the in-memory cache', async () => {
    const { env, mockKV } = createMockEnv();
    // First: setup complete
    mockKV.get.mockResolvedValue('true');

    const ctx = createMockCtx();
    await worker.fetch(new Request('https://example.com/'), env, ctx);
    expect(mockKV.get).toHaveBeenCalledTimes(1);

    // Reset cache
    resetSetupCacheShared();

    // Now setup is NOT complete
    mockKV.get.mockResolvedValue(null);
    const response = await worker.fetch(new Request('https://example.com/'), env, ctx);

    // Should have checked KV again and redirected
    expect(mockKV.get).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/setup');
  });

  it('shared cache reset (used by setup route) also clears edge setup redirect cache', async () => {
    const { env, mockKV } = createMockEnv();
    const ctx = createMockCtx();

    // First request caches "not configured"
    mockKV.get.mockResolvedValueOnce(null);
    const first = await worker.fetch(new Request('https://example.com/'), env, ctx);
    expect(first.status).toBe(302);
    expect(first.headers.get('Location')).toBe('/setup');
    expect(mockKV.get).toHaveBeenCalledTimes(1);

    // Simulate setup completion + shared cache reset from /api/setup/configure
    resetSetupCacheShared();
    mockKV.get.mockResolvedValueOnce('true');

    const second = await worker.fetch(new Request('https://example.com/'), env, ctx);
    expect(second.status).toBe(302);
    expect(second.headers.get('Location')).toBe('/app/');
    expect(mockKV.get).toHaveBeenCalledTimes(2);
  });

  it('does NOT redirect GET /health', async () => {
    const { env, mockKV } = createMockEnv();
    mockKV.get.mockResolvedValue(null);

    const request = new Request('https://example.com/health');
    const response = await worker.fetch(request, env, createMockCtx());

    // /health goes through Hono, not redirected
    expect(response.status).not.toBe(302);
    expect(response.status).toBe(200);
  });

  it('redirects non-setup SPA paths when setup is not complete', async () => {
    const { env, mockKV } = createMockEnv();
    mockKV.get.mockResolvedValue(null);

    const request = new Request('https://example.com/app');
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/setup');
  });

  it('does NOT redirect paths starting with /setup (subpaths)', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    mockKV.get.mockResolvedValue(null);

    const request = new Request('https://example.com/setup/step-2');
    const response = await worker.fetch(request, env, createMockCtx());

    // Should pass through to ASSETS, not redirect
    expect(response.status).toBe(200);
    expect(mockAssets.fetch).toHaveBeenCalled();
  });
});

// ============================================================================
// X-Request-ID Validation (S5-07)
// ============================================================================
describe('X-Request-ID validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSetupCacheShared();
    vi.mocked(validateWebSocketRoute).mockReturnValue({ isWebSocketRoute: false });
  });

  it('passes through a valid X-Request-ID unchanged', async () => {
    const { env } = createMockEnv();

    const request = new Request('https://example.com/api/health', {
      headers: { 'X-Request-ID': 'abc-123_XYZ' },
    });
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.headers.get('X-Request-ID')).toBe('abc-123_XYZ');
  });

  it('generates a new ID when X-Request-ID contains invalid characters', async () => {
    const { env } = createMockEnv();

    const request = new Request('https://example.com/api/health', {
      headers: { 'X-Request-ID': '<script>alert(1)</script>' },
    });
    const response = await worker.fetch(request, env, createMockCtx());

    const requestId = response.headers.get('X-Request-ID');
    expect(requestId).not.toBe('<script>alert(1)</script>');
    expect(requestId).toBeDefined();
    expect(requestId!.length).toBeGreaterThan(0);
  });

  it('generates a new ID when X-Request-ID is missing', async () => {
    const { env } = createMockEnv();

    const request = new Request('https://example.com/api/health');
    const response = await worker.fetch(request, env, createMockCtx());

    const requestId = response.headers.get('X-Request-ID');
    expect(requestId).toBeDefined();
    expect(requestId!.length).toBeGreaterThan(0);
  });

  it('rejects X-Request-ID longer than 64 characters', async () => {
    const { env } = createMockEnv();

    const longId = 'a'.repeat(65);
    const request = new Request('https://example.com/api/health', {
      headers: { 'X-Request-ID': longId },
    });
    const response = await worker.fetch(request, env, createMockCtx());

    const requestId = response.headers.get('X-Request-ID');
    expect(requestId).not.toBe(longId);
  });

  it('accepts valid IDs with hyphens and underscores', async () => {
    const { env } = createMockEnv();

    const validId = 'req_abc-DEF_123';
    const request = new Request('https://example.com/api/health', {
      headers: { 'X-Request-ID': validId },
    });
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.headers.get('X-Request-ID')).toBe(validId);
  });
});

// CF-001 + REQ-OPS-008 AC6: STRESS_TEST_MODE must never be active alongside
// SAAS_MODE. Global middleware blocks the misconfiguration with a 503 before
// any route runs, so a downstream rate-limit bypass can't accidentally serve
// real users when both env vars are flipped on.
describe('REQ-OPS-008 AC6 (SAAS_MODE + STRESS_TEST_MODE conflict guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSetupCacheShared();
    vi.mocked(validateWebSocketRoute).mockReturnValue({ isWebSocketRoute: false });
  });

  it('returns 503 with misconfiguration message when both SAAS_MODE and STRESS_TEST_MODE are active', async () => {
    const { env } = createMockEnv();
    env.SAAS_MODE = 'active';
    env.STRESS_TEST_MODE = 'active';

    const request = new Request('https://example.com/api/health');
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).toBe(503);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/stress test mode/i);
    expect(body.error).toMatch(/SaaS production|saas production|cannot be active/i);
  });

  it('allows the request through when SAAS_MODE is active but STRESS_TEST_MODE is unset (only SaaS)', async () => {
    const { env, mockKV } = createMockEnv();
    env.SAAS_MODE = 'active';
    // STRESS_TEST_MODE intentionally omitted
    mockKV.get.mockResolvedValue('done');

    const request = new Request('https://example.com/api/health');
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).not.toBe(503);
  });

  it('allows the request through when STRESS_TEST_MODE is active but SAAS_MODE is unset (only stress)', async () => {
    const { env, mockKV } = createMockEnv();
    env.STRESS_TEST_MODE = 'active';
    // SAAS_MODE intentionally omitted
    mockKV.get.mockResolvedValue('done');

    const request = new Request('https://example.com/api/health');
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).not.toBe(503);
  });

  it('does NOT block when both env vars are present but neither equals literal "active" (string comparison only)', async () => {
    const { env, mockKV } = createMockEnv();
    env.SAAS_MODE = 'true';
    env.STRESS_TEST_MODE = 'true';
    mockKV.get.mockResolvedValue('done');

    const request = new Request('https://example.com/api/health');
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).not.toBe(503);
  });
});

// ============================================================================
// REQ-LANDING-004: immutable caching for content-hashed build assets
// ============================================================================
describe('REQ-LANDING-004: immutable /_astro/ asset caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSetupCacheShared();
    vi.mocked(validateWebSocketRoute).mockReturnValue({ isWebSocketRoute: false });
  });

  it('serves content-hashed /_astro/ assets with a long immutable Cache-Control', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    // Setup complete so the request reaches the asset layer instead of redirecting.
    mockKV.get.mockResolvedValue('true');
    // A real hashed asset resolves to its own content type (here CSS), not the SPA shell.
    mockAssets.fetch.mockResolvedValueOnce(
      new Response('body{}', { status: 200, headers: { 'Content-Type': 'text/css' } }),
    );

    const response = await worker.fetch(
      new Request('https://example.com/landing/_astro/index.DEADBEEF.css'),
      env,
      createMockCtx(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('does NOT immutable-cache the SPA fallback HTML served for a non-existent /_astro/ URL', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    mockKV.get.mockResolvedValue('true');
    // not_found_handling = "single-page-application": a missing hashed asset resolves
    // to index.html (text/html, 200) — it must NOT be cached forever-immutable.
    mockAssets.fetch.mockResolvedValueOnce(
      new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    );

    const response = await worker.fetch(
      new Request('https://example.com/landing/_astro/missing.OLDHASH.js'),
      env,
      createMockCtx(),
    );

    expect(response.headers.get('Cache-Control')).not.toBe('public, max-age=31536000, immutable');
  });

  it('does NOT mark a non-hashed asset immutable (HTML/other keep the revalidating default)', async () => {
    const { env, mockKV } = createMockEnv();
    mockKV.get.mockResolvedValue('true');

    const response = await worker.fetch(
      new Request('https://example.com/favicon.svg'),
      env,
      createMockCtx(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).not.toBe('public, max-age=31536000, immutable');
  });
});
