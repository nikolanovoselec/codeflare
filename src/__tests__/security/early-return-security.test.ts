/**
 * Security-gap tests for the module-level fetch boundary in src/index.ts.
 *
 * These cover the early returns that bypass Hono's post-handler middleware:
 *   CF-001 - vault/terminal early-return responses must carry SECURITY_HEADERS,
 *            and a 101 WebSocket upgrade must NOT (it cannot carry them).
 *   CF-003 - X-Vault-Csrf must be in the CORS Access-Control-Allow-Headers list.
 *   CF-004 - an over-cap body to /public/stripe/* must be rejected by bodyLimit.
 *
 * The vault and terminal route helpers are mocked so we can drive the exact
 * early-return path under test from index.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Controllable terminal route mock: tests flip these between cases.
const wsRouteState = vi.hoisted(() => ({
  validate: undefined as unknown,
  upgrade: undefined as unknown,
}));
const vaultRouteState = vi.hoisted(() => ({
  validate: undefined as unknown,
  request: undefined as unknown,
}));

vi.mock('../../routes/terminal', () => ({
  default: new Hono(),
  validateWebSocketRoute: (req: Request) =>
    (wsRouteState.validate as (r: Request) => unknown)?.(req) ?? { isWebSocketRoute: false },
  handleWebSocketUpgrade: (...args: unknown[]) =>
    (wsRouteState.upgrade as (...a: unknown[]) => unknown)?.(...args),
}));
vi.mock('../../routes/vault', () => ({
  default: new Hono(),
  validateVaultRoute: (req: Request) =>
    (vaultRouteState.validate as (r: Request) => unknown)?.(req) ?? { isVaultRoute: false },
  handleVaultRequest: (...args: unknown[]) =>
    (vaultRouteState.request as (...a: unknown[]) => unknown)?.(...args),
}));
vi.mock('../../routes/user-profile', () => ({ default: new Hono() }));
vi.mock('../../routes/container/index', () => ({ default: new Hono() }));
vi.mock('../../routes/session/index', () => ({ default: new Hono() }));
vi.mock('../../routes/setup/index', () => ({ default: new Hono() }));
vi.mock('../../routes/users', () => ({ default: new Hono() }));
vi.mock('../../routes/storage', () => ({ default: new Hono() }));
vi.mock('../../routes/presets', () => ({ default: new Hono() }));
vi.mock('../../routes/preferences', () => ({ default: new Hono() }));
vi.mock('../../routes/public/index', () => ({ default: new Hono() }));
// Stripe webhook route: a minimal handler so we can exercise the bodyLimit
// middleware mounted in front of it without invoking real signature logic.
vi.mock('../../routes/stripe-webhook', () => {
  const r = new Hono();
  r.post('/', (c) => c.json({ ok: true }));
  return { default: r };
});

import worker, { withSecurityHeaders } from '../../index';

function createMockCtx() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function createBaseEnv() {
  const mockKV = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  };
  return {
    env: { KV: mockKV } as unknown as Parameters<typeof worker.fetch>[1],
    ctx: createMockCtx(),
  };
}

describe('CF-001: security headers on pre-Hono early-return responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsRouteState.validate = undefined;
    wsRouteState.upgrade = undefined;
    vaultRouteState.validate = undefined;
    vaultRouteState.request = undefined;
  });

  // CF-001: vault early return carries the headers
  it('CF-001: a vault hand-built response carries SECURITY_HEADERS', async () => {
    vaultRouteState.validate = () => ({ isVaultRoute: true, remainingPath: '/index' });
    vaultRouteState.request = () =>
      new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } });

    const { env, ctx } = createBaseEnv();
    const res = await worker.fetch(new Request('https://example.com/api/vault/abcd1234/index'), env, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    // Proxied vault content must NOT carry the `default-src 'none'` CSP: it
    // serves SilverBullet's inline scripts/styles/workers, which that policy
    // blocks. A narrow frame-ancestors policy still prevents cross-site framing
    // while allowing the dashboard's same-origin hidden prewarm iframe.
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'");
  });

  // CF-001: vault validation errorResponse carries the headers
  it('CF-001: a vault validation errorResponse carries SECURITY_HEADERS', async () => {
    vaultRouteState.validate = () => ({
      isVaultRoute: true,
      errorResponse: new Response(JSON.stringify({ error: 'bad' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    const { env, ctx } = createBaseEnv();
    const res = await worker.fetch(new Request('https://example.com/api/vault/abcd1234/x'), env, ctx);

    expect(res.status).toBe(400);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).not.toBeNull();
  });

  // CF-001: terminal non-101 error response carries the headers
  it('CF-001: a terminal JSON error response carries SECURITY_HEADERS', async () => {
    wsRouteState.validate = () => ({ isWebSocketRoute: true });
    wsRouteState.upgrade = () =>
      new Response(JSON.stringify({ error: 'denied', code: 'FORBIDDEN' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });

    const { env, ctx } = createBaseEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/terminal/abcd1234/ws', { headers: { Upgrade: 'websocket' } }),
      env,
      ctx,
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
  });

  // CF-001: 101 WebSocket upgrade must NOT carry the headers (no-op path).
  // A real 101 Response cannot be built via the constructor in this runtime
  // (RangeError: status must be 200-599), so the 101 branch is verified by
  // calling the exported helper directly with a 101-shaped response.
  it('CF-001: withSecurityHeaders is a no-op for 101 WebSocket upgrade responses', () => {
    const upgrade = { status: 101, headers: new Headers() } as unknown as Response;
    const out = withSecurityHeaders(upgrade);

    expect(out).toBe(upgrade);
    expect(out.headers.get('X-Content-Type-Options')).toBeNull();
    expect(out.headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('CF-001: vault frame policy is applied even if upstream already set a security header', () => {
    const upstream = new Response('vault shell', {
      headers: { 'X-Content-Type-Options': 'nosniff' },
    });
    const res = withSecurityHeaders(upstream, { csp: false, frame: 'sameorigin' });

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'");
  });
});

describe('CF-003: CORS allow-headers include X-Vault-Csrf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultRouteState.validate = undefined;
    vaultRouteState.request = undefined;
    wsRouteState.validate = undefined;
    wsRouteState.upgrade = undefined;
  });

  // CF-003: preflight from an allowed origin advertises X-Vault-Csrf.
  // Use a *.workers.dev origin so it matches DEFAULT_ALLOWED_ORIGINS without
  // any dependency on the in-memory CORS cache or KV state.
  it('CF-003: OPTIONS preflight advertises X-Vault-Csrf in Access-Control-Allow-Headers', async () => {
    const { env, ctx } = createBaseEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/health', {
        method: 'OPTIONS',
        headers: { Origin: 'https://codeflare.workers.dev' },
      }),
      env,
      ctx,
    );

    const allowHeaders = res.headers.get('Access-Control-Allow-Headers');
    expect(allowHeaders).not.toBeNull();
    expect(allowHeaders).toContain('X-Vault-Csrf');
  });
});

describe('CF-004: stripe webhook is body-limited', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultRouteState.validate = undefined;
    vaultRouteState.request = undefined;
    wsRouteState.validate = undefined;
    wsRouteState.upgrade = undefined;
  });

  // CF-004: an over-cap (> 1 MiB) body to /public/stripe is rejected
  it('CF-004: an over-cap body to /public/stripe is rejected', async () => {
    const { env, ctx } = createBaseEnv();
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    const res = await worker.fetch(
      new Request('https://example.com/public/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversized,
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(413);
  });

  // CF-004: an at-cap body is accepted (the limit is not over-tight)
  it('CF-004: a small stripe body passes the bodyLimit', async () => {
    const { env, ctx } = createBaseEnv();
    const res = await worker.fetch(
      new Request('https://example.com/public/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ small: true }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
  });
});
