/**
 * EgressController — enterprise-mode strict Gateway egress for non-LLM/non-GitHub
 * hosts (REQ-ENTERPRISE-016).
 *
 * A WorkerEntrypoint the container DO wires as a catch-all (`interceptOutboundHttps('*',
 * controller)`) when strict Gateway egress is ON; the DO passes `{ accountId, strict }`
 * via props (resolved once at wiring — no per-request KV read). For most hosts it is a
 * TRANSPARENT PROXY: it stamps no identity and preserves the caller's `authorization` /
 * `cookie` / `set-cookie`, forcing genuine direct-internet traffic through the mandatory
 * `env.EGRESS` Workers VPC binding (the customer's Zero Trust Gateway) for inspection.
 *
 * The deployment's OWN-account platform destinations egress DIRECT, never cf1:network
 * ({@link isAccountScopedDestination}; account id from `ctx.props.accountId`):
 *   - own R2 ({@link isOwnAccountR2}): the container's PLACEHOLDER `authorization` is
 *     STRIPPED and the request is RE-SIGNED with the worker-held R2 key (aws4fetch,
 *     reusing the request's `x-amz-content-sha256` so the body streams through unbuffered
 *     and SSE-C headers are preserved) — so the real R2 key never enters the container.
 *   - own account-scoped CF API / Browser Rendering: transparent passthrough (the scoped
 *     "Browser Rendering - Edit" token rides through in the container per REQ-BROWSER-007).
 *
 * WebSocket upgrades (browser-run CDP) are proxied by BRIDGING a fresh `WebSocketPair` to
 * the upstream socket (accept both ends, forward frames/close/error) and returning a 101
 * carrying the client end — returning the upstream response as-is does NOT propagate the
 * socket back to the container (it just stalls and is canceled).
 *
 * Fail-closed (the security point): a defense-in-depth re-check of the `strict` prop (503
 * EGRESS_NOT_CONFIGURED) and an SSRF literal-IP guard (403 EGRESS_TARGET_BLOCKED, before
 * any send) precede the forward, which itself returns 503 EGRESS_UNAVAILABLE with no
 * global-fetch fallback when the binding is unbound.
 *
 * Dormant on non-enterprise deploys / when the toggle is OFF: the DO only wires the
 * catch-all when strict is true, so this class is otherwise unreached.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import {
  controllerFetch,
  isAccountScopedDestination,
  isOwnAccountR2,
  isDisallowedEgressHost,
  jsonError,
  STRIPPED_REQUEST_HOP_BY_HOP,
  RESPONSE_HOP_BY_HOP,
} from './lib/controller-egress';
import { createR2Client } from './lib/r2-client';

/** Props the container DO passes at wiring time (resolved once, never per-request). */
interface EgressProps {
  /** This deployment's own Cloudflare account id; selects the account-scoped exemption. */
  accountId?: string;
  /** Strict Gateway egress toggle, read once at wiring (the DO only wires when true). */
  strict?: boolean;
}

export class EgressController extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx as unknown as { props?: EgressProps }).props;

    // Defense-in-depth: the DO only wires this catch-all when strict is ON and passes
    // strict:true via props (read once at wiring — REQ-016 AC2, no per-request KV). A
    // missing/false prop means a stale or misconfigured wiring: fail closed.
    if (!props?.strict) {
      return jsonError(503, 'EGRESS_NOT_CONFIGURED', 'Strict Gateway egress is not enabled');
    }

    const url = new URL(request.url);
    if (isDisallowedEgressHost(url.hostname)) {
      // Reject SSRF targets BEFORE any upstream send.
      return jsonError(403, 'EGRESS_TARGET_BLOCKED', 'Egress target host is not permitted');
    }

    const accountId = props.accountId;
    const accountScoped = isAccountScopedDestination(url, accountId);

    // WebSocket upgrades (e.g. browser-run CDP at /browser-rendering/devtools/...): bridge a
    // fresh WebSocketPair to the upstream socket. Forward the original request VERBATIM
    // (transparent — the scoped Browser Rendering token rides through per REQ-BROWSER-007);
    // own-account CDP egresses direct via controllerFetch. Returning the upstream response
    // as-is does not hand the socket back to the container, so we accept+forward both ends.
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const t0 = Date.now();
      try {
        const upstream = await controllerFetch(this.env, request, accountId);
        const upstreamWs = (upstream as unknown as { webSocket?: WebSocket }).webSocket;
        if (!upstreamWs) {
          // Not a 101 (e.g. an error response) — surface it unchanged.
          console.log('EgressController egress', { h: url.hostname, sc: accountScoped, tx: accountScoped ? 'direct' : 'EGRESS', ws: true, bridged: false, fMs: Date.now() - t0 });
          return upstream;
        }
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
        console.log('EgressController egress', { h: url.hostname, sc: accountScoped, tx: accountScoped ? 'direct' : 'EGRESS', ws: true, bridged: true, fMs: Date.now() - t0 });
        return new Response(null, { status: 101, webSocket: client });
      } catch (err) {
        console.error('EgressController: WebSocket egress failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return jsonError(502, 'EGRESS_WS_FAILED', 'Failed to establish WebSocket egress');
      }
    }

    // Rebuild the request: strip ONLY hop-by-hop headers + the recomputed
    // host/content-length. NEVER add identity headers for the transparent path.
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

    const ownR2 = isOwnAccountR2(url, accountId);
    let upstream: Response;
    let resigned = false;
    const t0 = Date.now();
    try {
      if (ownR2) {
        // Own R2: strip the container's PLACEHOLDER signature and RE-SIGN with the
        // worker-held key. aws4fetch reuses the request's existing x-amz-content-sha256
        // (so the body streams through unbuffered) and signs every present header (SSE-C
        // x-amz-* preserved). Account-scoped ⇒ egresses direct, never env.EGRESS.
        const signHeaders = new Headers(forward.headers);
        signHeaders.delete('authorization');
        const signed = await createR2Client(this.env).sign(url.toString(), {
          method: forward.method,
          headers: signHeaders,
          body: hasBody ? forward.body : undefined,
        });
        upstream = await fetch(signed);
        resigned = true;
      } else {
        // Transparent: account-scoped CF API → direct (caller auth preserved);
        // everything else → env.EGRESS (fail-closed 503 when the binding is unbound).
        upstream = await controllerFetch(this.env, forward, accountId);
      }
    } catch (err) {
      console.error('EgressController: upstream fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'EGRESS_FETCH_FAILED', 'Failed to reach egress target');
    }
    // Diagnostic (REQ-016): make the per-op routing + worker-side latency observable so the
    // R2-speed lever can be chosen from data (compare fMs to $workers.wallTimeMs).
    console.log('EgressController egress', { h: url.hostname, sc: accountScoped, tx: accountScoped ? 'direct' : 'EGRESS', rs: resigned, fMs: Date.now() - t0 });

    // Stream the response back unread; strip ONLY hop-by-hop headers (preserve
    // set-cookie — transparent proxy).
    const responseHeaders = new Headers(upstream.headers);
    for (const h of RESPONSE_HOP_BY_HOP) responseHeaders.delete(h);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  }
}
