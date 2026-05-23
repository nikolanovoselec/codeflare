/**
 * Security-gap tests for REQ-SEC-008: Security headers on every response
 *
 * The existing redirect-with-headers.test.ts covers redirectWithHeaders() in isolation.
 * This file covers the global Hono middleware path — verifying that SECURITY_HEADERS
 * are applied by the request-tracing middleware on real HTTP responses from the worker.
 *
 *   REQ-SEC-008 AC1  — Strict-Transport-Security present on all responses
 *   REQ-SEC-008 AC2  — Content-Security-Policy is set
 *   REQ-SEC-008 AC3  — X-Content-Type-Options: nosniff
 *   REQ-SEC-008 AC4  — X-Frame-Options: DENY
 *   REQ-SEC-008 AC5  — Referrer-Policy: strict-origin-when-cross-origin
 *   REQ-SEC-008 AC6  — Permissions-Policy is set
 *   REQ-SEC-008 AC7  — X-Powered-By is absent
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock all heavy route modules so import of index.ts is fast and side-effect-free
vi.mock('../../routes/terminal', () => ({
  default: new Hono(),
  validateWebSocketRoute: vi.fn(() => ({ isWebSocketRoute: false })),
  handleWebSocketUpgrade: vi.fn(),
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

import worker from '../../index';

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

describe('REQ-SEC-008: Security headers on every worker response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Use GET /health — a public endpoint that always returns 200 without auth
  async function fetchHealth() {
    const { env, ctx } = createBaseEnv();
    return worker.fetch(new Request('https://example.com/health'), env, ctx);
  }

  it('REQ-SEC-008 AC1: Strict-Transport-Security is present on all responses', async () => {
    const res = await fetchHealth();
    const hsts = res.headers.get('Strict-Transport-Security');
    expect(hsts).not.toBeNull();
    expect(hsts).toContain('max-age=');
    expect(hsts).toContain('includeSubDomains');
  });

  it('REQ-SEC-008 AC2: Content-Security-Policy is set', async () => {
    const res = await fetchHealth();
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).not.toBeNull();
    expect(csp!.length).toBeGreaterThan(0);
  });

  it('REQ-SEC-008 AC3: X-Content-Type-Options is "nosniff"', async () => {
    const res = await fetchHealth();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('REQ-SEC-008 AC4: X-Frame-Options is "DENY"', async () => {
    const res = await fetchHealth();
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('REQ-SEC-008 AC5: Referrer-Policy is "strict-origin-when-cross-origin"', async () => {
    const res = await fetchHealth();
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('REQ-SEC-008 AC6: Permissions-Policy is set', async () => {
    const res = await fetchHealth();
    const pp = res.headers.get('Permissions-Policy');
    expect(pp).not.toBeNull();
    expect(pp!.length).toBeGreaterThan(0);
  });

  it('REQ-SEC-008 AC7: X-Powered-By header is absent', async () => {
    const res = await fetchHealth();
    expect(res.headers.get('X-Powered-By')).toBeNull();
  });

  it('REQ-SEC-008 AC1/AC8: HSTS is present on redirect responses', async () => {
    // GET / with setup not complete triggers a redirect — verify HSTS on that 302
    const { env, ctx } = createBaseEnv();
    const res = await worker.fetch(new Request('https://example.com/'), env, ctx);
    // May be 302 (redirect to /setup) or 200; in both cases HSTS must be present
    const hsts = res.headers.get('Strict-Transport-Security');
    expect(hsts).not.toBeNull();
    expect(hsts).toContain('max-age=');
  });
});
