/**
 * LlmInterceptor — enterprise-mode outbound LLM interception (REQ-ENTERPRISE-004).
 *
 * A WorkerEntrypoint instantiated per container session via
 * `ctx.exports.LlmInterceptor({ props: { user } })` and wired into the
 * container's egress with `ctx.container.interceptOutboundHttps(host, worker)`
 * (see src/container/index.ts onStart). The container's HTTPS calls to the real
 * provider hosts (api.anthropic.com / api.openai.com) are routed HERE at the
 * platform level — they never leave for the public internet, so this path is
 * never exposed to Cloudflare Access and NO credential, gateway URL, or token is
 * ever placed inside the container.
 *
 * This entrypoint holds the AI Gateway secrets (AIG_GATEWAY_URL + AIG_TOKEN,
 * from the Worker env) and forwards each request to the customer's AI Gateway
 * with the gateway authorization + per-user attribution stamped on. The user id
 * comes from the per-session DO props — the opaque bucket id, never an email.
 *
 * Dormant on non-enterprise deploys: the DO only wires interception when
 * ENTERPRISE_MODE=active, so this class is never instantiated otherwise.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';

/**
 * Map an intercepted provider host to its AI Gateway provider segment. The DO
 * only ever intercepts these exact hosts (see setupEnterpriseInterception), so
 * an unmapped host reaching fetch() is a misconfiguration and fails closed.
 */
const HOST_PROVIDER: Readonly<Record<string, 'anthropic' | 'compat'>> = {
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'compat',
};

/** Hosts the DO must intercept for enterprise LLM routing (mirrors HOST_PROVIDER). */
export const INTERCEPTED_LLM_HOSTS: readonly string[] = Object.keys(HOST_PROVIDER);

/**
 * Request headers stripped before forwarding upstream. The agent sends a
 * NON-SECRET placeholder Authorization (the ANTHROPIC_AUTH_TOKEN / provider key
 * entrypoint.sh sets to put each CLI in API mode); it must never reach the
 * gateway — gateway auth is stamped separately as cf-aig-authorization.
 * Hop-by-hop / CF-managed headers are dropped so the upstream fetch builds clean.
 */
const STRIPPED_HEADERS: readonly string[] = [
  'authorization',
  'x-api-key',
  'host',
  'content-length',
  'cf-aig-authorization',
  'cf-aig-metadata',
];

/**
 * Response headers stripped before the upstream response reaches the container.
 * Hop-by-hop headers (RFC 7230 §6.1) are connection-scoped and must not be
 * forwarded; transfer-encoding is re-derived by the runtime for the streamed
 * body; set-cookie must never cross the gateway boundary into the agent's client.
 */
const RESPONSE_STRIPPED_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
];

/** Per-session props attached when the DO instantiates this entrypoint. */
interface InterceptorProps {
  user: string;
}

export class LlmInterceptor extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const rawGatewayBase = this.env.AIG_GATEWAY_URL;
    if (!rawGatewayBase) {
      // Enterprise deploy with interception wired but no gateway configured:
      // fail closed rather than letting the request fall through anywhere.
      return new Response(JSON.stringify({ error: 'LLM gateway not configured', code: 'GATEWAY_UNAVAILABLE' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Drop any trailing slash so the provider-path join below can never produce a
    // double slash (e.g. {gateway}//anthropic) against a sloppily-set secret.
    const gatewayBase = rawGatewayBase.replace(/\/+$/, '');

    const url = new URL(request.url);
    const provider = HOST_PROVIDER[url.hostname];
    if (!provider) {
      return new Response(JSON.stringify({ error: 'Unsupported provider host', code: 'BAD_PROVIDER' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Map the provider's native path onto the gateway provider path:
    //   anthropic: https://api.anthropic.com/v1/messages
    //              -> {gateway}/anthropic/v1/messages       (path kept verbatim)
    //   compat:    https://api.openai.com/v1/chat/completions
    //              -> {gateway}/compat/chat/completions      (leading /v1 dropped;
    //              the AI Gateway OpenAI-compatible endpoint is /compat/*)
    let path = url.pathname;
    if (provider === 'compat') {
      // The AI Gateway OpenAI-compatible endpoint is /compat/*; the agent's
      // OpenAI-style client always calls /v1/<route>. Anything else is a
      // misconfiguration — fail closed rather than forward a path the gateway
      // would not recognize.
      if (!path.startsWith('/v1/')) {
        return new Response(JSON.stringify({ error: 'Unsupported compat path', code: 'BAD_PATH' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      path = path.slice('/v1'.length);
    }
    const upstreamUrl = `${gatewayBase}/${provider}${path}${url.search}`;

    const headers = new Headers(request.headers);
    for (const h of STRIPPED_HEADERS) headers.delete(h);
    if (this.env.AIG_TOKEN) {
      headers.set('cf-aig-authorization', `Bearer ${this.env.AIG_TOKEN}`);
    }
    // Per-user attribution. The user is the opaque per-user bucket id passed as
    // a DO prop at interception-setup time — never an email.
    const props = (this.ctx as unknown as { props?: InterceptorProps }).props;
    const user = props?.user;
    if (!user) {
      // Attribution degrades to 'unknown'; log it so a gap in the gateway's
      // per-user analytics is diagnosable rather than silently missing.
      console.warn('LlmInterceptor: per-session user prop absent; cf-aig-metadata user=unknown');
    }
    headers.set('cf-aig-metadata', JSON.stringify({ user: user ?? 'unknown' }));

    // Stream the body straight through (no .text()/.json() buffering) so SSE
    // token streams and streaming uploads pass with constant memory. GET/HEAD
    // carry no body; pass undefined so the runtime does not reject a body on a
    // bodyless method.
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const upstream = await fetch(
      new Request(upstreamUrl, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        // Do not transparently follow gateway/provider redirects — a 3xx would
        // otherwise be chased to an arbitrary Location host. Surface it to the
        // agent's client instead.
        redirect: 'manual',
      }),
    );

    // Strip hop-by-hop and cookie headers from the upstream response before it
    // reaches the container. Hop-by-hop headers (RFC 7230 §6.1) are connection-
    // scoped and must not be forwarded; transfer-encoding is re-derived by the
    // runtime for the streamed body; set-cookie has no business crossing into the
    // agent's HTTP client.
    const responseHeaders = new Headers(upstream.headers);
    for (const h of RESPONSE_STRIPPED_HEADERS) responseHeaders.delete(h);

    // Returning upstream.body (the ReadableStream) WITHOUT reading it preserves
    // text/event-stream + chunked transfer — tokens reach the agent as they arrive.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }
}
