/**
 * CloudflareBrowserInterceptor — outbound `api.cloudflare.com` credential injection, two modes:
 *   (1) enterprise Browser Rendering admin-token injection (REQ-BROWSER-008), plus parent-owner
 *       grants for ordinary management APIs; Browser namespace authority stays separate;
 *   (2) non-enterprise OAuth mode (REQ-AGENT-078) — stamps a freshly-refreshed per-user Cloudflare
 *       OAuth token on managed api.cloudflare.com requests (as `Authorization`) AND on the AI Gateway
 *       data-plane `gateway.ai.cloudflare.com` (as `cf-aig-authorization`, the token's aig.run scope),
 *       so `wrangler`, browser-run, and AI Gateway all survive past the short OAuth access-token
 *       lifetime, with the real token never entering the container. The gateway host is OAuth-mode
 *       ONLY (INTERCEPTED_CF_OAUTH_HOSTS) — enterprise never wires it, so the enterprise LlmInterceptor
 *       keeps emitting its own gateway rewrites direct.
 * Only ONE interceptor can bind a host, so a single class serves both (the DO picks the mode via
 * props: `bucket` ⇒ non-enterprise OAuth mode; `ownerBucket` and Browser props ⇒ enterprise).
 *
 * A WorkerEntrypoint the container DO wires into container egress for `api.cloudflare.com`
 * via `ctx.container.interceptOutboundHttps` (see src/container/index.ts
 * the browserRendering registry entry in container-interception.ts). Wired in enterprise ALWAYS (independent of the strict
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
 *     for absent credentials or the exact enterprise placeholder, where `<browserAccountId>`
 *     equals the SETUP-WIZARD-configured Browser Rendering account
 *     (props, bound at wiring): strip the placeholder `authorization`, inject the real
 *     "Browser Rendering - Edit" token (resolved worker-side at wiring), use `env.EGRESS`
 *     when strict is on and direct forwarding otherwise. REST and the CDP WebSocket upgrade
 *     (`/browser-rendering/devtools/...`) are both handled — the WS is bridged via a fresh
 *     `WebSocketPair` so the socket actually returns to the container.
 *   - Other Browser accounts cannot borrow administrator Browser credentials: they retain
 *     strict Gateway forwarding or non-strict refusal. Non-Browser management APIs instead
 *     resolve the parent-bound owner's fresh OAuth/legacy grant, failing 401 without it.
 *     Owner traffic uses mandatory EGRESS when strict, direct otherwise, with no auth replay.
 *
 * Caller-owned Bearer/key+email or Gateway credentials bypass managed lookup, not native or
 * Operator authorization. They use ordinary direct/strict egress with manual redirects and no
 * managed fallback, including when Browser configuration is absent.
 * Fail closed: managed Browser requests with no configured token/account return 401 WITHOUT
 * upstream I/O; strict owner API traffic returns 503 before grant lookup if EGRESS is unbound.
 *
 * Wiring: in enterprise the DO always wires this for api.cloudflare.com, independently of admin
 * Browser configuration (mode 1, the `browserRendering` registry entry); in non-enterprise
 * it wires this for OAuth "Connect to Cloudflare" sessions with only the bound bucket in props
 * (mode 2, the `cloudflareOauthApi` registry entry). Otherwise unreached.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { forwardPersonalPi, type PersonalPiProps } from './lib/personal-pi-forwarding';
import type { Env } from './types';
import { createLogger } from './lib/logger';
import { getValidCloudflareToken } from './lib/cloudflare-token';
import { classifyCloudflareCredentials } from './lib/cloudflare-credentials';
import { CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER, ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER } from './lib/constants';
import { STRIPPED_REQUEST_HOP_BY_HOP, RESPONSE_HOP_BY_HOP } from './lib/controller-egress';
import { prepareJwtStampedRequest, type JwtStampingAuthority, type JwtStampingPolicy } from './operators/jwt-stamping';
import type { OperatorPolicy } from './operators/policy';
import { getContainerId } from './lib/container-helpers';
import { readBoundedStream } from './lib/bounded-stream';
import { browserPath, type BrowserOwnerReference, type BrowserOperation } from './container/container-browser';

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
interface BrowserInterceptorProps extends PersonalPiProps {
  /** The wizard-configured Browser Rendering account id; ONLY this account's path is trusted. */
  browserAccountId?: string;
  /** The real admin "Browser Rendering - Edit" token, resolved worker-side at wiring. */
  browserToken?: string;
  /** Ordinary owning container's parent-bound reference; never taken from HTTP input. */
  browserOwner?: BrowserOwnerReference;
  /** Strict egress requires env.EGRESS for managed Browser and other CF API traffic. */
  strict?: boolean;
  jwtStamping?: JwtStampingPolicy;
  jwtAuthority?: JwtStampingAuthority;
  /** Presence marks a restricted operator session; admin Browser credentials are never a declared capability. */
  operatorPolicy?: OperatorPolicy;
  /**
   * NON-enterprise OAuth mode (REQ-AGENT-078): the bound per-session bucket. When set, this
   * interceptor stamps a FRESH `getValidCloudflareToken(bucket)` only when Cloudflare credentials
   * are absent or the exact OAuth placeholder, so managed credentials are refreshed at the
   * boundary and never enter the container. Mutually exclusive with the enterprise props above
   * (different wiring paths) — enterprise uses the separate `ownerBucket` binding instead.
   */
  bucket?: string;
  /** Enterprise management API owner, bound only from the parent DO; never container input. */
  ownerBucket?: string;
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
    const personal = await forwardPersonalPi(request, this.env, props);
    if (personal) return personal;

    // Resolve caller intent before any managed credential lookup. Native authorization above
    // and the existing Operator restriction remain authoritative for both credential lanes.
    const credentials = classifyCloudflareCredentials(request.headers, url.hostname.replace(/\.$/, '') === AI_GATEWAY_HOST,
      props?.bucket ? CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER : ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER);
    if (credentials === 'invalid') {
      return jsonError(400, 'CF_CREDENTIALS_INVALID', 'Cloudflare credentials are invalid');
    }
    if (props?.operatorPolicy) {
      return jsonError(403, 'OPERATOR_BROWSER_DENIED', 'Browser administrator credentials are not available to operators');
    }
    if (credentials !== 'managed') return this.forwardCaller(request, credentials === 'key-email', props);
    if (props?.bucket) return this.fetchOAuth(request, url, props.bucket);

    const browserAccountId = props?.browserAccountId;
    const browserToken = props?.browserToken;
    const strict = props?.strict === true;
    const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    if ((!browserAccountId?.trim() || !browserToken)
      && /^\/client\/v4\/accounts\/[^/]+\/browser-rendering\//.test(url.pathname)) {
      return jsonError(401, 'BROWSER_NO_TOKEN', 'Browser Rendering token not configured');
    }

    if (!/^\/client\/v4\/accounts\/[^/]+\/browser-rendering(?:\/|$)/.test(url.pathname)) {
      return this.fetchOwnerApi(request, url, props);
    }

    if (!isBrowserRenderingPath(url, browserAccountId)) {
      // Another account's Browser namespace cannot borrow administrator credentials.
      // Preserve the inspected pass-through when strict; otherwise fail closed.
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

    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname.includes('%')) {
      return jsonError(403, 'CF_API_BLOCKED', 'Cloudflare API access is not permitted');
    }
    if (strict && !this.env.EGRESS) return jsonError(503, 'EGRESS_UNAVAILABLE', 'Strict gateway egress unavailable');
    const base = browserPath(browserAccountId!);
    const browserRoot = base.slice(0, -'/devtools/browser'.length);
    if (url.pathname.startsWith(`${browserRoot}/sessions`)
      || (url.pathname.startsWith(`${browserRoot}/devtools`) && url.pathname !== base && !url.pathname.startsWith(`${base}/`))) {
      return jsonError(403, 'BROWSER_REFERENCE_DENIED', 'Only the owned browser is available');
    }
    let revalidateAttachment: (() => Promise<void>) | undefined;
    if (url.pathname === base || url.pathname.startsWith(`${base}/`)) {
      const owner = props?.browserOwner;
      if (!owner || !this.env.CONTAINER) return jsonError(403, 'BROWSER_REFERENCE_DENIED', 'Browser owner authority unavailable');
      const generic = url.pathname === base;
      const explicitCreate = generic && request.method === 'POST' && !isWs;
      if ((generic && !explicitCreate && (!isWs || request.method !== 'GET'))
        || request.headers.has('cf-brapi-guardrails')
        || [...url.searchParams.keys()].some(key => key !== 'keep_alive')
        || (url.searchParams.has('keep_alive') && (!/^\d+$/.test(url.searchParams.get('keep_alive')!)
          || Number(url.searchParams.get('keep_alive')) < 10_000 || Number(url.searchParams.get('keep_alive')) > 1_200_000))) {
        return jsonError(400, 'BROWSER_REQUEST_UNSUPPORTED', 'Unsupported owned-browser acquisition or attachment options');
      }
      if (explicitCreate) {
        try {
          const body: unknown = JSON.parse(new TextDecoder().decode(await readBoundedStream(request.body, 1024, 'Browser create', request.signal)));
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new Error('Invalid create');
        } catch { return jsonError(400, 'BROWSER_REQUEST_UNSUPPORTED', 'Owned-browser creation requires an empty JSON object'); }
      }
      try {
        const container = this.env.CONTAINER.getByName(getContainerId(owner.bucket, owner.sessionId)) as unknown as {
          getOwnedBrowser(ref: BrowserOwnerReference, operation: BrowserOperation): Promise<string>;
        };
        const id = await container.getOwnedBrowser(owner, explicitCreate ? 'replace' : generic ? 'acquire' : 'attach');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid reference');
        if (explicitCreate) return new Response(JSON.stringify({ sessionId: id,
          webSocketDebuggerUrl: `wss://api.cloudflare.com${base}/${id}` }), { headers: { 'content-type': 'application/json' } });
        if (!generic && url.pathname.slice(base.length + 1).split('/')[0] !== id) {
          return jsonError(403, 'BROWSER_REFERENCE_DENIED', 'Only the owned browser is available');
        }
        if (generic) url.pathname = `${base}/${id}`;
        // Recheck the same reference after attachment I/O, before exposing any response/socket.
        revalidateAttachment = async () => {
          if (await container.getOwnedBrowser(owner, 'attach') !== id) throw new Error('Browser reference changed');
        };
        // keep_alive belongs to acquisition, not reconnect; never imply extension on attach.
        url.search = '';
      } catch {
        return jsonError(503, 'BROWSER_UNAVAILABLE', 'Owned browser unavailable; no automatic fresh-browser replay');
      }
    }

    // Strip the container placeholder + recomputed headers, then stamp the real token.
    const headers = new Headers(request.headers);
    for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);
    headers.set('authorization', `Bearer ${browserToken}`);

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    let forward = new Request(url.toString(), {
      method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual',
    });
    if (props?.jwtStamping) {
      try { forward = prepareJwtStampedRequest(forward, props.jwtStamping, props.jwtAuthority); }
      catch { return jsonError(403, 'JWT_STAMPING_AUTHORITY_UNAVAILABLE', 'Current human Access authority is required'); }
    }
    // Browser REST requests/results carry web content eligible for Gateway policy/AV/DLP.
    // CDP shares the required transport and bridge, not remote Chrome networking or frame DLP.
    const egress = this.env.EGRESS;
    if (strict && !egress) return jsonError(503, 'EGRESS_UNAVAILABLE', 'Strict gateway egress unavailable');
    let upstream: Response;
    try {
      upstream = strict ? await egress!.fetch(forward) : await fetch(forward);
    } catch (err) {
      console.error('CloudflareBrowserInterceptor: upstream fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'BROWSER_FETCH_FAILED', 'Failed to reach Browser Rendering');
    }
    if (revalidateAttachment) {
      try { await revalidateAttachment(); }
      catch {
        // A successful provider upgrade must not outlive its owning authority or reference.
        const socket = upstream.webSocket;
        if (socket) {
          try { socket.accept(); } catch { /* already accepted */ }
          try { socket.close(1008, 'Browser authority changed'); } catch { /* already closed */ }
        }
        void upstream.body?.cancel().catch(() => undefined);
        return jsonError(503, 'BROWSER_UNAVAILABLE', 'Owned browser unavailable; no automatic fresh-browser replay');
      }
    }
    return isWs ? this.bridge(upstream) : this.relay(upstream);
  }

  /** Check destination and required transport before any protected owner grant lookup. */
  private forwardingError(url: URL, props?: BrowserInterceptorProps, hosts = INTERCEPTED_CF_OAUTH_HOSTS): Response | null {
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !hosts.includes(url.hostname)) {
      return jsonError(403, 'CF_API_BLOCKED', 'Cloudflare API access is not permitted');
    }
    if (props?.strict && !this.env.EGRESS) {
      return jsonError(503, 'EGRESS_UNAVAILABLE', 'Strict gateway egress unavailable');
    }
    return null;
  }

  /** Enterprise management uses the parent owner's live grant, never the admin Browser token. */
  private async fetchOwnerApi(request: Request, url: URL, props?: BrowserInterceptorProps): Promise<Response> {
    // Keep the API/account/resource namespace literal so encoded Browser paths cannot
    // change lanes, while resource keys (such as KV keys containing '/') remain valid.
    if (url.pathname.split('/').slice(0, 6).some(segment => segment.includes('%'))) {
      return jsonError(403, 'CF_API_BLOCKED', 'Cloudflare API access is not permitted');
    }
    const invalid = this.forwardingError(url, props, INTERCEPTED_CF_BROWSER_HOSTS);
    if (invalid) return invalid;
    if (!props?.ownerBucket) return jsonError(401, 'CF_NOT_CONNECTED', 'Cloudflare not connected');
    return this.forwardCaller(request, false, props, props.ownerBucket);
  }

  /** Caller credentials use ordinary egress, never the managed Browser backend exemption. */
  private async forwardCaller(request: Request, keyEmail: boolean, props?: BrowserInterceptorProps, ownerBucket?: string): Promise<Response> {
    const invalid = this.forwardingError(new URL(request.url), props);
    if (invalid) return invalid;
    const isWs = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    const headers = new Headers(request.headers);
    for (const name of [...STRIPPED_REQUEST_HOP_BY_HOP, 'host', 'content-length']) headers.delete(name);
    if (keyEmail) headers.delete('authorization');
    if (isWs) { headers.set('upgrade', 'websocket'); headers.set('connection', 'Upgrade'); }
    let forward = new Request(request, { headers, redirect: 'manual' });
    if (props?.jwtStamping) {
      try { forward = prepareJwtStampedRequest(forward, props.jwtStamping, props.jwtAuthority); }
      catch { return jsonError(403, 'JWT_STAMPING_AUTHORITY_UNAVAILABLE', 'Current human Access authority is required'); }
    }
    if (ownerBucket) {
      // Authorize the complete transport before credential reads or refresh effects.
      let token: string | null;
      try { token = await getValidCloudflareToken(this.env, ownerBucket); }
      catch {
        logger.warn('owner Cloudflare credential lookup failed');
        return jsonError(502, 'CF_TOKEN_LOOKUP_FAILED', 'Cloudflare credential lookup failed');
      }
      if (!token) return jsonError(401, 'CF_NOT_CONNECTED', 'Cloudflare not connected');
      forward.headers.set('authorization', `Bearer ${token}`);
    }
    try {
      const upstream = props?.strict ? await this.env.EGRESS!.fetch(forward) : await fetch(forward);
      if (isWs) return this.bridge(upstream);
      const responseHeaders = new Headers(upstream.headers);
      for (const name of RESPONSE_HOP_BY_HOP) responseHeaders.delete(name);
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
    } catch {
      logger.warn('caller Cloudflare forwarding failed');
      return jsonError(502, 'CF_API_FETCH_FAILED', 'Failed to reach Cloudflare API');
    }
  }

  /**
   * OAuth mode (REQ-AGENT-078, non-enterprise): resolve a FRESH token for the bound bucket
   * (`getValidCloudflareToken` refreshes via the stored refresh_token), stamp managed
   * api.cloudflare.com requests/upgrades, and forward DIRECT. The container holds only the
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
      // Only managed Gateway requests reach here: replace the exact placeholder with a fresh token.
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
