/**
 * REQ-ENTERPRISE-004: Worker LLM proxy - the security core.
 *
 * A token-authed fetch() passthrough that holds the AI Gateway secrets, stamps
 * cf-aig-authorization + cf-aig-metadata, enforces a provider allowlist (SSRF
 * guard), and streams the upstream response back WITHOUT buffering.
 *
 * AC1. A valid per-session token authenticates; an invalid/expired/missing one
 *      returns 401.
 * AC2. A token whose sid != the path :sid returns 401 (no cross-session replay).
 * AC3. Only the `anthropic` and `compat` providers are forwarded; anything else
 *      returns 400 BEFORE any upstream fetch (SSRF prevention).
 * AC4. The upstream fetch is stamped with cf-aig-authorization (gateway token)
 *      and cf-aig-metadata carrying the OPAQUE token.user (never an email).
 * AC5. The inbound Authorization header (the proxy token) is NOT forwarded
 *      upstream.
 * AC6. The upstream response body (text/event-stream) is streamed back without
 *      buffering - the same bytes, content-type preserved.
 * AC7. When AIG_GATEWAY_URL is unset, the proxy returns 503.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { signProxyToken } from '../../lib/session-jwt';
import llmRoutes from '../../routes/llm';

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })),
  })),
}));

const SECRET = 'test-encryption-key-0123456789abcdef';
const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/acct/gw';
const AIG_TOKEN = 'aig-secret-token';
const SID = 'sess-abc12345';
const OPAQUE_USER = 'codeflare-user-bucket-xyz';

function makeApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c.env as unknown as Env) = {
      ENCRYPTION_KEY: SECRET,
      AIG_GATEWAY_URL: GATEWAY,
      AIG_TOKEN,
      ...envOverrides,
    } as unknown as Env;
    return next();
  });
  app.route('/api/llm', llmRoutes);
  return app;
}

/** A captured record of the last upstream fetch the proxy made. */
let lastFetch: { url: string; method: string; headers: Headers; body: unknown } | null;

beforeEach(() => {
  lastFetch = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const req = input as Request;
    lastFetch = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
    };
    // Default upstream: a small SSE stream so the passthrough can be observed.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function validToken(opts: { sid?: string; user?: string } = {}) {
  return signProxyToken(
    { sid: opts.sid ?? SID, user: opts.user ?? OPAQUE_USER },
    SECRET,
  );
}

describe('REQ-ENTERPRISE-004: LLM proxy token auth', () => {
  it('AC1: returns 401 when the Authorization header is missing', async () => {
    const app = makeApp();
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('AC1: returns 401 for a malformed bearer token', async () => {
    const app = makeApp();
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('AC1: returns 401 for a token signed with the wrong secret', async () => {
    const app = makeApp();
    const badToken = await signProxyToken({ sid: SID, user: OPAQUE_USER }, 'a-different-secret');
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${badToken}` },
    });
    expect(res.status).toBe(401);
  });

  it('AC1: returns 401 for an expired token', async () => {
    const app = makeApp();
    const expired = await signProxyToken({ sid: SID, user: OPAQUE_USER }, SECRET, -10);
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${expired}` },
    });
    expect(res.status).toBe(401);
  });

  it('AC1: accepts a valid token and forwards (200)', async () => {
    const app = makeApp();
    const token = await validToken();
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{"model":"claude"}',
    });
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('AC2: returns 401 when the token sid does not match the path sid', async () => {
    const app = makeApp();
    const token = await validToken({ sid: 'other-session' });
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('REQ-ENTERPRISE-004: provider allowlist (SSRF guard)', () => {
  it('AC3: forwards the anthropic provider', async () => {
    const app = makeApp();
    const token = await validToken();
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(lastFetch?.url).toBe(`${GATEWAY}/anthropic/v1/messages`);
  });

  it('AC3: forwards the compat provider', async () => {
    const app = makeApp();
    const token = await validToken();
    const res = await app.request(`/api/llm/${SID}/compat/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(lastFetch?.url).toBe(`${GATEWAY}/compat/chat/completions`);
  });

  it('AC3: rejects a non-allowlisted provider with 400 and never fetches (SSRF block)', async () => {
    const app = makeApp();
    const token = await validToken();
    const res = await app.request(`/api/llm/${SID}/evil-provider/internal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('REQ-ENTERPRISE-004: gateway authorization + metadata stamping', () => {
  it('AC4: stamps cf-aig-authorization with the gateway token', async () => {
    const app = makeApp();
    const token = await validToken();
    await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(lastFetch?.headers.get('cf-aig-authorization')).toBe(`Bearer ${AIG_TOKEN}`);
  });

  it('AC4: stamps cf-aig-metadata with the OPAQUE token.user (never an email)', async () => {
    const app = makeApp();
    const token = await validToken({ user: OPAQUE_USER });
    await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{}',
    });
    const metadata = lastFetch?.headers.get('cf-aig-metadata');
    expect(metadata).toBeTruthy();
    const parsed = JSON.parse(metadata as string);
    expect(parsed.user).toBe(OPAQUE_USER);
    expect(parsed.user).not.toContain('@');
  });

  it('AC5: strips the inbound Authorization (proxy token) from the upstream request', async () => {
    const app = makeApp();
    const token = await validToken();
    await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Custom': 'keepme' },
      body: '{}',
    });
    // The proxy token must NOT leak upstream as Authorization.
    expect(lastFetch?.headers.get('authorization')).toBeNull();
    // Unrelated passthrough headers survive.
    expect(lastFetch?.headers.get('x-custom')).toBe('keepme');
  });
});

describe('REQ-ENTERPRISE-004: streaming passthrough (no buffering)', () => {
  it('AC6: preserves the text/event-stream content-type', async () => {
    const app = makeApp();
    const token = await validToken();
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  it('AC6: streams the upstream SSE body back byte-for-byte', async () => {
    const app = makeApp();
    const token = await validToken();
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{}',
    });
    const text = await res.text();
    expect(text).toContain('data: {"delta":"hi"}');
    expect(text).toContain('data: [DONE]');
  });

  it('AC6: forwards the upstream status verbatim', async () => {
    const app = makeApp();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } }),
    );
    const token = await validToken();
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(res.status).toBe(429);
  });
});

describe('REQ-ENTERPRISE-004: gateway-unavailable', () => {
  it('AC7: returns 503 when AIG_GATEWAY_URL is unset', async () => {
    const app = makeApp({ AIG_GATEWAY_URL: undefined });
    const token = await validToken();
    const res = await app.request(`/api/llm/${SID}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(res.status).toBe(503);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
