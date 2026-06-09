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
 * over two transports — the REST API (`api.cloudflare.com/.../ai/v1/*`) first,
 * falling back to the deprecated-but-functional compat path
 * (`gateway.ai.cloudflare.com/v1/{acct}/{gw}/compat/*`) on a 404 — with the
 * gateway authorization + per-user attribution stamped on. The user id comes
 * from the per-session DO props — the user's email, so the gateway's per-user
 * analytics attribute usage to the real identity (an enterprise requirement).
 *
 * The enterprise agent set (REQ-ENTERPRISE-003) is OpenAI-wire-format only
 * (Copilot, Pi): they call api.openai.com and their requests map onto the
 * gateway's OpenAI-compatible REST endpoint. Backend model selection — native
 * provider, Amazon Bedrock, Workers AI, or a dynamic route — is gateway-side.
 * The Worker maps each agent-sent slash-free handle to a gateway dynamic route
 * `dynamic/<route>` from the Setup-configured catalog in KV (see fetch() and
 * loadRouteCatalog), failing safe to the default route on an unknown handle: the
 * agent only needs a clean, slash-free model id to reach this host, and the
 * gateway route name never enters the container. This sidesteps Pi parsing a
 * `dynamic/<route>` model id as `provider/id` and misrouting to a built-in
 * provider (the request would never reach this host).
 * Auth is per transport: the REST API takes `Authorization: Bearer <AIG_TOKEN>`
 * (the token's Workers AI scope); the compat fallback takes `cf-aig-authorization:
 * Bearer <AIG_TOKEN>` (the token's AI Gateway Run scope) — so AIG_TOKEN must hold
 * BOTH scopes. The REST API does not carry every provider (google-ai-studio 404s),
 * so compat — which carries all providers + dynamic routing — backstops it until
 * CF migrates them onto the REST API (see AD74, dual transport).
 *
 * Dormant on non-enterprise deploys: the DO only wires interception when
 * ENTERPRISE_MODE=active, so this class is never instantiated otherwise.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { SETUP_KEYS } from './lib/kv-keys';

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
  // container. (cf-aig-gateway-id and cf-aig-metadata are re-set after stripping;
  // cf-aig-authorization is re-set only on the compat leg, so stripping it here
  // also stops a container-supplied value from riding the REST leg unset.)
  'cf-aig-metadata',
  'cf-aig-gateway-id',
  'cf-aig-authorization',
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
  /** The user's email — stamped into cf-aig-metadata for per-user gateway analytics. */
  user: string;
  /**
   * The user's matched Cloudflare Access groups, when the deployment configures
   * group gating. Each becomes one cf-aig-metadata tag (group_<sanitized>=1) so
   * the gateway can branch routing/cost/rate-limit policies per group with an
   * equals filter (CF metadata log filters support equals/not-equals only — no
   * contains — so per-group KEYS, not a CSV value). Omitted when empty.
   */
  groups?: string[];
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

/**
 * OpenAI-only request fields that non-OpenAI providers reject with a 400
 * ("Invalid JSON payload received. Unknown name ..."). Cloudflare's compat layer
 * forwards them verbatim, so the interceptor strips them — but ONLY on the compat
 * fallback leg (see fetch()), which is the only path that reaches a non-OpenAI
 * provider (e.g. google-ai-studio). The REST/OpenAI leg keeps them so OpenAI
 * prompt caching (`prompt_cache_key`) and `store` are unaffected.
 */
const COMPAT_INCOMPATIBLE_FIELDS = ['store', 'prompt_cache_key'] as const;

/** Return `raw` with COMPAT_INCOMPATIBLE_FIELDS removed; non-JSON/non-object bodies pass through unchanged. */
function stripOpenAiOnlyFields(raw: string): string {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      for (const field of COMPAT_INCOMPATIBLE_FIELDS) delete payload[field];
      return JSON.stringify(payload);
    }
  } catch {
    /* not JSON: forward the original bytes unchanged */
  }
  return raw;
}

// CF AI Gateway metadata keys must be simple strings; a group name can contain
// spaces / punctuation / unicode. Sanitize to [a-z0-9_]: lowercase, replace each
// run of non-[a-z0-9] with a single '_', trim leading/trailing '_'. To avoid two
// distinct group names colliding onto the same sanitized key (e.g. "Dev Team" and
// "dev-team" both → "dev_team"), append a short stable hash suffix of the ORIGINAL
// name so the key is unique per source name while staying equals-filterable.
const MAX_METADATA_TAGS = 5; // CF hard cap; extras are silently dropped upstream.
function sanitizeGroupKey(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'group';
  // djb2-ish short hash of the original (collision avoidance across sanitized keys).
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  return `group_${base}_${h.toString(36)}`;
}

/**
 * Normalize a streaming chat-completions SSE body so it always ends with a
 * terminal `finish_reason` chunk before `data: [DONE]`.
 *
 * Cloudflare AI Gateway **dynamic routes** drop the terminal
 * `{"choices":[{"delta":{},"finish_reason":"stop"}]}` chunk (and the usage
 * chunk) when they re-emit a streamed response: the content arrives but the
 * stream ends with `finish_reason: null` then `[DONE]`. Verified against the
 * live gateway — the same model is conformant non-streaming and when called
 * directly, but the dynamic-route streaming path strips the terminator. Strict
 * OpenAI-wire clients (Pi, Copilot) treat that as an incomplete stream, error
 * with "Stream ended without finish_reason", and retry — multiplying token cost.
 *
 * This transform passes every byte through verbatim and, when `[DONE]` arrives
 * (or the stream ends) without a preceding non-null `finish_reason`, injects one
 * synthetic terminator chunk first. It is idempotent — when the upstream already
 * sends a non-null `finish_reason` (non-dynamic-route backends, non-streaming)
 * nothing is injected. The synthesized reason is `tool_calls` when the stream
 * carried tool-call deltas, otherwise `stop`, so a tool-calling turn is not
 * falsely terminated as complete.
 */
function ensureStreamTerminator(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let sawFinishReason = false;
  let sawDone = false;
  let sawToolCall = false;
  const meta: { id?: string; model?: string; created?: number } = {};

  const isDone = (line: string): boolean => {
    const t = line.trim();
    return t === 'data: [DONE]' || t === 'data:[DONE]';
  };

  const inspect = (line: string): void => {
    const t = line.trimStart();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(t.indexOf(':') + 1).trim();
    if (payload === '[DONE]') return;
    try {
      const obj = JSON.parse(payload) as {
        id?: string;
        model?: string;
        created?: number;
        choices?: Array<{ finish_reason?: string | null; delta?: { tool_calls?: unknown } }>;
      };
      if (obj.id) meta.id = obj.id;
      if (obj.model) meta.model = obj.model;
      if (typeof obj.created === 'number') meta.created = obj.created;
      // Scan every choice (not just [0]) so an n>1 stream that carries the
      // finish_reason on a later choice is still recognized as terminated.
      for (const choice of obj.choices ?? []) {
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) sawFinishReason = true;
        if (choice.delta?.tool_calls) sawToolCall = true;
      }
    } catch {
      /* non-JSON data line (comment / keepalive): ignore */
    }
  };

  const terminator = (): string => {
    const chunk = {
      id: meta.id ?? 'codeflare-terminator',
      object: 'chat.completion.chunk',
      created: meta.created ?? Math.floor(Date.now() / 1000),
      model: meta.model ?? 'unknown',
      choices: [{ index: 0, delta: {}, finish_reason: sawToolCall ? 'tool_calls' : 'stop' }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };

  const handle = (line: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (isDone(line)) {
      if (!sawFinishReason) {
        controller.enqueue(encoder.encode(terminator()));
        sawFinishReason = true;
      }
      sawDone = true;
      controller.enqueue(encoder.encode(line));
      return;
    }
    inspect(line);
    controller.enqueue(encoder.encode(line));
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx + 1);
        buffer = buffer.slice(idx + 1);
        handle(line, controller);
      }
    },
    flush(controller) {
      // If the final buffered line arrived without its trailing newline (a
      // doubly-malformed upstream: no frame terminator AND no [DONE]), insert a
      // frame boundary before any synthesized chunk so it is not concatenated
      // onto the partial line.
      let sep = '';
      if (buffer.length > 0) {
        if (!isDone(buffer) && !buffer.endsWith('\n')) sep = '\n\n';
        handle(buffer, controller);
        buffer = '';
      }
      // Stream ended with neither [DONE] nor any finish_reason: synthesize both
      // so the client sees a complete turn rather than a dangling stream.
      if (!sawDone && !sawFinishReason && (meta.id !== undefined || meta.model !== undefined)) {
        controller.enqueue(encoder.encode(sep + terminator()));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }
    },
  });
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

    // Two AI Gateway transports, tried in order — see AD74 (dual transport):
    //   1. REST API — api.cloudflare.com/client/v4/accounts/{acct}/ai/v1/<path>.
    //      Auth: Authorization: Bearer (AIG_TOKEN's Workers AI scope); gateway by
    //      cf-aig-gateway-id header. Carries OpenAI + Workers AI + dynamic routes
    //      to those, but NOT every provider (google-ai-studio returns 404 here).
    //   2. compat — gateway.ai.cloudflare.com/v1/{acct}/{gw}/compat/<path>.
    //      Auth: cf-aig-authorization: Bearer (AIG_TOKEN's AI Gateway Run scope);
    //      gateway in the URL, BYOK supplies the provider key. Deprecated by CF
    //      but still functional, and carries ALL providers (incl. google-ai-studio)
    //      plus dynamic routing.
    // We try the REST API first and fall back to compat only on a 404 (below), so
    // as CF migrates providers onto the REST API the fallback stops firing and
    // traffic rides it with no code change. AIG_TOKEN therefore needs BOTH scopes.
    const restUrl = `https://api.cloudflare.com/client/v4/accounts/${gw.accountId}/ai${url.pathname}${url.search}`;
    const compatUrl = `https://gateway.ai.cloudflare.com/v1/${gw.accountId}/${gw.gatewayId}/compat${url.pathname.replace(/^\/v1/, '')}${url.search}`;

    // Common headers: strip the container's placeholder credential + CF-managed
    // headers and stamp per-user attribution (the user's email from the DO prop,
    // for the gateway's per-user analytics). Transport-specific auth/routing is
    // added per attempt below.
    const baseHeaders = new Headers(request.headers);
    for (const h of STRIPPED_HEADERS) baseHeaders.delete(h);
    const props = (this.ctx as unknown as { props?: InterceptorProps }).props;
    const user = props?.user;
    if (!user) {
      // Attribution degrades to 'unknown'; log it so a gap in the gateway's
      // per-user analytics is diagnosable rather than silently missing.
      console.warn('LlmInterceptor: per-session user prop absent; cf-aig-metadata user=unknown');
    }
    // Per-user + per-group attribution. One tag per matched group
    // (group_<sanitized>=1) so each is equals-filterable to drive Dynamic-Route
    // if/else (CF filters: equals/not-equals only). Budget: 1 user tag + up to
    // (MAX_METADATA_TAGS-1) group tags. CF silently drops extras past 5, so a
    // user matching more groups than fit is truncated DETERMINISTICALLY (configured
    // order, preserved from resolveUserAccessGroup) and the drop is LOGGED (never
    // silent). The scalar `group` tag is dropped entirely (revised contract).
    const metadata: Record<string, string | number> = { user: user ?? 'unknown' };
    const groups = props?.groups ?? [];
    const groupBudget = MAX_METADATA_TAGS - 1; // user always occupies one slot.
    const kept = groups.slice(0, groupBudget);
    if (groups.length > groupBudget) {
      console.warn(`LlmInterceptor: ${groups.length} matched groups exceed the ${groupBudget}-group metadata budget; keeping the first ${groupBudget} (configured order) and dropping ${groups.slice(groupBudget).join(', ')}`);
    }
    for (const g of kept) metadata[sanitizeGroupKey(g)] = 1;
    baseHeaders.set('cf-aig-metadata', JSON.stringify(metadata));

    // REST transport: standard Authorization header (Workers AI scope) + the
    // customer's named gateway in the cf-aig-gateway-id header.
    const restHeaders = new Headers(baseHeaders);
    if (this.env.AIG_TOKEN) restHeaders.set('authorization', `Bearer ${this.env.AIG_TOKEN}`);
    restHeaders.set('cf-aig-gateway-id', gw.gatewayId);

    // compat transport: cf-aig-authorization (AI Gateway Run scope); the gateway
    // is in the URL and BYOK supplies the provider key, so no Authorization header.
    const compatHeaders = new Headers(baseHeaders);
    if (this.env.AIG_TOKEN) compatHeaders.set('cf-aig-authorization', `Bearer ${this.env.AIG_TOKEN}`);

    // Request body. The RESPONSE is always streamed back unbuffered (below) so
    // SSE token streams pass with constant memory. The REQUEST body is normally
    // passed straight through too — GET/HEAD carry none, so pass undefined.
    //
    // Enterprise route mapping (the one rewrite): the Worker maps the agent-sent
    // slash-free handle (e.g. "development") to a gateway dynamic route
    // `dynamic/<route>` from the Setup-configured catalog (KV). The gateway selects
    // a dynamic route by `model: dynamic/<route>`, but Pi parses a slash-bearing
    // model id as `provider/id` and misroutes to a built-in provider — so a
    // `dynamic/...` id configured in the container never reaches this host. Letting
    // the agent carry only a clean, slash-free handle (which routes correctly to
    // api.openai.com) and stamping the real route HERE removes that whole class of
    // misconfiguration and keeps the route name out of the container. An unknown
    // handle fails safe to the default route. Buffering a chat request body (the
    // prompt) is cheap; only model-routable endpoints are rewritten, everything
    // else passes verbatim.
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const isModelRoutable = url.pathname.endsWith('/chat/completions') || url.pathname.endsWith('/responses');
    let outboundBody: BodyInit | null | undefined = hasBody ? request.body : undefined;
    if (hasBody && isModelRoutable) {
      // Buffer the body ONCE as text so it can be REPLAYED across both transports
      // on fallback (a stream could only be consumed once). Reading the inbound
      // stream can itself fail (a broken agent->Worker connection); surface that
      // as a clean 400 rather than letting the rejection escape as an opaque 500.
      let raw: string;
      try {
        raw = await request.text();
      } catch {
        return new Response(JSON.stringify({ error: 'Request body unreadable', code: 'BAD_REQUEST_BODY' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      outboundBody = raw;
      // Map the agent-sent slash-free handle (e.g. "development") to the gateway
      // dynamic route `dynamic/<name>`, from the Setup catalog (KV). An unknown
      // handle FAILS SAFE to the default route. A model-less / non-JSON body is
      // non-fatal — forward the original bytes unchanged.
      const catalog = await this.loadRouteCatalog();
      if (catalog.routes.length > 0) {
        try {
          const payload = JSON.parse(raw) as Record<string, unknown>;
          if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.model === 'string') {
            const handle = payload.model.replace(/^dynamic\//, ''); // tolerate a pre-prefixed handle
            const route = catalog.routes.includes(handle) ? handle : catalog.defaultRoute;
            payload.model = `dynamic/${route}`;
            outboundBody = JSON.stringify(payload);
          }
        } catch {
          /* not JSON: forward the original bytes unchanged */
        }
      }
    }
    // Send REST-first; fall back to compat only on a 404 for a model-routable
    // request with a replayable (buffered) body. The REST API returns 404 for a
    // provider it does not carry (e.g. google-ai-studio; a dynamic route resolving
    // to one surfaces the masked "Model execution failed", also 404). A 404 is a
    // complete error body — not a stream — so the replay never double-bills or
    // truncates a partial response. Genuine non-404 errors are returned as-is.
    const sendTo = (target: string, h: Headers, body: BodyInit | null | undefined = outboundBody): Promise<Response> =>
      fetch(
        new Request(target, {
          method: request.method,
          headers: h,
          body,
          // Do not transparently follow gateway/provider redirects — a 3xx would
          // otherwise be chased to an arbitrary Location host. Surface it to the
          // agent's client instead.
          redirect: 'manual',
        }),
      );

    let upstream: Response;
    try {
      upstream = await sendTo(restUrl, restHeaders);
      if (upstream.status === 404 && isModelRoutable && typeof outboundBody === 'string') {
        // Compat reaches non-OpenAI providers (e.g. google-ai-studio) that reject
        // OpenAI-only fields (store, prompt_cache_key) with a 400; strip them on
        // THIS leg only, so the REST/OpenAI leg above keeps prompt caching intact.
        upstream = await sendTo(compatUrl, compatHeaders, stripOpenAiOnlyFields(outboundBody));
      }
    } catch (err) {
      // A thrown fetch (DNS, TLS, connection reset to the gateway) would otherwise
      // escape as an opaque 500; surface it as a clean 502 and log the cause.
      console.error('LlmInterceptor: upstream gateway fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(JSON.stringify({ error: 'gateway fetch failed', code: 'GATEWAY_FETCH_FAILED' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Strip hop-by-hop and cookie headers from the upstream response before it
    // reaches the container. Returning upstream.body (the ReadableStream) WITHOUT
    // reading it preserves text/event-stream + chunked transfer — tokens reach
    // the agent as they arrive.
    const responseHeaders = new Headers(upstream.headers);
    for (const h of RESPONSE_STRIPPED_HEADERS) responseHeaders.delete(h);

    // Repair the dynamic-route streaming terminator (see ensureStreamTerminator):
    // only for streamed chat-completions responses; every other response (non-
    // streaming, /responses, errors) passes through byte-for-byte.
    const contentType = upstream.headers.get('content-type') ?? '';
    const isStreamingChat =
      contentType.includes('text/event-stream') && url.pathname.endsWith('/chat/completions');
    const responseBody =
      upstream.body && isStreamingChat ? upstream.body.pipeThrough(ensureStreamTerminator()) : upstream.body;

    return new Response(responseBody, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  /**
   * Load the Setup-configured dynamic-route catalog + resolved default route from
   * KV. SETUP_KEYS.DYNAMIC_ROUTES is a JSON string[] of route names;
   * SETUP_KEYS.DEFAULT_ROUTE is a JSON { route, reasoning } object written by the
   * Setup wizard (reasoning is container-side only — entrypoint reads it). The
   * default-route rule (locked, kept identical to loadEnterpriseRouteConfig in
   * access.ts): the explicit default if it is in the catalog; else the first
   * configured route; else (empty catalog) '' (no rewrite happens).
   */
  private async loadRouteCatalog(): Promise<{ routes: string[]; defaultRoute: string }> {
    // No KV binding ⇒ no catalog ⇒ no rewrite (forward the agent handle verbatim).
    if (!this.env.KV) return { routes: [], defaultRoute: '' };
    const rawCatalog = await this.env.KV.get(SETUP_KEYS.DYNAMIC_ROUTES);
    let routes: string[] = [];
    try { const p = JSON.parse(rawCatalog ?? '[]'); if (Array.isArray(p)) routes = p.filter((r): r is string => typeof r === 'string'); } catch { /* malformed → empty */ }
    const rawDefault = await this.env.KV.get(SETUP_KEYS.DEFAULT_ROUTE);
    let configuredDefault: string | null = null;
    try { const d = JSON.parse(rawDefault ?? 'null'); if (d && typeof d === 'object' && typeof (d as { route?: unknown }).route === 'string') configuredDefault = (d as { route: string }).route; } catch { /* malformed → none */ }
    const defaultRoute = (configuredDefault && routes.includes(configuredDefault))
      ? configuredDefault
      : (routes[0] ?? '');
    return { routes, defaultRoute };
  }
}
