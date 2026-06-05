/**
 * REQ-ENTERPRISE-004: LlmInterceptor — the security core of enterprise LLM routing.
 *
 * A WorkerEntrypoint the container DO wires into container egress. It holds the
 * AI Gateway secrets, maps the intercepted OpenAI host onto the AI Gateway REST
 * API (api.cloudflare.com/.../ai/v1/*), strips the container's placeholder auth,
 * stamps the gateway Authorization header + cf-aig-gateway-id + cf-aig-metadata
 * (per-user, from DO props), and streams the upstream response back WITHOUT
 * buffering. Transport target is the REST API; the legacy gateway.ai.cloudflare.com
 * /compat + /anthropic paths it replaces are deprecated (AD74).
 *
 * AC1. api.openai.com/v1/chat/completions
 *      -> api.cloudflare.com/client/v4/accounts/{acct}/ai/v1/chat/completions.
 * AC2. account id + gateway id are derived from AIG_GATEWAY_URL (account in the
 *      URL path; gateway in the cf-aig-gateway-id header).
 * AC3. Authorization: Bearer <AIG_TOKEN> carries the gateway token (standard
 *      header, not cf-aig-authorization); cf-aig-metadata carries the OPAQUE
 *      props.user (never an email).
 * AC4. The container's inbound Authorization / x-api-key placeholder is NOT
 *      forwarded upstream (replaced by the gateway token); unrelated headers survive.
 * AC5. The upstream response (text/event-stream) is streamed back, status +
 *      content-type preserved.
 * AC6. An unmapped host (incl. api.anthropic.com — not an enterprise agent host)
 *      returns 400 before any fetch.
 * AC7. AIG_GATEWAY_URL unset/unparseable -> 503 before any fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../types';
import { LlmInterceptor } from '../llm-interceptor';

const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/acct/gw';
const REST_BASE = 'https://api.cloudflare.com/client/v4/accounts/acct/ai';
const AIG_TOKEN = 'aig-secret-token';
const OPAQUE_USER = 'codeflare-user-bucket-xyz';

/** Construct an interceptor with the given env + per-session props. */
function makeInterceptor(envOverrides: Partial<Env> = {}, props: { user: string } = { user: OPAQUE_USER }) {
  const env = { AIG_GATEWAY_URL: GATEWAY, AIG_TOKEN, ...envOverrides } as unknown as Env;
  // The DO instantiates this via ctx.exports.LlmInterceptor({ props }); props
  // land on ctx.props. A minimal ctx stub mirrors that shape for the unit test.
  const ctx = { props } as unknown as ExecutionContext;
  return new LlmInterceptor(ctx, env);
}

/** A captured record of the last upstream fetch the interceptor made. */
let lastFetch: { url: string; method: string; headers: Headers } | null;

beforeEach(() => {
  lastFetch = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const req = input as Request;
    lastFetch = { url: req.url, method: req.method, headers: req.headers };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('REQ-ENTERPRISE-004: OpenAI host -> AI Gateway REST API mapping', () => {
  it('AC1: api.openai.com/v1/chat/completions -> REST /ai/v1/chat/completions under the account', async () => {
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{"model":"dynamic/codeflare-enterprise"}' }),
    );
    expect(res.status).toBe(200);
    expect(lastFetch?.url).toBe(`${REST_BASE}/v1/chat/completions`);
  });

  it('AC1: preserves the path verbatim under /ai (e.g. /v1/responses)', async () => {
    await makeInterceptor().fetch(new Request('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' }));
    expect(lastFetch?.url).toBe(`${REST_BASE}/v1/responses`);
  });

  it('AC1: preserves the query string when mapping', async () => {
    await makeInterceptor().fetch(new Request('https://api.openai.com/v1/models?limit=5', { method: 'GET' }));
    expect(lastFetch?.url).toBe(`${REST_BASE}/v1/models?limit=5`);
  });

  it('AC2: forwards the gateway id (from AIG_GATEWAY_URL) as cf-aig-gateway-id', async () => {
    await makeInterceptor().fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    expect(lastFetch?.headers.get('cf-aig-gateway-id')).toBe('gw');
  });

  it('AC2: a trailing slash on AIG_GATEWAY_URL is tolerated (account/gateway still parse)', async () => {
    await makeInterceptor({ AIG_GATEWAY_URL: `${GATEWAY}/` } as Partial<Env>).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    expect(lastFetch?.url).toBe(`${REST_BASE}/v1/chat/completions`);
    expect(lastFetch?.headers.get('cf-aig-gateway-id')).toBe('gw');
  });
});

describe('REQ-ENTERPRISE-004: gateway authorization + per-user metadata', () => {
  it('AC3: stamps the standard Authorization header with the gateway token', async () => {
    await makeInterceptor().fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    expect(lastFetch?.headers.get('authorization')).toBe(`Bearer ${AIG_TOKEN}`);
    // The legacy gateway-auth header is no longer used.
    expect(lastFetch?.headers.get('cf-aig-authorization')).toBeNull();
  });

  it('AC3: stamps cf-aig-metadata with the OPAQUE props.user (never an email)', async () => {
    await makeInterceptor({}, { user: OPAQUE_USER }).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    const metadata = lastFetch?.headers.get('cf-aig-metadata');
    expect(metadata).toBeTruthy();
    const parsed = JSON.parse(metadata as string);
    expect(parsed.user).toBe(OPAQUE_USER);
    expect(parsed.user).not.toContain('@');
  });

  it('AC3: falls back to user="unknown" when props are absent', async () => {
    const env = { AIG_GATEWAY_URL: GATEWAY, AIG_TOKEN } as unknown as Env;
    const interceptor = new LlmInterceptor({} as unknown as ExecutionContext, env);
    await interceptor.fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    const parsed = JSON.parse(lastFetch?.headers.get('cf-aig-metadata') as string);
    expect(parsed.user).toBe('unknown');
  });
});

describe('REQ-ENTERPRISE-004: placeholder-auth stripping', () => {
  it('AC4: replaces the container Authorization placeholder with the gateway token and strips x-api-key, keeps unrelated headers', async () => {
    await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer codeflare-enterprise', 'x-api-key': 'codeflare-enterprise', 'X-Custom': 'keepme' },
        body: '{}',
      }),
    );
    // The placeholder is gone, replaced by the real gateway token (not the placeholder value).
    expect(lastFetch?.headers.get('authorization')).toBe(`Bearer ${AIG_TOKEN}`);
    expect(lastFetch?.headers.get('x-api-key')).toBeNull();
    expect(lastFetch?.headers.get('x-custom')).toBe('keepme');
  });

  it('AC4: a client-supplied cf-aig-gateway-id is overwritten with the interceptor-derived gateway id', async () => {
    await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'cf-aig-gateway-id': 'attacker-gateway' },
        body: '{}',
      }),
    );
    // cf-aig-* control headers are interceptor-owned: the client value is replaced
    // by the gateway id parsed from AIG_GATEWAY_URL, never honoured.
    expect(lastFetch?.headers.get('cf-aig-gateway-id')).toBe('gw');
  });
});

describe('REQ-ENTERPRISE-004: streaming passthrough (no buffering)', () => {
  it('AC5: preserves the text/event-stream content-type and streams the body', async () => {
    const res = await makeInterceptor().fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: {"delta":"hi"}');
    expect(text).toContain('data: [DONE]');
  });

  it('AC5: forwards the upstream status verbatim', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } }),
    );
    const res = await makeInterceptor().fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(429);
  });
});

describe('REQ-ENTERPRISE-004: fail-closed guards', () => {
  it('AC6: an unmapped host returns 400 and never fetches', async () => {
    const res = await makeInterceptor().fetch(new Request('https://evil.example.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('AC6: api.anthropic.com is NOT an enterprise host — returns 400 and never fetches', async () => {
    const res = await makeInterceptor().fetch(new Request('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('AC7: returns 503 when AIG_GATEWAY_URL is unset and never fetches', async () => {
    const res = await makeInterceptor({ AIG_GATEWAY_URL: undefined }).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(503);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('AC7: returns 503 when AIG_GATEWAY_URL is unparseable (no /v1/{acct}/{gw}) and never fetches', async () => {
    const res = await makeInterceptor({ AIG_GATEWAY_URL: 'https://example.com/nope' } as Partial<Env>).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(503);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('REQ-ENTERPRISE-004: transport hardening', () => {
  it('MED-1: strips set-cookie from the upstream response, keeps content-type', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('ok', {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc; HttpOnly' },
      }),
    );
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('LOW-1: does not transparently follow upstream redirects (redirect: manual)', async () => {
    let capturedRedirect: string | undefined;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async (input: RequestInfo | URL) => {
      capturedRedirect = (input as Request).redirect;
      return new Response('ok', { status: 200 });
    });
    await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    expect(capturedRedirect).toBe('manual');
  });
});
