/**
 * Strict Gateway egress transport primitives (REQ-ENTERPRISE-016).
 *
 * Shared helpers for the enterprise-only "strict Gateway egress" feature: a global
 * admin toggle that, when ON, forces ALL container HTTP/HTTPS egress through the
 * Workers VPC `env.EGRESS` Fetcher binding (and from there the customer's Zero Trust
 * Gateway) instead of the public internet. The toggle is read straight from KV (the
 * `ENTERPRISE_MODE` precedent — a global flag, not per-session state), default OFF
 * when the key is absent so prod/integration behaviour is byte-identical until enabled.
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
 * Forward `request` through the mandatory Workers VPC `env.EGRESS` Fetcher binding.
 * When the binding is unbound, fail closed with 503 EGRESS_UNAVAILABLE — there is
 * NO fallback to global `fetch`, which is the entire security point of the feature.
 */
export async function controllerFetch(env: Env, request: Request): Promise<Response> {
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
