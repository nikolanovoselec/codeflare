/**
 * LLM proxy routes (enterprise mode) - the security core of REQ-ENTERPRISE-004.
 *
 * A Worker-side fetch() passthrough that holds the AI Gateway secrets so the
 * in-container agents never see them. Each agent (Claude / Copilot / Pi) is
 * injected with a same-origin base URL (`/api/llm/<sid>/<provider>`) plus a
 * signed per-session token; this route validates the token, stamps the request
 * with the gateway authorization + per-user metadata, and streams the upstream
 * response straight back without buffering.
 *
 * Auth here is token-based and deliberately distinct from the browser
 * cookie/JWT chain used by every other API route - the caller is the
 * in-container agent, not a browser, so there is NO authMiddleware on this app.
 * The token is an HMAC-signed per-session token (aud = codeflare-llm-proxy)
 * verified statelessly against ENCRYPTION_KEY.
 *
 * Dormant on non-enterprise deploys: the container is only ever handed these
 * base URLs when ENTERPRISE_MODE=active, so this route is never invoked
 * otherwise (and 503s if AIG_GATEWAY_URL is unset regardless).
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyProxyToken } from '../lib/session-jwt';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/error-types';

const logger = createLogger('llm-proxy');

/**
 * Provider allowlist - only these two upstream provider segments are ever
 * appended to AIG_GATEWAY_URL. Without this, a crafted `:provider` value could
 * be used to make the Worker fetch an arbitrary path off the gateway base (or,
 * with a path-traversal segment, off-base entirely) - SSRF. Anything else is
 * rejected with 400 before any fetch happens.
 */
const ALLOWED_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'compat']);

/**
 * Headers that must NOT be forwarded upstream. `authorization` held the proxy
 * token (not a provider key), so it is stripped - the gateway authorization is
 * stamped separately as `cf-aig-authorization`. Hop-by-hop / Cloudflare-managed
 * headers are dropped so the upstream fetch builds clean.
 */
const STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'host',
  'content-length',
  'cf-aig-authorization',
  'cf-aig-metadata',
]);

const app = new Hono<{ Bindings: Env }>();

/**
 * ALL /api/llm/:sid/:provider/* - the passthrough proxy.
 *
 * Matches every method so streaming POSTs (the LLM completion calls) and any
 * other verb the SDKs use flow through untouched.
 */
app.all('/:sid/:provider/*', async (c) => {
  const sid = c.req.param('sid');
  const provider = c.req.param('provider');

  // 503 before auth when the gateway is not configured: a non-enterprise
  // deploy that somehow receives a request here has nowhere to forward it.
  if (!c.env.AIG_GATEWAY_URL) {
    return c.json({ error: 'LLM proxy not configured', code: 'GATEWAY_UNAVAILABLE' }, 503);
  }

  // Token auth. The agent presents `Authorization: Bearer <proxyToken>`.
  const authHeader = c.req.header('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return c.json({ error: 'Missing bearer token', code: 'UNAUTHORIZED' }, 401);
  }
  const token = await verifyProxyToken(match[1], c.env.ENCRYPTION_KEY ?? '');
  if (!token) {
    return c.json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' }, 401);
  }
  // The token is bound to a session - reject a token replayed against a
  // different session's proxy path.
  if (token.sid !== sid) {
    return c.json({ error: 'Token session mismatch', code: 'UNAUTHORIZED' }, 401);
  }

  // Provider allowlist (SSRF guard) - only after auth so unauthenticated
  // callers cannot probe which providers exist.
  if (!ALLOWED_PROVIDERS.has(provider)) {
    return c.json({ error: 'Unsupported provider', code: 'BAD_PROVIDER' }, 400);
  }

  // Reconstruct the remainder path after `/api/llm/:sid/:provider`. c.req.path
  // is the full matched path; everything after the provider segment (plus the
  // original query string) is forwarded verbatim to the upstream.
  const url = new URL(c.req.url);
  const prefix = `/api/llm/${sid}/${provider}`;
  const remainderPath = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length)
    : '';
  const upstreamUrl = `${c.env.AIG_GATEWAY_URL}/${provider}${remainderPath}${url.search}`;

  // Build the forwarded headers: passthrough everything except the stripped
  // set, then stamp the gateway authorization + per-user metadata. The
  // metadata user is the OPAQUE token.user (never an email).
  const forwardHeaders = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  });
  forwardHeaders.set('cf-aig-authorization', `Bearer ${c.env.AIG_TOKEN ?? ''}`);
  forwardHeaders.set('cf-aig-metadata', JSON.stringify({ user: token.user }));

  try {
    // Forward the request body stream directly - no .text()/.json() buffering,
    // so a streaming upload (and the upstream SSE response) passes through with
    // constant memory. GET/HEAD carry no body; pass undefined to avoid the
    // runtime rejecting a body on a bodyless method.
    const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    const upstream = await fetch(
      new Request(upstreamUrl, {
        method: c.req.method,
        headers: forwardHeaders,
        body: hasBody ? c.req.raw.body : undefined,
      }),
    );

    // Stream the upstream response straight back. Returning upstream.body
    // (the ReadableStream) WITHOUT reading it preserves text/event-stream and
    // chunked transfer - the SSE tokens reach the agent as they arrive.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  } catch (err) {
    logger.error('LLM proxy upstream fetch failed', toError(err));
    return c.json({ error: 'Upstream request failed', code: 'UPSTREAM_FAILED' }, 502);
  }
});

export default app;
