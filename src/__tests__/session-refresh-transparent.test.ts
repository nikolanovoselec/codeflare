/**
 * REQ-AUTH-008 AC3: The SaaS session-cookie refresh is transparent to the user
 * (no redirect, no re-authentication) within the TTL.
 *
 * The threshold + TTL mechanics are covered elsewhere (auth-gaps / session-jwt).
 * This file asserts the TRANSPARENT property end-to-end: a request carrying a
 * near-expiry but still-valid session cookie is served the resource (200), is
 * NOT redirected (no 302, no Location header) and is NOT challenged for
 * re-auth — a freshly signed cookie simply rides back on the same response.
 *
 * Mirrors src/__tests__/index.test.ts: route modules are mocked so importing the
 * real worker has no import side effects, but session-jwt is REAL (the refresh
 * path signs/verifies an actual HMAC token).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types';

// Mock route modules (same shape as index.test.ts) to avoid import side effects.
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
  app.get('/status', (c) => c.json({ configured: false }));
  return { default: app };
});
vi.mock('../routes/admin', () => ({ default: new Hono() }));

// Import after mocks. session-jwt is intentionally NOT mocked — real signing.
import worker from '../index';
import { signSessionJWT, SESSION_JWT_AUD } from '../lib/session-jwt';
import { createMockKV } from './helpers/mock-kv';

const OAUTH_JWT_SECRET = 'test-session-signing-secret';

function createSaasEnv(): Env {
  const mockKV = createMockKV();
  return {
    KV: mockKV as unknown as KVNamespace,
    ASSETS: { fetch: vi.fn(async () => new Response('SPA', { status: 200 })) } as unknown as Fetcher,
    // SaaS OIDC mode: the refresh middleware only runs when all three are set.
    SAAS_MODE: 'active',
    OAUTH_CLIENT_ID: 'gh-client-id',
    OAUTH_JWT_SECRET,
    ONBOARDING_LANDING_PAGE: 'inactive',
  } as unknown as Env;
}

function createMockCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

/** Mint a real session JWT whose exp is `ttlSeconds` from now. */
async function makeSessionCookie(ttlSeconds: number): Promise<string> {
  const token = await signSessionJWT(
    { email: 'active@example.com', sub: 'gh|1', ghLogin: 'octocat', aud: SESSION_JWT_AUD },
    OAUTH_JWT_SECRET,
    ttlSeconds,
  );
  return `codeflare_session=${token}`;
}

describe('REQ-AUTH-008 AC3: SaaS session refresh is transparent (no redirect / no re-auth)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves the resource (200) and re-issues the cookie without a redirect when within the refresh window', async () => {
    const env = createSaasEnv();
    // 600s remaining: still valid (> 0) and inside the 15-min refresh window.
    const cookie = await makeSessionCookie(600);

    const request = new Request('https://example.com/api/health', {
      headers: { Cookie: cookie },
    });
    const response = await worker.fetch(request, env, createMockCtx());

    // Transparent: the resource is returned, not a redirect or auth challenge.
    expect(response.status).toBe(200);
    expect(response.status).not.toBe(302);
    expect(response.headers.get('Location')).toBeNull();

    // A fresh session cookie rides back on the same response (no re-auth flow).
    const setCookie = response.headers.get('Set-Cookie');
    expect(setCookie).toContain('codeflare_session=');
    // The re-issued token differs from the one the client sent.
    const original = cookie.split('=')[1];
    const reissued = setCookie!.match(/codeflare_session=([^;]+)/)?.[1];
    expect(reissued).toBeTruthy();
    expect(reissued).not.toBe(original);
    // Issued with a 1-hour Max-Age (transparent extension, not expiry).
    expect(setCookie).toContain('Max-Age=3600');
  });

  it('does NOT re-issue a cookie when the token is not yet within the refresh window (conditional, not unconditional)', async () => {
    const env = createSaasEnv();
    // Full 1-hour TTL: outside the 15-min window, so no refresh should occur.
    const cookie = await makeSessionCookie(3600);

    const request = new Request('https://example.com/api/health', {
      headers: { Cookie: cookie },
    });
    const response = await worker.fetch(request, env, createMockCtx());

    expect(response.status).toBe(200);
    expect(response.headers.get('Location')).toBeNull();
    const setCookie = response.headers.get('Set-Cookie');
    // No transparent refresh fired: no fresh session cookie on the response.
    expect(setCookie ?? '').not.toContain('codeflare_session=');
  });
});
