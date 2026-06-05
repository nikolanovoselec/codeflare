/**
 * LlmInterceptor — enterprise-mode outbound LLM interception (REQ-ENTERPRISE-004).
 *
 * A WorkerEntrypoint instantiated per container session via
 * `ctx.exports.LlmInterceptor({ props: { user } })` and wired into the
 * container's egress with `ctx.container.interceptOutboundHttps(host, worker)`
 * (see src/container/index.ts onStart). The container's HTTPS calls to the real
 * provider host (api.openai.com) are routed HERE at the platform level — they
 * never leave for the public internet, so this path is never exposed to
 * Cloudflare Access and NO credential, gateway URL, or token is ever placed
 * inside the container.
 *
 * This entrypoint holds the AI Gateway secrets (AIG_GATEWAY_URL + AIG_TOKEN,
 * from the Worker env) and forwards each request to the customer's AI Gateway
 * **REST API** (`api.cloudflare.com/client/v4/accounts/{acct}/ai/v1/*`) with the
 * gateway authorization + per-user attribution stamped on. The user id comes
 * from the per-session DO props — the opaque bucket id, never an email.
 *
 * The enterprise agent set (REQ-ENTERPRISE-003) is OpenAI-wire-format only
 * (Copilot, Pi): they call api.openai.com and their requests map onto the
 * gateway's OpenAI-compatible REST endpoint with NO body rewrite. Backend model
 * selection — native provider, Amazon Bedrock, Workers AI, or a dynamic route —
 * is gateway-side, chosen by the agent's configured model id (e.g.
 * `dynamic/<route>`). Auth is the standard `Authorization: Bearer <AIG_TOKEN>`
 * header (the AI Gateway REST API; the legacy `gateway.ai.cloudflare.com`
 * `/compat` + `/anthropic` paths it replaces are deprecated — see AD74).
 *
 * Dormant on non-enterprise deploys: the DO only wires interception when
 * ENTERPRISE_MODE=active, so this class is never instantiated otherwise.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';

/**
 * Hosts the DO must intercept for enterprise LLM routing. Only the OpenAI host
 * is intercepted: the enterprise agent set (REQ-ENTERPRISE-003) is OpenAI-wire-
 * format only (Copilot, Pi), so Anthropic-native traffic (Claude Code) never
 * occurs. An unmapped host reaching fetch() is a misconfiguration and fails closed.
 */
export const INTERCEPTED_LLM_HOSTS: readonly string[] = ['api.openai.com'];

/**
 * Request headers stripped before forwarding upstream. The agent sends a
 * NON-SECRET placeholder Authorization (the provider key entrypoint.sh sets to
 * put each CLI in API mode); it must never reach the gateway — gateway auth is
 * stamped separately as the standard Authorization header below. Hop-by-hop /
 * CF-managed headers are dropped so the upstream fetch builds clean.
 */
const STRIPPED_HEADERS: readonly string[] = [
  'authorization',
  'x-api-key',
  'host',
  'content-length',
  // cf-aig-* control headers are interceptor-owned: strip any client-supplied
  // value so they are set only from the Worker env / DO props below, never the
  // container. (cf-aig-gateway-id and cf-aig-metadata are re-set after stripping.)
  'cf-aig-metadata',
  'cf-aig-gateway-id',
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

/**
 * Parse the account id + gateway id out of AIG_GATEWAY_URL, whose form is
 * `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}[/...]`. The
 * REST API needs the account id in the URL path and the gateway id in the
 * cf-aig-gateway-id header; both are derived from this one already-configured
 * value, so the migration needs no new secret. Returns null when absent or
 * unparseable so the caller can fail closed.
 */
function parseGateway(raw: string | undefined): { accountId: string; gatewayId: string } | null {
  if (!raw) return null;
  const m = raw.match(/\/v1\/([^/?#]+)\/([^/?#]+)/);
  if (!m) return null;
  return { accountId: m[1], gatewayId: m[2] };
}

export class LlmInterceptor extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const gw = parseGateway(this.env.AIG_GATEWAY_URL);
    if (!gw) {
      // Enterprise deploy with interception wired but no gateway configured:
      // fail closed rather than letting the request fall through anywhere.
      return new Response(JSON.stringify({ error: 'LLM gateway not configured', code: 'GATEWAY_UNAVAILABLE' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    if (!INTERCEPTED_LLM_HOSTS.includes(url.hostname)) {
      return new Response(JSON.stringify({ error: 'Unsupported provider host', code: 'BAD_PROVIDER' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Map the OpenAI-style request onto the AI Gateway REST API. The agent calls
    // api.openai.com/v1/chat/completions (OpenAI SDK shape); the REST API serves
    // the OpenAI-compatible endpoint at /ai/v1/chat/completions under the account.
    //   api.openai.com/v1/chat/completions
    //   -> api.cloudflare.com/client/v4/accounts/{acct}/ai/v1/chat/completions
    // The path is forwarded verbatim under /ai, so /v1/responses etc. map too.
    const upstreamUrl = `https://api.cloudflare.com/client/v4/accounts/${gw.accountId}/ai${url.pathname}${url.search}`;

    const headers = new Headers(request.headers);
    for (const h of STRIPPED_HEADERS) headers.delete(h);
    // Gateway authentication: the REST API uses the standard Authorization
    // header carrying the authenticated-gateway "Run" token (AIG_TOKEN). This
    // replaces the legacy cf-aig-authorization header (AD74).
    if (this.env.AIG_TOKEN) {
      headers.set('authorization', `Bearer ${this.env.AIG_TOKEN}`);
    }
    // Route through the customer's named gateway: required for Workers AI models,
    // honoured for all providers and dynamic routes.
    headers.set('cf-aig-gateway-id', gw.gatewayId);
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
    // reaches the container. Returning upstream.body (the ReadableStream) WITHOUT
    // reading it preserves text/event-stream + chunked transfer — tokens reach
    // the agent as they arrive.
    const responseHeaders = new Headers(upstream.headers);
    for (const h of RESPONSE_STRIPPED_HEADERS) responseHeaders.delete(h);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }
}
