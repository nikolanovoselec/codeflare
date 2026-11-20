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
vi.mock('../routes/terminal', async (importOriginal) => ({
  validateWebSocketRoute: (await importOriginal<typeof import('../routes/terminal')>()).validateWebSocketRoute,
  default: new Hono(),
  handleWebSocketUpgrade: vi.fn(),
}));
vi.mock('../routes/vault', async () => ({
  validateVaultRoute: (await import('../routes/vault/validation')).validateVaultRoute,
  default: new Hono(),
  handleVaultRequest: vi.fn(),
}));
vi.mock('../routes/vscode', async () => ({
  validateVscodeRoute: (await import('../routes/vscode-validation')).validateVscodeRoute,
  handleVscodeRequest: vi.fn(),
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
import { signSessionJWT, verifySessionJWT, SESSION_JWT_AUD } from '../lib/session-jwt';
import { resetSetupCache } from '../lib/cache-reset';
import { SETUP_KEYS } from '../lib/kv-keys';
import { handleWebSocketUpgrade } from '../routes/terminal';
import { handleVaultRequest } from '../routes/vault';
import { handleVscodeRequest } from '../routes/vscode';
import { createMockKV } from './helpers/mock-kv';

const OAUTH_JWT_SECRET = 'test-session-signing-secret';

function createSaasEnv(): Env {
  const mockKV = createMockKV();
  mockKV._store.set(SETUP_KEYS.COMPLETE, 'true');
  return {
    KV: mockKV as unknown as KVNamespace,
    ASSETS: { fetch: vi.fn(async () => new Response('SPA', { status: 200 })) } as unknown as Fetcher,
    // SaaS OIDC renewal requires the mode, client ID, and signing secret.
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

describe('REQ-AUTH-008: guarded response renewal', () => {
  beforeEach(() => {
    resetSetupCache();
  });

  it.each([
    ['Vault', '/api/vault/abcd1234/editor.js', handleVaultRequest],
    ['IDE', '/api/vscode/abcd1234/editor.js', handleVscodeRequest],
  ] as const)('renews proxied %s HTTP without losing the body or existing cookies', async (name, path, proxy) => {
    const otherCookie = 'cf_vault_sid=abcd1234; HttpOnly; Secure; Path=/api/vault/';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('proxied body'));
        controller.close();
      },
    });
    const headers = new Headers({
      'Cloudflare-CDN-Cache-Control': 'public, max-age=60',
      'CDN-Cache-Control': 'public, max-age=60',
    });
    if (name === 'Vault') headers.set('Set-Cookie', otherCookie);
    vi.mocked(proxy).mockResolvedValueOnce(new Response(stream, { headers }));
    const env = createSaasEnv();
    await env.KV.put(SETUP_KEYS.CUSTOM_DOMAIN, 'example.com');
    const cookie = await makeSessionCookie(600);
    const now = Math.floor(Date.now() / 1000);

    const response = await worker.fetch(new Request(`https://example.com${path}`, {
      headers: { Cookie: cookie },
    }), env, createMockCtx());

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).toBe('proxied body');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull();
    expect(response.headers.get('CDN-Cache-Control')).toBeNull();
    const cookies = response.headers.getAll('Set-Cookie');
    if (name === 'Vault') expect(cookies).toContain(otherCookie);
    const renewed = cookies.find((value) => value.startsWith('codeflare_session='));
    expect(renewed).toMatch(/; HttpOnly; Secure; SameSite=Lax; Path=\/; Domain=example\.com; Max-Age=3600$/);
    const token = renewed?.slice('codeflare_session='.length).split(';', 1)[0] ?? '';
    const claims = await verifySessionJWT(token, OAUTH_JWT_SECRET, SESSION_JWT_AUD);
    expect(claims).toMatchObject({ email: 'active@example.com', sub: 'gh|1', ghLogin: 'octocat' });
    expect(claims?.exp).toBeGreaterThanOrEqual(now + 3600);
    expect(claims?.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600);
  });

  it.each([
    ['SaaS', '/assets/main-1234.js', { SAAS_MODE: 'active' }],
    ['onboarding', '/landing/_astro/main-1234.js', { SAAS_MODE: 'inactive', ONBOARDING_LANDING_PAGE: 'active' }],
  ] as const)('makes a fingerprinted %s asset private only when issuing renewal', async (_mode, path, flags) => {
    const env = { ...createSaasEnv(), ...flags };
    const assetUrl = `https://example.com${path}`;
    const ctx = createMockCtx();
    const request = async (remaining: number) => worker.fetch(new Request(assetUrl, {
      headers: { Cookie: await makeSessionCookie(remaining) },
    }), env, ctx);

    const fresh = await request(3600);
    expect(fresh.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(fresh.headers.get('Set-Cookie')).toBeNull();
    const renewal = await request(600);
    expect(renewal.headers.get('Cache-Control')).toBe('no-store');
    expect(renewal.headers.get('Set-Cookie')).toMatch(/^codeflare_session=/);
    expect(await renewal.text()).toBe('SPA');
  });

  it('keeps the logout redirect and clearing cookie instead of renewing the incoming session', async () => {
    const response = await worker.fetch(new Request('https://example.com/auth/github/logout', {
      headers: { Cookie: await makeSessionCookie(600) },
    }), createSaasEnv(), createMockCtx());

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://example.com/');
    expect(response.headers.getAll('Set-Cookie')).toEqual([
      'codeflare_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    ]);
  });

  it('returns the original terminal upgrade with its attached socket and no renewal', async () => {
    const pair = new WebSocketPair();
    const upgrade = new Response(null, { status: 101, webSocket: pair[0] });
    vi.mocked(handleWebSocketUpgrade).mockResolvedValueOnce(upgrade);
    const response = await worker.fetch(new Request('https://example.com/api/terminal/abcd1234-1/ws', {
      headers: { Cookie: await makeSessionCookie(600), Upgrade: 'websocket' },
    }), createSaasEnv(), createMockCtx());

    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(pair[0]);
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it.each(['default mode', 'enterprise mode', 'expired token', 'different cookie name'] as const)(
    'does not renew with %s', async (scenario) => {
      const env = createSaasEnv();
      if (scenario === 'default mode') env.SAAS_MODE = 'inactive';
      if (scenario === 'enterprise mode') env.ENTERPRISE_MODE = 'active';
      const cookie = await makeSessionCookie(scenario === 'expired token' ? -1 : 600);
      const response = await worker.fetch(new Request('https://example.com/api/health', {
        headers: { Cookie: scenario === 'different cookie name' ? `other_${cookie}` : cookie },
      }), env, createMockCtx());

      expect(response.status).toBe(200);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    },
  );
});
