/**
 * GitHubInterceptor — enterprise-mode outbound GitHub credential injection (REQ-GITHUB-003).
 *
 * A WorkerEntrypoint the container DO wires into container egress for the GitHub
 * hosts (github.com + api.github.com) via `ctx.container.interceptOutboundHttps`
 * (see src/container/index.ts wireGithubInterception). The container holds only a
 * NON-SECRET placeholder GH_TOKEN, so git / `gh` / Copilot's GitHub features run
 * in authed mode but never possess the real credential. Each intercepted request
 * is routed HERE at the platform level: the interceptor strips the placeholder
 * auth, looks up + decrypts the per-user GitHub token from the existing deploy-keys
 * KV entry, and stamps the real credential at the github.com boundary in the format
 * the target host expects (git Basic vs API Bearer).
 *
 * Security property (no cross-user spoofing): user-scoping comes SOLELY from
 * `props.bucket`, bound when the DO instantiates this entrypoint for the session.
 * The request cannot influence which user's token is injected — the placeholder
 * value and any identity the request claims are ignored — so a session can only
 * ever inject its own user's token.
 *
 * Fail closed: when no valid token exists (not connected, or an App token that
 * cannot be refreshed) the interceptor returns 401 WITHOUT making any upstream
 * request — it never substitutes a guess, so the git/`gh` op fails with a clear
 * error rather than silently acting unauthenticated.
 *
 * Dormant on non-enterprise deploys: the DO only wires interception when
 * ENTERPRISE_MODE=active, so this class is never instantiated otherwise.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { getValidGithubToken } from './lib/github-token';

/** Pinned default GitHub REST API version (set only when the client didn't pin one). */
const GITHUB_API_VERSION = '2022-11-28';

/** The git web host (clone/push over Smart HTTP); env-overridable for GHES. */
function gitWebHost(env: Env): string {
  return env.GITHUB_HOST?.trim() || 'github.com';
}
/** The REST API host (`gh` / API); env-overridable for GHES. */
function gitApiHost(env: Env): string {
  return env.GITHUB_API_HOST?.trim() || 'api.github.com';
}

/** Hosts the DO intercepts for enterprise GitHub credential injection (deduped). */
export function interceptedGithubHosts(env: Env): string[] {
  return [...new Set([gitWebHost(env), gitApiHost(env)])];
}

/**
 * Request headers stripped before forwarding upstream. The container's auth is a
 * non-secret placeholder (`GH_TOKEN`); it must never ride upstream — the real
 * credential is stamped fresh below. host/content-length are recomputed by the
 * runtime for the rebuilt request.
 */
const STRIPPED_REQUEST_HEADERS: readonly string[] = ['authorization', 'x-api-key', 'host', 'content-length'];

/**
 * Response headers stripped before the upstream response re-enters the container.
 * Hop-by-hop headers (RFC 7230 §6.1) are connection-scoped; set-cookie must never
 * cross the boundary into the agent's client.
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
interface GithubInterceptorProps {
  /** The user's email — for the per-user audit line; never used to resolve the token. */
  user: string;
  /** The per-session bucket — the ONLY identity used to resolve the user's token. */
  bucket: string;
}

function jsonError(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class GitHubInterceptor extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const apiHost = gitApiHost(this.env);
    if (!interceptedGithubHosts(this.env).includes(url.hostname)) {
      // An unmapped host reaching here is a wiring misconfiguration; fail closed.
      return jsonError(400, 'BAD_HOST', 'Unsupported GitHub host');
    }

    // Identity is the BOUND per-session bucket only — never read from the request.
    const props = (this.ctx as unknown as { props?: GithubInterceptorProps }).props;
    const bucket = props?.bucket;
    if (!bucket) {
      console.error('GitHubInterceptor: per-session bucket prop absent; failing closed');
      return jsonError(401, 'GITHUB_NO_SESSION', 'GitHub credential unavailable');
    }

    let token: string | null;
    try {
      token = await getValidGithubToken(this.env, bucket);
    } catch (err) {
      console.error('GitHubInterceptor: token lookup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'GITHUB_TOKEN_LOOKUP_FAILED', 'GitHub credential lookup failed');
    }
    if (!token) {
      // Not connected, or an expired App token with no usable refresh. Fail closed
      // (no upstream fetch) so the op errors clearly instead of acting unauthenticated.
      console.warn(`GitHubInterceptor: no valid GitHub token for user=${props?.user ?? 'unknown'}; failing closed`);
      return jsonError(401, 'GITHUB_NOT_CONNECTED', 'GitHub not connected');
    }

    // Strip the container placeholder + hop-by-hop headers, then stamp the real
    // credential in the format the target host expects.
    const headers = new Headers(request.headers);
    for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);

    if (url.hostname === apiHost) {
      // REST API (`gh` / API): bearer token + pinned API version (only when the
      // client did not pin its own, so a client-chosen version is honoured).
      headers.set('authorization', `Bearer ${token}`);
      if (!headers.has('x-github-api-version')) headers.set('x-github-api-version', GITHUB_API_VERSION);
    } else {
      // git Smart HTTP over HTTPS: Basic x-access-token:<token> — matches the
      // container credential helper's `username=x-access-token` convention
      // (entrypoint.sh), so the username half is irrelevant and the token is the password.
      headers.set('authorization', `Basic ${btoa(`x-access-token:${token}`)}`);
    }

    // Per-user audit line (REQ-GITHUB-003): every injected GitHub call is attributed.
    console.info(
      `GitHubInterceptor: injected credential user=${props?.user ?? 'unknown'} ${request.method} ${url.hostname}${url.pathname}`,
    );

    // Stream the request body through unbuffered (git packfile uploads can be large);
    // GET/HEAD carry none. No timeout: a clone/fetch may legitimately run long.
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    let upstream: Response;
    try {
      upstream = await fetch(
        new Request(url.toString(), {
          method: request.method,
          headers,
          body: hasBody ? request.body : undefined,
          // Do not transparently follow redirects to an arbitrary Location host;
          // surface the 3xx to the agent's client instead.
          redirect: 'manual',
        }),
      );
    } catch (err) {
      console.error('GitHubInterceptor: upstream fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(502, 'GITHUB_FETCH_FAILED', 'Failed to reach GitHub');
    }

    // Stream the response back without buffering; strip hop-by-hop + cookie headers.
    const responseHeaders = new Headers(upstream.headers);
    for (const h of RESPONSE_STRIPPED_HEADERS) responseHeaders.delete(h);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  }
}
