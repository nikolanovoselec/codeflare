/**
 * CloudflareBrowserInterceptor — outbound `api.cloudflare.com` credential injection, two modes:
 *   (1) enterprise Browser Rendering admin-token injection (REQ-BROWSER-008);
 *   (2) non-enterprise OAuth mode (REQ-AGENT-078) — stamps a freshly-refreshed per-user Cloudflare
 *       OAuth token on EVERY api.cloudflare.com request (as `Authorization`) AND on the AI Gateway
 *       data-plane `gateway.ai.cloudflare.com` (as `cf-aig-authorization`, the token's aig.run scope),
 *       so `wrangler`, browser-run, and AI Gateway all survive past the short OAuth access-token
 *       lifetime, with the real token never entering the container. The gateway host is OAuth-mode
 *       ONLY (INTERCEPTED_CF_OAUTH_HOSTS) — enterprise never wires it, so the enterprise LlmInterceptor
 *       keeps emitting its own gateway rewrites direct.
 * Only ONE interceptor can bind a host, so a single class serves both (the DO picks the mode via
 * props: `bucket` ⇒ OAuth mode; `browserAccountId`/`browserToken` ⇒ enterprise mode).
 *
 * A WorkerEntrypoint the container DO wires into container egress for `api.cloudflare.com`
 * via `ctx.container.interceptOutboundHttps` (see src/container/index.ts
 * wireCloudflareBrowserInterception). Wired in enterprise ALWAYS (independent of the strict
 * Gateway egress toggle) so browser-run works in every enterprise configuration, the way it
 * did when the token rode the container env. Per-host registration TAKES PRECEDENCE over the
 * strict-egress `'*'` catch-all (SDK precedence: deniedHosts > per-host > catch-all), so when
 * strict is on this interceptor — not the EgressController — handles `api.cloudflare.com`.
 *
 * The container holds only the NON-SECRET placeholder `CLOUDFLARE_API_TOKEN`
 * (`ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER`), so the browser-run MCP servers / Pi `browser_*`
 * extension run in authed mode but never possess the real credential. Each intercepted
 * request is routed HERE:
 *   - TRUSTED path — `api.cloudflare.com/client/v4/accounts/<browserAccountId>/browser-rendering/*`
 *     where `<browserAccountId>` equals the SETUP-WIZARD-configured Browser Rendering account
 *     (props, bound at wiring): strip the placeholder `authorization`, inject the real
 *     "Browser Rendering - Edit" token (resolved worker-side at wiring), egress DIRECT
 *     (own-account platform backend, AD86). REST and the CDP WebSocket upgrade
 *     (`/browser-rendering/devtools/...`) are both handled — the WS is bridged via a fresh
 *     `WebSocketPair` so the socket actually returns to the container.
 *   - EVERYTHING ELSE on `api.cloudflare.com` (a different account id, or any non-
 *     `browser-rendering` path): the container has no business reaching it in enterprise.
 *     "rest → gateway": forward through `env.EGRESS` (the customer's Zero Trust Gateway) for
 *     inspection when strict is on; otherwise fail closed (403). The real token is NEVER
 *     injected on this path — it can only ever reach the one configured account's Browser
 *     Rendering API.
 *
 * Fail closed: the trusted path with no configured token returns 401 WITHOUT any upstream
 * request; the non-trusted path returns 403 (non-strict) or 503 (strict but EGRESS unbound).
 *
 * Wiring: in enterprise the DO wires this for api.cloudflare.com when an admin Browser Rendering
 * token + account are configured (mode 1, `wireCloudflareBrowserInterception`); in non-enterprise
 * it wires this for OAuth "Connect to Cloudflare" sessions with only the bound bucket in props
 * (mode 2, `wireCloudflareApiInterception`). Otherwise unreached.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { createLogger } from './lib/logger';
import { getValidCloudflareToken } from './lib/cloudflare-token';

const logger = createLogger('cf-browser-interceptor');

/** The single CF API host the container reaches for Browser Rendering (browser-run + CDP). */
export const INTERCEPTED_CF_BROWSER_HOSTS: readonly string[] = ['api.cloudflare.com'];

/** The AI Gateway data-plane host, intercepted ONLY in non-enterprise OAuth mode. */
const AI_GATEWAY_HOST = 'gateway.ai.cloudflare.com';

/**
 * Hosts intercepted in NON-enterprise OAuth mode (REQ-AGENT-078). Superset of the enterprise
 * browser host: adds `gateway.ai.cloudflare.com` so a connected user's AI Gateway data-plane
 * (compat) requests are stamped with the OAuth token's AI-Gateway-Run auth (cf-aig-authorization).
 * ENTERPRISE MUST NOT wire this list — the enterprise `LlmInterceptor` already emits gateway
 * calls that egress DIRECT, and intercepting them here would break enterprise LLM routing.
 */
export const INTERCEPTED_CF_OAUTH_HOSTS: readonly string[] = ['api.cloudflare.com', AI_GATEWAY_HOST];

/** Per-session props attached when the DO instantiates this entrypoint (bound at wiring). */
interface BrowserInterceptorProps {
  /** The wizard-configured Browser Rendering account id; ONLY this account's path is trusted. */
  browserAccountId?: string;
  /** The real admin "Browser Rendering - Edit" token, resolved worker-side at wiring. */
  browserToken?: string;
  /** Strict gateway egress: route non-trusted api.cloudflare.com via env.EGRESS, else 403. */
  strict?: boolean;
  /**
   * NON-enterprise OAuth mode (REQ-AGENT-078): the bound per-session bucket. When set, this
   * interceptor stamps a FRESH `getValidCloudflareToken(bucket)` on EVERY api.cloudflare.com
   * request (wrangler + browser-run), so the user's short-lived OAuth token is refreshed at the
   * boundary and never sits in the container. Mutually exclusive with the enterprise props above
   * (different wiring paths) — enterprise never sets `bucket`, so its path stays byte-identical.
   */
  bucket?: string;
}

/**
 * Request headers stripped before forwarding the TRUSTED path upstream. The container's auth is
 * a non-secret placeholder; it must never ride upstream — the real token is stamped fresh.
 * `upgrade`/`connection`/`sec-websocket-*` are deliberately PRESERVED so the CDP WS handshake
 * survives. host/content-length are recomputed by the runtime.
 */
const STRIPPED_REQUEST_HEADERS: readonly string[] = ['authorization', 'host', 'content-length'];

/** Response headers stripped before the upstream response re-enters the container. */
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

function jsonError(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * True ONLY for the wizard-configured browser account's `/browser-rendering/*` path on
 * api.cloudflare.com. Fail-secure: an absent/empty configured account matches nothing.
 */
export function isBrowserRenderingPath(url: URL, browserAccountId: string | undefined): boolean {
  const acct = (browserAccountId ?? '').trim();
  if (!acct) return false;
  const host = url.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'api.cloudflare.com' && url.pathname.startsWith(`/client/v4/accounts/${acct}/browser-rendering/`);
}

export class CloudflareBrowserInterceptor extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const props = (this.ctx as unknown as { props?: BrowserInterceptorProps }).props;

    // NON-enterprise OAuth mode (REQ-AGENT-078): stamp a fresh, refreshed token on EVERY
    // api.cloudflare.com path. Keyed on the bound bucket; `bucket` is never set in enterprise
    // (which wires browserAccountId/browserToken) — so the enterprise path below is untouched.
    if (props?.bucket) return this.fetchOAuth(request, url, props.bucket);

    const browserAccountId = props?.browserAccountId;
    const browserToken = props?.browserToken;
    const strict = props?.strict === true;
    const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    if (!isBrowserRenderingPath(url, browserAccountId)) {
      // Not the configured account's browser-rendering path. The container has no business
      // calling any other api.cloudflare.com endpoint in enterprise (no deploy token exists).
      // "rest → gateway": forward through env.EGRESS (inspected) when strict; else fail closed.
      if (!strict) return jsonError(403, 'CF_API_BLOCKED', 'Cloudflare API access is not permitted');
      const egress = this.env.EGRESS;
      if (!egress) return jsonError(503, 'EGRESS_UNAVAILABLE', 'Strict gateway egress unavailable');
      try {
        const upstream = await egress.fetch(request);
        return isWs ? this.bridge(upstream) : this.relay(upstream);
      } catch (err) {
        console.error('CloudflareBrowserInterceptor: gateway forward failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return jsonError(502, 'CF_API_FETCH_FAILED', 'Failed to reach Cloudflare API');
      }
    }

    // Trusted path: require the real token. Fail closed — never forward the placeholder.
    if (!browserToken) {
      logger.warn('no admin Browser Rendering token configured; failing closed');
      return jsonError(401, 'BROWSER_NO_TOKEN', 'Browser Rendering token not configured');
    }

    // Strip the container placeholder + recomputed headers, then stamp the real token.
    // Own-account platform backend ⇒ egress DIRECT (AD86), never cf1:network.
    const headers = new Headers(request.headers);
    for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);
    headers.set('authorization', `Bearer ${browserToken}`);

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    let upstream: Response;
    try {
      upstream = await fetch(
        new Request(url.toString(), {
          method: request.method,
          headers,
          body: hasBody ? request.body : undefined,
          redirect: 'manual',
        }),
      );
    } catch (err) {
      console.error('CloudflareBrowserInterceptor: upstream fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'BROWSER_FETCH_FAILED', 'Failed to reach Browser Rendering');
    }
    return isWs ? this.bridge(upstream) : this.relay(upstream);
  }

  /**
   * OAuth mode (REQ-AGENT-078, non-enterprise): resolve a FRESH token for the bound bucket
   * (`getValidCloudflareToken` refreshes via the stored refresh_token), stamp it on EVERY
   * api.cloudflare.com request/upgrade, and forward DIRECT. The container holds only the
   * placeholder. Fail closed 401 (no upstream) when no valid token can be minted. Identity is
   * the bound bucket ONLY — never read from the request (no cross-user spoofing).
   */
  private async fetchOAuth(request: Request, url: URL, bucket: string): Promise<Response> {
    let token: string | null;
    try {
      token = await getValidCloudflareToken(this.env, bucket);
    } catch (err) {
      console.error('CloudflareBrowserInterceptor(oauth): token lookup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'CF_TOKEN_LOOKUP_FAILED', 'Cloudflare credential lookup failed');
    }
    if (!token) {
      console.warn('CloudflareBrowserInterceptor(oauth): no valid Cloudflare token; failing closed');
      return jsonError(401, 'CF_NOT_CONNECTED', 'Cloudflare not connected');
    }

    // Recompute host/content-length, then stamp the fresh token. Own-account API ⇒ egress DIRECT.
    // Two auth transports, mirroring the enterprise LlmInterceptor: the AI Gateway data-plane
    // (gateway.ai.cloudflare.com) authenticates via `cf-aig-authorization` (the OAuth token's
    // AI-Gateway-Run scope), leaving the caller's `Authorization` (upstream provider / BYOK key)
    // untouched; api.cloudflare.com authenticates via standard `Authorization` (the placeholder
    // is stripped and replaced). WS handshake headers are preserved on both.
    const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');
    if (url.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '') === AI_GATEWAY_HOST) {
      // Interceptor-owned control header: strip any container-supplied value, then stamp fresh.
      headers.delete('cf-aig-authorization');
      headers.set('cf-aig-authorization', `Bearer ${token}`);
    } else {
      headers.delete('authorization');
      headers.set('authorization', `Bearer ${token}`);
    }

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    let upstream: Response;
    try {
      upstream = await fetch(
        new Request(url.toString(), {
          method: request.method,
          headers,
          body: hasBody ? request.body : undefined,
          redirect: 'manual',
        }),
      );
    } catch (err) {
      console.error('CloudflareBrowserInterceptor(oauth): upstream fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'CF_API_FETCH_FAILED', 'Failed to reach Cloudflare API');
    }
    return isWs ? this.bridge(upstream) : this.relay(upstream);
  }

  /** Stream a normal HTTP response back, stripping hop-by-hop + set-cookie. */
  private relay(upstream: Response): Response {
    const headers = new Headers(upstream.headers);
    for (const h of RESPONSE_STRIPPED_HEADERS) headers.delete(h);
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  /**
   * Bridge a CDP WebSocket: accept+forward both ends of a fresh WebSocketPair to the upstream
   * socket and return a 101 carrying the client end. Returning the upstream response as-is does
   * NOT hand the socket back to the container (it stalls and is canceled).
   */
  private bridge(upstream: Response): Response {
    const upstreamWs = (upstream as unknown as { webSocket?: WebSocket }).webSocket;
    if (!upstreamWs) return this.relay(upstream); // not a 101 (e.g. an error) — surface it
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    upstreamWs.accept();
    server.accept();
    server.addEventListener('message', (e) => { try { upstreamWs.send(e.data); } catch { /* peer gone */ } });
    upstreamWs.addEventListener('message', (e) => { try { server.send(e.data); } catch { /* peer gone */ } });
    server.addEventListener('close', (e) => { try { upstreamWs.close(e.code, e.reason); } catch { /* already closed */ } });
    upstreamWs.addEventListener('close', (e) => { try { server.close(e.code, e.reason); } catch { /* already closed */ } });
    server.addEventListener('error', () => { try { upstreamWs.close(1011, 'client error'); } catch { /* noop */ } });
    upstreamWs.addEventListener('error', () => { try { server.close(1011, 'upstream error'); } catch { /* noop */ } });
    return new Response(null, { status: 101, webSocket: client });
  }
}
