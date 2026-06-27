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
 * Platform-native Cloudflare primitives (R2, AI Gateway, Browser Rendering) are
 * EXEMPT: they are codeflare's own control-plane endpoints, not the agent's external
 * reach, so they egress direct and never traverse cf1:network (see
 * {@link isPlatformNativeHost} and AD86). Only genuine direct-internet egress takes
 * the Gateway path.
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
 * Cloudflare platform-native primitive hosts — codeflare's OWN control-plane
 * endpoints, NOT the agent's external internet reach. Strict Gateway egress
 * (REQ-ENTERPRISE-016) routes ONLY genuine direct-internet egress through
 * `cf1:network` → the customer's Zero Trust Gateway; these platform hosts egress
 * DIRECT. Two reasons (AD86):
 *   1. Scaling — rclone's per-file R2 sync is the dominant container-egress volume;
 *      forcing it through cf1:network couples every container's bootstrap-critical
 *      persistence to the shared, rate-limited Gateway egress path, which hits
 *      account-wide connection/rate limits at fleet scale (100 users × N containers).
 *   2. Boundary — an egress firewall polices the workload's reach to the OUTSIDE
 *      world, not the platform's own storage/AI/browser backends, which carry
 *      codeflare-managed credentials to Cloudflare-owned hosts and have their own
 *      audit trail (R2 access logs, AI Gateway analytics).
 *
 * - `*.r2.cloudflarestorage.com` — R2 object storage (rclone vault/workspace sync)
 * - `api.cloudflare.com`         — CF API: Browser Rendering (browser-run) + AI Gateway REST
 * - `gateway.ai.cloudflare.com`  — AI Gateway (compat transport)
 *
 * RESIDUAL SURFACE (accepted trade-off, AD86 / security.md): the match is host-based,
 * NOT account-scoped — `api.cloudflare.com` is the whole CF API for ANY account and the
 * R2 suffix matches any account's bucket host. So a compromised agent can reach these
 * Cloudflare-owned hosts direct, off the customer's Gateway. This is bounded by
 * codeflare-managed credentials + each host's own audit (R2 logs, AI Gateway analytics),
 * and `api.cloudflare.com` cannot be host-scoped (the account is in the URL path) yet
 * must stay exempt for browser-run — so it is documented, not closed.
 */
const PLATFORM_NATIVE_HOSTS: ReadonlySet<string> = new Set([
  'r2.cloudflarestorage.com',
  'api.cloudflare.com',
  'gateway.ai.cloudflare.com',
]);
const PLATFORM_NATIVE_HOST_SUFFIXES: readonly string[] = ['.r2.cloudflarestorage.com'];

/** True when `hostname` is a Cloudflare platform-native primitive that egresses direct (never cf1:network). */
export function isPlatformNativeHost(hostname: string): boolean {
  // Normalize: strip whitespace, lowercase, drop IPv6 brackets, and drop a single
  // trailing dot (FQDN form, e.g. `api.cloudflare.com.`) so the canonical host matches.
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (PLATFORM_NATIVE_HOSTS.has(host)) return true;
  return PLATFORM_NATIVE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Forward `request` to its upstream.
 *
 * Platform-native Cloudflare primitives ({@link isPlatformNativeHost}: R2, AI Gateway,
 * Browser Rendering) egress DIRECT via global `fetch` and NEVER traverse cf1:network —
 * checked first so they reach upstream even when the VPC binding is unbound (they never
 * depend on it).
 *
 * Every OTHER (direct-internet) host is forced through the mandatory Workers VPC
 * `env.EGRESS` Fetcher binding. When that binding is unbound, fail closed with 503
 * EGRESS_UNAVAILABLE — there is NO fallback to global `fetch`, which is the entire
 * security point of the feature.
 */
export async function controllerFetch(env: Env, request: Request): Promise<Response> {
  if (isPlatformNativeHost(new URL(request.url).hostname)) return fetch(request);
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
