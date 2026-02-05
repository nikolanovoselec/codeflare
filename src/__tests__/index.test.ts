import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types';

// Create a minimal Hono app to use as mock route default export
const mockHonoApp = new Hono();

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
import worker, { resetSetupCache } from '../index';
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
    DEV_MODE: 'false',
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
    resetSetupCache();

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

  it('serves SPA at / when setup is complete and onboarding landing is active (unauthenticated)', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    env.ONBOARDING_LANDING_PAGE = 'active';
    mockKV.get.mockResolvedValue('true');

    const request = new Request('https://example.com/');
    const response = await worker.fetch(request, env, createMockCtx());

    // SPA is served via ASSETS (the OnboardingLanding component renders in-browser)
    expect(response.status).toBe(200);
    expect(mockAssets.fetch).toHaveBeenCalled();
  });

  it('serves SPA assets for /app when setup is complete', async () => {
    const { env, mockKV, mockAssets } = createMockEnv();
    mockKV.get.mockResolvedValue('true');

    const request = new Request('https://example.com/app');
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).toBe(200);
    expect(mockAssets.fetch).toHaveBeenCalled();
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
    resetSetupCache();

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
    resetSetupCache();
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
