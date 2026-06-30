/**
 * Strict Gateway egress transport primitives (REQ-ENTERPRISE-016).
 *
 * Shared helpers for the enterprise-only "strict Gateway egress" feature: a global
 * admin toggle that, when ON, forces the container's DIRECT-INTERNET HTTP/HTTPS egress
 * through the Workers VPC `env.EGRESS` Fetcher binding (and from there the customer's
 * Zero Trust Gateway) instead of straight to the public internet. The toggle is read
 * straight from KV (the `ENTERPRISE_MODE` precedent — a global flag, not per-session
 * state), default OFF when the key is absent so prod/integration behaviour is
 * byte-identical until enabled.
 *
 * This deployment's OWN-account platform destinations (its R2 endpoint + its
 * account-scoped CF API path) are EXEMPT and egress direct — they are codeflare's own
 * control-plane backends, not the agent's external reach (see {@link isAccountScopedDestination}
 * and AD86). Everything else — genuine direct-internet egress AND any OTHER account's R2/CF
 * host — takes the Gateway path for inspection. NOTE: browser-run's Browser Rendering traffic
 * (api.cloudflare.com /browser-rendering/*) is normally claimed by the per-host
 * CloudflareBrowserInterceptor (REQ-BROWSER-008, takes precedence over this catch-all); the
 * CF-API exemption here is a dormant fallback and can only ever carry the container's non-secret
 * placeholder token (the real token never enters the container).
 *
 * The defining security property is FAIL-CLOSED: when strict is ON but `env.EGRESS`
 * is unbound (the [[vpc_networks]] binding is committed commented-out until Cloudflare
 * Mesh is provisioned), every forward returns 503 EGRESS_UNAVAILABLE and NEVER falls
 * back to global `fetch`. The dormant state (OFF + unbound) is therefore inert.
 */
import type { Env } from '../types';
import { isEnterpriseMode } from './subscription';
import { SETUP_KEYS } from './kv-keys';

export function jsonError(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Hop-by-hop request headers stripped before forwarding upstream. The eight
 * connection-scoped headers (RFC 7230 §6.1) are meaningful only for a single
 * transport hop and must not cross the proxy boundary. NOTE: `authorization` /
 * `cookie` are deliberately ABSENT — the EgressController is a transparent proxy
 * that preserves caller credentials (unlike the identity-stamping LLM/GitHub
 * interceptors, which strip the container placeholder and re-stamp).
 */
export const STRIPPED_REQUEST_HOP_BY_HOP: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Hop-by-hop response headers stripped before the upstream response re-enters the
 * container. Same eight connection-scoped headers; `set-cookie` is deliberately
 * ABSENT so the caller's cookies survive the transparent proxy.
 */
export const RESPONSE_HOP_BY_HOP: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * True only when the deployment is in Enterprise mode AND the setup-wizard toggle
 * is persisted `'active'` in KV. Gate-then-read mirrors {@link loadEnterpriseRouteConfig}
 * in src/lib/access.ts: a non-enterprise deploy never touches KV. Default OFF when
 * the key is absent.
 */
export async function hasStrictGatewayEgress(env: Env): Promise<boolean> {
  if (!isEnterpriseMode(env)) return false;
  try {
    return (await env.KV?.get(SETUP_KEYS.STRICT_EGRESS)) === 'active';
  } catch {
    // This runs at the container-start seam (setupEnterpriseInterception); a
    // transient KV error must not fail the start. Treat it like an absent key —
    // default OFF — rather than throwing.
    return false;
  }
}

/**
 * Account-scoped platform destinations — codeflare's OWN control-plane endpoints
 * **for this deployment's Cloudflare account**, NOT the agent's external internet
 * reach. Strict Gateway egress (REQ-ENTERPRISE-016, AD86) forces ALL other container
 * egress through `cf1:network` → the customer's Zero Trust Gateway for inspection;
 * these account-scoped destinations egress DIRECT. Two reasons:
 *   1. Scaling — rclone's per-file R2 sync is the dominant container-egress volume;
 *      forcing it through cf1:network couples every container's bootstrap-critical
 *      persistence to the shared, rate-limited Gateway egress path (account-wide
 *      connection/rate limits at fleet scale).
 *   2. Boundary — an egress firewall polices the workload's reach to the OUTSIDE
 *      world, not the platform's own storage/AI/browser backends, which carry
 *      codeflare-managed credentials and have their own audit (R2 logs, AI Gateway).
 *
 * The exemption is **account-scoped** — ONLY the deployment's own account is direct:
 *   - R2:  `<accountId>.r2.cloudflarestorage.com` (+ the `<bucket>.<accountId>.…` vhost form)
 *   - CF API: `api.cloudflare.com` path `/client/v4/accounts/<accountId>/…` (dormant fallback —
 *     Browser Rendering normally goes via the per-host CloudflareBrowserInterceptor; this branch
 *     only ever forwards the container's non-secret placeholder token).
 * ANY OTHER account's R2/CF host falls through to the Gateway (inspected) — this closes
 * the cross-account exfil channel. `gateway.ai.cloudflare.com` is intentionally NOT
 * exempt: the container never reaches it directly (the worker-side LlmInterceptor does).
 * Fail-secure: an absent/empty `accountId` exempts nothing (all egress is Gateway-inspected).
 */
function r2HostFor(accountId: string): string {
  return `${accountId}.r2.cloudflarestorage.com`;
}

/**
 * True when `url` targets THIS account's R2 S3 endpoint (path-style `<accountId>.r2.…`
 * or a vhost-bucket subdomain of it). Split out from {@link isAccountScopedDestination}
 * because R2 is the only account-scoped destination the EgressController RE-SIGNS with the
 * worker-held key (the CF API path stays a transparent passthrough).
 */
export function isOwnAccountR2(url: URL, accountId: string | undefined): boolean {
  const acct = (accountId ?? '').trim().toLowerCase();
  if (!acct) return false; // fail-secure: no account ⇒ not own R2
  // Normalize host: lowercase, drop IPv6 brackets + a single trailing dot (FQDN form).
  const host = url.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const r2 = r2HostFor(acct);
  return host === r2 || host.endsWith(`.${r2}`);
}

/** True when `url` targets THIS account's R2 or account-scoped CF API (direct egress, never cf1:network). */
export function isAccountScopedDestination(url: URL, accountId: string | undefined): boolean {
  const acct = (accountId ?? '').trim().toLowerCase();
  if (!acct) return false; // fail-secure: no account ⇒ nothing exempt ⇒ all egress Gateway-inspected
  // R2: own account's S3 endpoint (path-style) or a vhost-bucket subdomain of it.
  if (isOwnAccountR2(url, accountId)) return true;
  // CF API (Browser Rendering / browser-run): own account's path namespace only.
  const host = url.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'api.cloudflare.com' && url.pathname.startsWith(`/client/v4/accounts/${acct}/`)) return true;
  return false;
}

/**
 * Forward `request` to its upstream.
 *
 * Account-scoped platform destinations ({@link isAccountScopedDestination}: this account's
 * R2 + CF API / Browser Rendering) egress DIRECT via global `fetch` and NEVER traverse
 * cf1:network — checked first so they reach upstream even when the VPC binding is unbound.
 *
 * Every OTHER host (genuine direct-internet egress, INCLUDING any other account's R2/CF
 * API) is forced through the mandatory Workers VPC `env.EGRESS` Fetcher binding for Gateway
 * inspection. When that binding is unbound, fail closed with 503 EGRESS_UNAVAILABLE — there
 * is NO fallback to global `fetch`, which is the entire security point of the feature.
 *
 * The same selector serves WebSocket upgrades: the caller (EgressController) passes the
 * VERBATIM upgrade request here for WS and returns the upstream `101`+`webSocket` as-is.
 */
export async function controllerFetch(env: Env, request: Request, accountId: string | undefined): Promise<Response> {
  if (isAccountScopedDestination(new URL(request.url), accountId)) return fetch(request);
  if (!env.EGRESS) return jsonError(503, 'EGRESS_UNAVAILABLE', 'Strict Gateway egress binding unavailable');
  return env.EGRESS.fetch(request);
}

/**
 * SSRF defense-in-depth: reject hostnames that resolve (as literals) to loopback,
 * private (RFC 1918), CGNAT shared space (RFC 6598 — the 100.64.0.0/10 range WARP
 * uses), link-local (incl. the 169.254.169.254 cloud metadata endpoint), or
 * unspecified ranges — IPv4 and IPv6 literals (including IPv4-mapped IPv6) plus
 * `localhost`.
 *
 * This is a literal-IP guard only; it does NOT stop a public hostname that resolves
 * to a private IP (DNS rebinding). The authoritative egress control is the customer's
 * Zero Trust Gateway policy on `cf1:network` (see security.md, "SSRF guard +
 * DNS-rebinding caveat").
 */
export function isDisallowedEgressHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // IPv6 literal.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true; // loopback / unspecified
    if (/^f[cd][0-9a-f]*:/.test(host)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]*:/.test(host)) return true; // fe80::/10 link-local
    // IPv4-mapped IPv6 (::ffff:a.b.c.d, or its WHATWG-normalized hex form
    // ::ffff:7f00:1): decode the embedded v4 and re-evaluate so loopback / RFC1918
    // / CGNAT / link-local / metadata cannot slip through the mapped range, which
    // has no legitimate public-egress use.
    const mapped = host.match(/^(?:0:0:0:0:0:|::)ffff:([0-9a-f.:]+)$/);
    if (mapped) {
      const tail = mapped[1];
      if (tail.includes('.')) return isDisallowedEgressHost(tail);
      const parts = tail.split(':');
      if (parts.length === 2) {
        const n = ((parseInt(parts[0], 16) << 16) | parseInt(parts[1], 16)) >>> 0;
        const dotted = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
        return isDisallowedEgressHost(dotted);
      }
      return true; // unrecognized mapped shape -> fail closed
    }
    return false;
  }

  // IPv4 literal.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return true; // malformed octet -> reject
    const [a, b] = o;
    if (a === 0) return true; // 0.0.0.0/8 (incl. 0.0.0.0)
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 RFC 1918
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC 1918
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC 6598; WARP shared range)
    return false;
  }

  return false; // public hostname
}
