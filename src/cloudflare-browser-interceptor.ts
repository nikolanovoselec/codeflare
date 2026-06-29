/**
 * CloudflareBrowserInterceptor — enterprise-mode outbound Browser Rendering credential
 * injection (REQ-BROWSER-008).
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
 * Dormant on non-enterprise deploys: the DO only wires this when ENTERPRISE_MODE=active and an
 * admin Browser Rendering token + account are configured, so this class is otherwise unreached.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { createLogger } from './lib/logger';

const logger = createLogger('cf-browser-interceptor');

/** The single CF API host the container reaches for Browser Rendering (browser-run + CDP). */
export const INTERCEPTED_CF_BROWSER_HOSTS: readonly string[] = ['api.cloudflare.com'];

/** Per-session props attached when the DO instantiates this entrypoint (bound at wiring). */
interface BrowserInterceptorProps {
  /** The wizard-configured Browser Rendering account id; ONLY this account's path is trusted. */
  browserAccountId?: string;
  /** The real admin "Browser Rendering - Edit" token, resolved worker-side at wiring. */
  browserToken?: string;
  /** Strict gateway egress: route non-trusted api.cloudflare.com via env.EGRESS, else 403. */
  strict?: boolean;
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
