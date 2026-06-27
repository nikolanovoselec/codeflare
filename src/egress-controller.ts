/**
 * EgressController — enterprise-mode strict Gateway egress for non-LLM/non-GitHub
 * hosts (REQ-ENTERPRISE-016).
 *
 * A WorkerEntrypoint the container DO wires as a catch-all (`interceptOutboundHttps('*',
 * controller)`) when strict Gateway egress is ON. Unlike the identity-stamping
 * LlmInterceptor / GitHubInterceptor (which own specific hosts and inject the real
 * credential), this is a TRANSPARENT PROXY for every other host: it stamps NO
 * identity, gateway URL, or token, and preserves the caller's `authorization` /
 * `cookie` / `set-cookie` verbatim. Its job is to force genuine direct-internet traffic
 * through the mandatory `env.EGRESS` Workers VPC binding (and the customer's Zero Trust
 * Gateway) for inspection, while letting the deployment's OWN-account platform
 * destinations (its R2 + account-scoped CF API / Browser Rendering) egress direct
 * ({@link isAccountScopedDestination}; account id from the DO via `ctx.props.accountId`).
 * WebSocket upgrades (browser-run CDP) are proxied verbatim — the 101 + `webSocket` is
 * returned as-is, never rebuilt.
 *
 * Fail-closed (the security point): a defense-in-depth re-check of the toggle (503
 * EGRESS_NOT_CONFIGURED) and an SSRF literal-IP guard (403 EGRESS_TARGET_BLOCKED,
 * before any send) precede the forward, which itself returns 503 EGRESS_UNAVAILABLE
 * with no global-fetch fallback when the binding is unbound.
 *
 * Dormant on non-enterprise deploys / when the toggle is OFF: the DO only wires the
 * catch-all when hasStrictGatewayEgress is true, so this class is otherwise unreached.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import {
  hasStrictGatewayEgress,
  controllerFetch,
  isDisallowedEgressHost,
  jsonError,
  STRIPPED_REQUEST_HOP_BY_HOP,
  RESPONSE_HOP_BY_HOP,
} from './lib/controller-egress';

export class EgressController extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    // Defense-in-depth: re-check the toggle even though the DO only wires this
    // catch-all when strict is ON. A stale wiring or a flipped-off toggle must
    // never let traffic through the controller path.
    if (!(await hasStrictGatewayEgress(this.env))) {
      return jsonError(503, 'EGRESS_NOT_CONFIGURED', 'Strict Gateway egress is not enabled');
    }

    const url = new URL(request.url);
    if (isDisallowedEgressHost(url.hostname)) {
      // Reject SSRF targets BEFORE any upstream send.
      return jsonError(403, 'EGRESS_TARGET_BLOCKED', 'Egress target host is not permitted');
    }

    // The deployment's own Cloudflare account id (passed by the DO at wiring time) selects
    // the account-scoped direct-egress exemption; every other host rides env.EGRESS (Gateway).
    const accountId = (this.ctx as unknown as { props?: { accountId?: string } }).props?.accountId;

    // WebSocket upgrades (e.g. browser-run CDP at /browser-rendering/devtools/...) must be
    // proxied VERBATIM: the hop-by-hop strip + response rebuild below would drop the Upgrade
    // handshake and the response's `webSocket`. Forward the original request untouched and
    // return the upstream 101 (carrying its webSocket) as-is (REQ-ENTERPRISE-016).
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      try {
        return await controllerFetch(this.env, request, accountId);
      } catch (err) {
        console.error('EgressController: WebSocket egress failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return jsonError(502, 'EGRESS_WS_FAILED', 'Failed to establish WebSocket egress');
      }
    }

    // Rebuild the request: strip ONLY hop-by-hop headers + the recomputed
    // host/content-length. NEVER add Authorization / cf-aig-* / identity headers —
    // this is a transparent proxy, so the caller's authorization + cookie pass through.
    const headers = new Headers(request.headers);
    for (const h of STRIPPED_REQUEST_HOP_BY_HOP) headers.delete(h);
    headers.delete('host');
    headers.delete('content-length');

    // GET/HEAD carry no body; everything else streams through unbuffered. Do not
    // follow redirects to an arbitrary Location host — surface the 3xx to the caller.
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const forward = new Request(url.toString(), {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    });

    let upstream: Response;
    try {
      upstream = await controllerFetch(this.env, forward, accountId);
    } catch (err) {
      console.error('EgressController: upstream fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'EGRESS_FETCH_FAILED', 'Failed to reach egress target');
    }

    // Stream the response back unread; strip ONLY hop-by-hop headers (preserve
    // set-cookie — transparent proxy).
    const responseHeaders = new Headers(upstream.headers);
    for (const h of RESPONSE_HOP_BY_HOP) responseHeaders.delete(h);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  }
}
