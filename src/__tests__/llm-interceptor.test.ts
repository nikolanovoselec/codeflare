/**
 * REQ-ENTERPRISE-004: LlmInterceptor — the security core of enterprise LLM routing.
 *
 * A WorkerEntrypoint the container DO wires into container egress. It holds the
 * AI Gateway secrets, maps the intercepted OpenAI host onto the AI Gateway REST
 * API (api.cloudflare.com/.../ai/v1/*), strips the container's placeholder auth,
 * stamps the gateway Authorization header + cf-aig-gateway-id + cf-aig-metadata
 * (per-user, from DO props), and streams the upstream response back WITHOUT
 * buffering. Primary transport is the REST API; on a 404 for a model-routable
 * request it falls back to the deprecated-but-functional gateway.ai.cloudflare.com
 * /compat path (which still carries every provider, e.g. google-ai-studio),
 * authenticating with cf-aig-authorization instead of Authorization (AD74).
 *
 * AC1. api.openai.com/v1/chat/completions
 *      -> api.cloudflare.com/client/v4/accounts/{acct}/ai/v1/chat/completions.
 * AC2. account id + gateway id are derived from AIG_GATEWAY_URL (account in the
 *      URL path; gateway in the cf-aig-gateway-id header).
 * AC3. The upstream response (text/event-stream) is streamed back, status +
 *      content-type preserved; a missing terminal finish_reason chunk is
 *      synthesized before [DONE] (idempotent; tool_calls vs stop).
 * AC4. Authorization: Bearer <AIG_TOKEN> carries the gateway token (standard
 *      header, not cf-aig-authorization); cf-aig-metadata carries props.user
 *      stamped verbatim — the user's email (per-user gateway analytics).
 * AC5. The container's inbound Authorization / x-api-key placeholder is NOT
 *      forwarded upstream (replaced by the gateway token); unrelated headers survive.
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
const SESSION_USER = 'nikola@novoselec.ch'; // per-session attribution: the user's email (REQ-ENTERPRISE-004 AC4)

/** Construct an interceptor with the given env + per-session props. */
function makeInterceptor(envOverrides: Partial<Env> = {}, props: { user: string; groups?: string[] } = { user: SESSION_USER }) {
  // The interceptor now reads the route catalog from KV; tests pass a __kv map
  // of key -> JSON string via envOverrides, which backs a minimal KV.get stub.
  const kvStore: Record<string, string> = (envOverrides as { __kv?: Record<string, string> }).__kv ?? {};
  const env = { AIG_GATEWAY_URL: GATEWAY, AIG_TOKEN, KV: { get: async (k: string) => kvStore[k] ?? null }, ...envOverrides } as unknown as Env;
  // The DO instantiates this via ctx.exports.LlmInterceptor({ props }); props
  // land on ctx.props. A minimal ctx stub mirrors that shape for the unit test.
  const ctx = { props } as unknown as ExecutionContext;
  return new LlmInterceptor(ctx, env);
}

/** A captured record of the last upstream fetch the interceptor made. */
let lastFetch: { url: string; method: string; headers: Headers; body: string } | null;

beforeEach(() => {
  lastFetch = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const req = input as Request;
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
    lastFetch = { url: req.url, method: req.method, headers: req.headers, body };
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
  it('AC4: stamps the standard Authorization header with the gateway token', async () => {
    await makeInterceptor().fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    expect(lastFetch?.headers.get('authorization')).toBe(`Bearer ${AIG_TOKEN}`);
    // On the REST leg, cf-aig-authorization is NOT set — that header is the compat-leg auth.
    expect(lastFetch?.headers.get('cf-aig-authorization')).toBeNull();
  });

  it('AC4: stamps cf-aig-metadata with props.user verbatim (the user email)', async () => {
    await makeInterceptor({}, { user: SESSION_USER }).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    const metadata = lastFetch?.headers.get('cf-aig-metadata');
    expect(metadata).toBeTruthy();
    const parsed = JSON.parse(metadata as string);
    expect(parsed.user).toBe(SESSION_USER);
    expect(parsed.user).toContain('@'); // the per-session prop is now the user's email
  });

  it('AC4: falls back to user="unknown" when props are absent', async () => {
    const env = { AIG_GATEWAY_URL: GATEWAY, AIG_TOKEN } as unknown as Env;
    const interceptor = new LlmInterceptor({} as unknown as ExecutionContext, env);
    await interceptor.fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    const parsed = JSON.parse(lastFetch?.headers.get('cf-aig-metadata') as string);
    expect(parsed.user).toBe('unknown');
  });

  it('stamps one group_<sanitized>=1 tag per matched group and NO scalar group key', async () => {
    await makeInterceptor({}, { user: SESSION_USER, groups: ['codeflare_admins', 'Dev Team'] }).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{"model":"x"}' }),
    );
    const parsed = JSON.parse(lastFetch?.headers.get('cf-aig-metadata') as string);
    expect(parsed.user).toBe(SESSION_USER);
    expect('group' in parsed).toBe(false); // scalar dropped
    const groupKeys = Object.keys(parsed).filter((k) => k.startsWith('group_'));
    expect(groupKeys).toHaveLength(2);
    for (const k of groupKeys) expect(parsed[k]).toBe(1); // value is a filterable scalar
    // sanitization: spaces/case folded into the key
    expect(groupKeys.some((k) => k.includes('dev_team'))).toBe(true);
  });

  it('stamps exactly { user } with no group_* keys when groups is empty/absent', async () => {
    await makeInterceptor().fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{"model":"x"}' }));
    const parsed = JSON.parse(lastFetch?.headers.get('cf-aig-metadata') as string);
    expect(Object.keys(parsed)).toEqual(['user']);
  });

  it('truncates to 4 group tags (user + 4 = CF 5-tag cap) deterministically in configured order and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await makeInterceptor({}, { user: SESSION_USER, groups: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'] }).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{"model":"x"}' }),
    );
    const parsed = JSON.parse(lastFetch?.headers.get('cf-aig-metadata') as string);
    const groupKeys = Object.keys(parsed).filter((k) => k.startsWith('group_'));
    expect(groupKeys).toHaveLength(4); // 4 groups + 1 user = 5 total (CF cap)
    expect(groupKeys.some((k) => k.startsWith('group_g1_'))).toBe(true); // first kept
    expect(groupKeys.some((k) => k.startsWith('group_g5_'))).toBe(false); // 5th/6th dropped
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('g5, g6')); // drop logged, not silent
  });
});

describe('REQ-ENTERPRISE-004: placeholder-auth stripping', () => {
  it('AC5: replaces the container Authorization placeholder with the gateway token and strips x-api-key, keeps unrelated headers', async () => {
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

  it('AC5: a client-supplied cf-aig-gateway-id is overwritten with the interceptor-derived gateway id', async () => {
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

  it('AC5: a client-supplied cf-aig-authorization is stripped, never forwarded on the REST leg', async () => {
    await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'cf-aig-authorization': 'Bearer attacker-token' },
        body: '{}',
      }),
    );
    // cf-aig-authorization is the compat-leg auth and is never set on the REST leg,
    // so a container-supplied value must be stripped — otherwise it would ride the
    // REST leg unmodified (the REST leg authenticates via Authorization: Bearer).
    expect(lastFetch?.headers.get('cf-aig-authorization')).toBeNull();
  });
});

describe('REQ-ENTERPRISE-004: streaming passthrough (no buffering)', () => {
  it('AC3: preserves the text/event-stream content-type and streams the body', async () => {
    const res = await makeInterceptor().fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: {"delta":"hi"}');
    expect(text).toContain('data: [DONE]');
  });

  it('AC3: forwards the upstream status verbatim', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } }),
    );
    const res = await makeInterceptor().fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(429);
  });
});

describe('REQ-ENTERPRISE-004: streaming terminator repair (AC3 — dynamic-route finish_reason fix)', () => {
  const dataLine = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
  const sse = (chunks: string[]): Response => {
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  it('injects a finish_reason:"stop" chunk before [DONE] when the upstream omits it (dynamic-route bug)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      sse([
        dataLine({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }),
        dataLine({ id: 'x', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: null }] }),
        'data: [DONE]\n\n',
      ]),
    );
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    const text = await res.text();
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.indexOf('"finish_reason":"stop"')).toBeLessThan(text.indexOf('data: [DONE]'));
  });

  it('is idempotent: does not add a second terminator when the upstream already sends finish_reason', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      sse([
        dataLine({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }),
        dataLine({ id: 'x', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ]),
    );
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    const text = await res.text();
    expect((text.match(/"finish_reason":"stop"/g) ?? []).length).toBe(1);
  });

  it('synthesizes finish_reason:"tool_calls" when the stream carried tool-call deltas', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      sse([
        dataLine({
          id: 'x',
          model: 'm',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'read' } }] }, finish_reason: null }],
        }),
        'data: [DONE]\n\n',
      ]),
    );
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    const text = await res.text();
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it('does not touch a non-chat-completions stream (e.g. /responses passes through unchanged)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      sse(['data: {"type":"response.output_text.delta"}\n\n', 'data: [DONE]\n\n']),
    );
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' }),
    );
    const text = await res.text();
    expect(text).not.toContain('finish_reason');
  });

  it('reassembles a [DONE] marker split across chunk boundaries (line-buffering)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      sse([
        dataLine({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }),
        'data: [DO',
        'NE]\n\n',
      ]),
    );
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    const text = await res.text();
    expect((text.match(/"finish_reason":"stop"/g) ?? []).length).toBe(1);
    expect(text.indexOf('"finish_reason":"stop"')).toBeLessThan(text.indexOf('data: [DONE]'));
  });

  it('reassembles a content frame split mid-JSON across chunk boundaries (no corruption, single terminator)', async () => {
    const frame = dataLine({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] });
    const mid = Math.floor(frame.length / 2);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      sse([frame.slice(0, mid), frame.slice(mid), 'data: [DONE]\n\n']),
    );
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }),
    );
    const text = await res.text();
    expect(text).toContain('"content":"hello"');
    expect((text.match(/"finish_reason":"stop"/g) ?? []).length).toBe(1);
  });
});

describe('Feature C: catalog-driven dynamic-route mapping (replaces AIG_LANGUAGE_MODEL)', () => {
  // Setup persists the catalog under SETUP_KEYS.DYNAMIC_ROUTES (JSON string[]) and
  // the default under SETUP_KEYS.DEFAULT_ROUTE (JSON { route, reasoning }). The
  // harness injects both via the __kv map (see makeInterceptor).
  const withCatalog = (routes: string[], def?: string) =>
    ({
      __kv: {
        'setup:dynamic_routes': JSON.stringify(routes),
        ...(def !== undefined && { 'setup:default_route': JSON.stringify({ route: def, reasoning: 'off' }) }),
      },
    } as unknown as Partial<Env>);

  it('maps a known slash-free handle to dynamic/<route> on chat/completions', async () => {
    await makeInterceptor(withCatalog(['development', 'production'], 'development')).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'production', messages: [] }) }),
    );
    expect(JSON.parse(lastFetch?.body as string).model).toBe('dynamic/production');
  });

  it('fails safe to the default route on an unknown handle', async () => {
    await makeInterceptor(withCatalog(['development', 'production'], 'development')).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'bogus' }) }),
    );
    expect(JSON.parse(lastFetch?.body as string).model).toBe('dynamic/development');
  });

  it('resolves the default to the first catalog entry when none is configured', async () => {
    await makeInterceptor(withCatalog(['alpha', 'beta'])).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'unknown' }) }),
    );
    expect(JSON.parse(lastFetch?.body as string).model).toBe('dynamic/alpha');
  });

  it('does NOT rewrite when the catalog is empty (forwards the agent model verbatim)', async () => {
    await makeInterceptor().fetch( // no __kv → empty catalog
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'codeflare' }) }),
    );
    expect(JSON.parse(lastFetch?.body as string).model).toBe('codeflare');
  });

  it('does NOT rewrite a non-model-routable path (e.g. /v1/embeddings)', async () => {
    await makeInterceptor(withCatalog(['development'], 'development')).fetch(
      new Request('https://api.openai.com/v1/embeddings', { method: 'POST', body: JSON.stringify({ model: 'text-embedding-3-small' }) }),
    );
    expect(JSON.parse(lastFetch?.body as string).model).toBe('text-embedding-3-small');
  });

  it('tolerates a pre-prefixed dynamic/<handle> and re-resolves through the catalog', async () => {
    await makeInterceptor(withCatalog(['development'], 'development')).fetch(
      new Request('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'dynamic/development', input: 'x' }) }),
    );
    expect(JSON.parse(lastFetch?.body as string).model).toBe('dynamic/development');
  });

  // REQ-ENTERPRISE-013: the per-request mapping resolves through the SAME shared
  // resolver as the container env fan, so a matched group's catalog/default applies.
  it('maps using the matched group catalog/default (group overrides global)', async () => {
    const env = {
      __kv: {
        'setup:dynamic_routes': JSON.stringify(['general_usage', 'development', 'code_review']),
        'setup:default_route': JSON.stringify({ route: 'general_usage', reasoning: 'off' }),
        'setup:group_routing': JSON.stringify({
          developers: { routes: ['code_review', 'development'], defaultRoute: 'code_review', reasoning: 'high' },
        }),
      },
    } as unknown as Partial<Env>;
    // Unknown handle for this group → the GROUP default (code_review), not the global one.
    await makeInterceptor(env, { user: SESSION_USER, groups: ['developers'] }).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'bogus' }) }),
    );
    expect(JSON.parse(lastFetch?.body as string).model).toBe('dynamic/code_review');
  });

  it('a user whose groups have no per-group config falls back to the global default', async () => {
    const env = {
      __kv: {
        'setup:dynamic_routes': JSON.stringify(['general_usage', 'development']),
        'setup:default_route': JSON.stringify({ route: 'general_usage', reasoning: 'off' }),
        'setup:group_routing': JSON.stringify({
          developers: { routes: ['development'], defaultRoute: 'development', reasoning: 'high' },
        }),
      },
    } as unknown as Partial<Env>;
    await makeInterceptor(env, { user: SESSION_USER, groups: ['unconfigured'] }).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'bogus' }) }),
    );
    expect(JSON.parse(lastFetch?.body as string).model).toBe('dynamic/general_usage');
  });

  it('forwards a non-JSON body unchanged (no crash) on a routable path with a catalog', async () => {
    await makeInterceptor(withCatalog(['development'], 'development')).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: 'not-json' }),
    );
    expect(lastFetch?.body).toBe('not-json');
  });

  it('forwards JSON without a model field unchanged (no model injected)', async () => {
    await makeInterceptor(withCatalog(['development'], 'development')).fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) }),
    );
    const sent = JSON.parse(lastFetch?.body as string);
    expect(sent.model).toBeUndefined();
    expect(sent.messages).toEqual([]);
  });

  it('preserves the rest of the payload verbatim when mapping the model', async () => {
    await makeInterceptor(withCatalog(['development', 'production'], 'development')).fetch(
      new Request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'production', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    const sent = JSON.parse(lastFetch?.body as string);
    expect(sent.model).toBe('dynamic/production');
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('REQ-ENTERPRISE-004: compat fallback on REST 404 (dual transport — AD74 amendment)', () => {
  const COMPAT_BASE = 'https://gateway.ai.cloudflare.com/v1/acct/gw/compat';

  /**
   * Replace the default mock with a two-leg recorder: the REST API returns
   * `restStatus` (404 by default), the compat host returns 200. Returns the
   * array of captured upstream calls so a test can assert order + headers + body.
   */
  function mockRestThenCompat(restStatus = 404) {
    const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const req = input as Request;
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
      calls.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.url.startsWith(REST_BASE)) {
        return new Response('{"error":"Model not found"}', { status: restStatus, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return calls;
  }

  it('AC1: replays a model-routable request to the compat path when the REST API returns 404', async () => {
    const calls = mockRestThenCompat();
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'google-ai-studio/gemini-3.1-pro-preview' }),
      }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${REST_BASE}/v1/chat/completions`); // REST tried first
    expect(calls[1].url).toBe(`${COMPAT_BASE}/chat/completions`); // compat fallback (/v1 stripped)
    expect(res.status).toBe(200);
  });

  it('AC4: the compat leg authenticates with cf-aig-authorization, not Authorization: Bearer', async () => {
    const calls = mockRestThenCompat();
    await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: '{"model":"google-ai-studio/gemini-3.1-pro-preview"}',
      }),
    );
    const compat = calls[1];
    expect(compat.headers.get('cf-aig-authorization')).toBe(`Bearer ${AIG_TOKEN}`);
    expect(compat.headers.get('authorization')).toBeNull(); // the REST-leg header is not carried over
    // per-user attribution is still stamped on the fallback leg
    expect(JSON.parse(compat.headers.get('cf-aig-metadata') as string).user).toBe(SESSION_USER);
  });

  it('replays the SAME buffered (catalog-mapped) body on the compat leg', async () => {
    const calls = mockRestThenCompat();
    const env = {
      __kv: { 'setup:dynamic_routes': JSON.stringify(['codeflare']), 'setup:default_route': JSON.stringify({ route: 'codeflare', reasoning: 'off' }) },
    } as unknown as Partial<Env>;
    await makeInterceptor(env).fetch(
      new Request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'codeflare', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    // both legs carry the mapped model, byte-identical (the buffered replay)
    expect(JSON.parse(calls[0].body).model).toBe('dynamic/codeflare');
    expect(calls[1].body).toBe(calls[0].body);
  });

  it('falls back on /responses too (compat path strips the /v1 prefix)', async () => {
    const calls = mockRestThenCompat();
    await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{"model":"google-ai-studio/gemini-3.1-pro-preview"}',
      }),
    );
    expect(calls[1].url).toBe(`${COMPAT_BASE}/responses`);
  });

  it('does NOT fall back on a non-404 error (e.g. 429 is returned as-is, single call)', async () => {
    const calls = mockRestThenCompat(429);
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{"model":"x"}' }),
    );
    expect(calls).toHaveLength(1);
    expect(res.status).toBe(429);
  });

  it('does NOT fall back for a non-model-routable path (a 404 on /v1/embeddings is returned as-is)', async () => {
    const calls = mockRestThenCompat();
    const res = await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/embeddings', { method: 'POST', body: '{"model":"text-embedding-3-small"}' }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${REST_BASE}/v1/embeddings`);
    expect(res.status).toBe(404);
  });

  it('strips store + prompt_cache_key on the compat leg (non-OpenAI provider 400-on-unknown-field fix)', async () => {
    const calls = mockRestThenCompat();
    await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'google-ai-studio/gemini-2.5-flash', store: false, prompt_cache_key: 'k', messages: [] }),
      }),
    );
    const restBody = JSON.parse(calls[0].body);
    const compatBody = JSON.parse(calls[1].body);
    // REST leg keeps the OpenAI-only fields; compat leg has them stripped.
    expect(restBody.store).toBe(false);
    expect(restBody.prompt_cache_key).toBe('k');
    expect(compatBody.store).toBeUndefined();
    expect(compatBody.prompt_cache_key).toBeUndefined();
    // the rest of the payload survives on the compat leg
    expect(compatBody.model).toBe('google-ai-studio/gemini-2.5-flash');
    expect(compatBody.messages).toEqual([]);
  });

  it('keeps store + prompt_cache_key when the REST leg succeeds (no fallback — OpenAI caching intact)', async () => {
    // Default mock returns 200, so the REST leg succeeds and there is no compat retry.
    await makeInterceptor().fetch(
      new Request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', store: false, prompt_cache_key: 'k' }),
      }),
    );
    const sent = JSON.parse(lastFetch?.body as string);
    expect(sent.store).toBe(false);
    expect(sent.prompt_cache_key).toBe('k');
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
