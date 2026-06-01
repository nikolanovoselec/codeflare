/**
 * Vault routes - proxy from the Worker to the in-container SilverBullet
 * server that hosts the persistent vault at /home/user/Vault.
 *
 * Two responsibilities, mirroring src/routes/terminal.ts:
 *
 *   1. **Request intercept** (`validateVaultRoute` + `handleVaultRequest`):
 *      Called from `src/index.ts` BEFORE the Hono router so we can pass
 *      WebSocket upgrade requests through (Hono cannot handle them) and
 *      so that a path like `/api/vault/:sid/index.html` reaches the
 *      static file handler in SilverBullet instead of being rejected as
 *      "no Hono route matched".
 *
 *   2. **Hono status route** (`GET /api/vault/:sessionId/status`):
 *      Served through normal middleware (`authMiddleware`); returns a
 *      thin JSON blob describing whether SilverBullet is reachable.
 *
 * Auth chain is identical to terminal:
 *   authenticateRequest → origin allowlist → tier check → rate limit
 *   → session ownership → container health → container.fetch.
 *
 * Implements REQ-MEMORY-103.
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, Session } from '../types';
import { getSessionKey, putSessionWithMetadata } from '../lib/kv-keys';
import {
  SESSION_ID_PATTERN,
  REQUEST_ID_LENGTH,
  REQUEST_ID_PATTERN,
  WS_RATE_LIMIT_WINDOW_MS,
  WS_RATE_LIMIT_MAX_CONNECTIONS,
  WS_RATE_LIMIT_TTL_SECONDS,
} from '../lib/constants';
import { checkRateLimit } from '../lib/rate-limit-core';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { getContainerId, safeCheckContainerHealth } from '../lib/container-helpers';
import { authenticateRequest } from '../lib/access';
import { isSaasModeActive } from '../lib/onboarding';
import { isActiveUser } from '../lib/access-tier';
import { getEffectiveTier } from '../lib/subscription';
import { createLogger } from '../lib/logger';
import { isAllowedOrigin } from '../lib/cors-cache';
import { AuthError, ForbiddenError, NotFoundError, toError, toErrorMessage } from '../lib/error-types';
import {
  maybeSynthesizeCsrfHeader,
  maybeIssueCsrfCookie,
  isServiceWorkerRegistration,
  isServiceWorkerContextFetch,
  injectVaultEncryptionConfig,
  injectVaultBootstrapHopHtml,
  hasVaultBootstrapCookie,
  filterVaultFsListing,
  inferOriginValidated,
  rewriteVaultHtmlResponse,
} from './vault-html';
import { VAULT_NATIVE_SERVICE_WORKER_JS } from './vault-native-sw';

// Re-export the HTML/JS-rewriting + SW-shim surface (now living in
// vault-html.ts after the CF-002 split) so existing importers - notably
// src/__tests__/routes/vault.test.ts and src/index.ts - keep their
// `from '../routes/vault'` paths working unchanged.
export {
  maybeSynthesizeCsrfHeader,
  maybeIssueCsrfCookie,
  isServiceWorkerRegistration,
  isServiceWorkerContextFetch,
  injectVaultEncryptionConfig,
  injectVaultBootScript,
  injectVaultIdbRecorder,
  injectVaultBootstrapHopHtml,
  hasVaultBootstrapCookie,
  filterVaultFsListing,
  inferOriginValidated,
  rewriteVaultBaseHref,
  rewriteVaultHtmlResponse,
  VAULT_BOOTSTRAP_COOKIE,
  VAULT_SW_ACTIVATION_TIMEOUT_MS,
  VAULT_IDB_RECORDER_MARKER,
} from './vault-html';
export {
  VAULT_NATIVE_SERVICE_WORKER_JS,
  VAULT_NATIVE_SW_VERBATIM,
  VAULT_NATIVE_SW_SHA256,
  graftVaultKeyRecovery,
} from './vault-native-sw';

const logger = createLogger('vault');

export interface VaultRouteResult {
  isVaultRoute: boolean;
  sessionId?: string;
  remainingPath?: string;
  isWebSocket?: boolean;
  errorResponse?: Response;
}

/**
 * Typed view of the container Durable Object stub for the one RPC the
 * vault proxy needs: `ensureVaultKey()` (REQ-VAULT-008 AC1). The
 * `@cloudflare/containers` getContainer() return type does not expose
 * our DO's custom methods, so previously three call sites reached the
 * method through `(container as unknown as { ensureVaultKey... })`
 * double-casts (CF-002). Declaring the contract once here lets
 * `getVaultEncryptionKey` perform a single, named cast and hand the
 * rest of the module a typed accessor.
 */
interface VaultKeyProvider {
  ensureVaultKey(): Promise<string>;
}

function getVaultEncryptionKey(container: unknown): Promise<string> {
  return (container as VaultKeyProvider).ensureVaultKey();
}

/**
 * Parse a `/api/vault/:sessionId/...` URL. Used both for HTTP requests
 * and WebSocket upgrades - SilverBullet uses WS for live-edit sync.
 *
 * Returns isVaultRoute=true for any path under `/api/vault/<id>/`. A
 * bare `/api/vault/<id>` (no trailing slash) is rejected: requests to a
 * directory without a trailing slash must redirect or the SilverBullet
 * client emits broken relative-URL fetches. The Hono status route
 * `/api/vault/:sid/status` does NOT count as a vault proxy path - the
 * caller (src/index.ts) checks for that pattern before calling us.
 */
export function validateVaultRoute(request: Request): VaultRouteResult {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/vault\/([^/]+)(\/.*)$/);

  if (!match) {
    return { isVaultRoute: false };
  }

  const sessionId = match[1];
  const remainingPath = match[2];
  const upgradeHeader = request.headers.get('Upgrade');
  const isWebSocket = upgradeHeader?.toLowerCase() === 'websocket';

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return {
      isVaultRoute: true,
      errorResponse: new Response(
        JSON.stringify({ error: 'Invalid session ID format', code: 'INVALID_SESSION' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    };
  }

  return { isVaultRoute: true, sessionId, remainingPath, isWebSocket };
}

/**
 * Vault auth-chain guards (CF-002 extraction).
 *
 * `handleVaultRequest` previously inlined the whole
 * authenticate -> origin-allowlist -> tier -> session-ownership chain
 * as a sequence of early returns. The chain is now broken into named
 * guards, each returning EITHER its success value OR an `errorResponse`
 * the caller returns verbatim. Behaviour (status codes, error codes,
 * ordering, logging) is identical to the previous inline form; the only
 * change is locality, which is what made the chain integration-testable
 * (see src/__tests__/routes/vault-auth-chain.test.ts).
 *
 * The shared `jsonHeaders` (carrying the per-request X-Request-ID) is
 * threaded in so guard rejections keep the same response shape the
 * inline code produced.
 */

/** Origin allowlist guard. Mirrors the inline CORS check. */
async function checkVaultOrigin(
  request: Request,
  env: Env,
  jsonHeaders: Record<string, string>,
): Promise<{ originValidated: boolean } | { errorResponse: Response }> {
  // CORS origin check on every request - vault is reachable from any
  // tab the user opens, and we want to keep the same allowlist as the
  // rest of the app rather than minting a new policy here.
  const origin = request.headers.get('Origin');
  if (origin) {
    const originAllowed = await isAllowedOrigin(origin, env);
    if (!originAllowed) {
      logger.warn('Vault request rejected: origin not allowed', { origin });
      return {
        errorResponse: new Response(
          JSON.stringify({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' }),
          { status: 403, headers: jsonHeaders },
        ),
      };
    }
    return { originValidated: true };
  }
  if (inferOriginValidated(request)) {
    // REQ-VAULT-009 AC1: state-changing request with no Origin header
    // is same-origin by Fetch-spec semantics; treat as validated so the
    // downstream CSRF synthesiser attaches X-Requested-With and the
    // authenticateRequest CSRF guard does not reject the SB attachment
    // upload (PUT /api/vault/<sid>/Inbox/<file>).
    return { originValidated: true };
  }
  return { originValidated: false };
}

/**
 * Authenticate guard. Runs the CSRF synthesiser then authenticateRequest
 * and maps AuthError/ForbiddenError to 401/403. Returns `requestForAuth`
 * (the body-owning request the container fetch must forward - see the
 * disturbed-stream note at the call site) alongside the resolved user.
 */
async function authenticateVaultRequest(
  request: Request,
  originValidated: boolean,
  env: Env,
  jsonHeaders: Record<string, string>,
): Promise<
  | { user: Awaited<ReturnType<typeof authenticateRequest>>['user']; bucketName: string; requestForAuth: Request }
  | { errorResponse: Response }
> {
  // SilverBullet's client.js writes pages via PUT/DELETE/PATCH without
  // `X-Requested-With`. See `maybeSynthesizeCsrfHeader` for the full
  // security analysis; safety is enforced inside the helper, not by
  // statement ordering here.
  const requestForAuth = maybeSynthesizeCsrfHeader(request, originValidated);
  try {
    const { user, bucketName } = await authenticateRequest(requestForAuth, env);
    return { user, bucketName, requestForAuth };
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        errorResponse: new Response(JSON.stringify({ error: err.message, code: 'AUTH_FAILED' }),
          { status: 401, headers: jsonHeaders }),
      };
    }
    if (err instanceof ForbiddenError) {
      return {
        errorResponse: new Response(JSON.stringify({ error: err.message, code: 'FORBIDDEN' }),
          { status: 403, headers: jsonHeaders }),
      };
    }
    throw err;
  }
}

/**
 * Tier guard. In SaaS mode, reject inactive (pending/blocked) users
 * with the matching 403 code. Returns the rejection Response or null
 * when the user may proceed.
 */
function assertActiveTier(
  user: Awaited<ReturnType<typeof authenticateRequest>>['user'],
  env: Env,
  jsonHeaders: Record<string, string>,
): Response | null {
  const effectiveTier = getEffectiveTier(
    user.subscriptionTier,
    user.accessTier,
    user.billingStatus,
    user.billingPeriodEnd,
  );
  if (isSaasModeActive(env.SAAS_MODE) && !isActiveUser(effectiveTier)) {
    const code = effectiveTier === 'blocked' ? 'BLOCKED' : 'PENDING';
    return new Response(JSON.stringify({ error: 'Access denied', code }),
      { status: 403, headers: jsonHeaders });
  }
  return null;
}

/**
 * Session-ownership guard. A KV miss under the authenticated bucket
 * means the user does not own the session (different bucket, or it
 * never existed) -> 404. A stopped session -> 503. Returns the live
 * session + its KV key on success.
 */
async function assertSessionOwnership(
  env: Env,
  bucketName: string,
  sessionId: string,
  jsonHeaders: Record<string, string>,
): Promise<{ session: Session; sessionKey: string } | { errorResponse: Response }> {
  // Session ownership: KV get on the session key for this bucket.
  // If KV does not have it under this bucket, the user does not own
  // the session (different bucket, or session never existed).
  const sessionKey = getSessionKey(bucketName, sessionId);
  const session = await env.KV.get<Session>(sessionKey, 'json');
  if (!session) {
    return {
      errorResponse: new Response(JSON.stringify({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }),
        { status: 404, headers: jsonHeaders }),
    };
  }
  if (session.status === 'stopped') {
    return {
      errorResponse: new Response(JSON.stringify({ error: 'Container stopped', code: 'CONTAINER_STOPPED' }),
        { status: 503, headers: jsonHeaders }),
    };
  }
  return { session, sessionKey };
}

/**
 * Forward a vault HTTP or WebSocket request to the in-container
 * SilverBullet server.
 *
 * Auth + rate limit chain is the same as `handleWebSocketUpgrade` in
 * terminal.ts. WebSocket upgrades share the same per-user rate-limit
 * key (`ws-connect:<email>`) - a vault edit session is the same kind
 * of long-lived browser WS as a terminal session and we do not want a
 * tab-spam attack to find a separate budget here.
 */
export async function handleVaultRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  routeResult: VaultRouteResult,
): Promise<Response> {
  const clientRequestId = request.headers.get('X-Request-ID');
  const requestId = (clientRequestId && REQUEST_ID_PATTERN.test(clientRequestId))
    ? clientRequestId
    : crypto.randomUUID().slice(0, REQUEST_ID_LENGTH);

  const { sessionId, remainingPath, isWebSocket } = routeResult;
  const jsonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-ID': requestId,
  };

  if (!sessionId || !remainingPath) {
    return new Response(
      JSON.stringify({ error: 'Invalid routing result', code: 'INVALID_ROUTING' }),
      { status: 500, headers: jsonHeaders },
    );
  }

  // Service Worker registration fetches arrive without the session cookie
  // (Chrome 76+ omits credentials on the SW script fetch even for same-
  // origin same-site requests), so the normal auth chain would return 401
  // and registration would fail forever. Serve SilverBullet's native SW
  // directly from the Worker to satisfy the browser's registration handshake
  // without round-tripping to the container; the SW bytes are identical for
  // every session (version-locked to the SB binary) and the per-session
  // encryption key arrives later via postMessage from the auth-gated
  // bootstrap-hop page, which the native worker handles natively. Serving the
  // native worker (not the former key-shim) is what restores the persistent
  // sb_files_* sync store and incremental indexing (AD69, issue #445). See
  // VAULT_NATIVE_SERVICE_WORKER_JS for context.
  if (isServiceWorkerRegistration(request, remainingPath)) {
    return new Response(VAULT_NATIVE_SERVICE_WORKER_JS, {
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-cache',
        'X-Request-ID': requestId,
      },
    });
  }

  // Browser WS upgrade requires Origin; CLI clients without Sec-Fetch-Mode
  // are exempted (matches terminal.ts behaviour).
  if (isWebSocket) {
    const isBrowserClient = !!request.headers.get('Sec-WebSocket-Key')
      && !!request.headers.get('Sec-Fetch-Mode');
    if (isBrowserClient && !request.headers.get('Origin')) {
      return new Response('Origin header required for browser WebSocket connections', {
        status: 403,
        headers: jsonHeaders,
      });
    }
  }

  // Hoisted out of the inner try so the container.fetch below can forward
  // the same body-owning Request that authenticateRequest received. The
  // original `request` body is a one-shot ReadableStream; once the CSRF
  // synthesiser builds a clone via `new Request(request, { headers })`,
  // the original is disturbed and any later `new Request(url, request)`
  // throws "This ReadableStream is disturbed". Forwarding `requestForAuth`
  // instead means a PUT body is read exactly once: by the container fetch.
  // For GETs and unvalidated-origin requests, the helper returns `request`
  // unchanged, so this is a no-op there.
  let requestForAuth = request;

  // Origin allowlist runs outside the try (matching the pre-refactor
  // placement): an isAllowedOrigin throw should surface, not be folded
  // into the generic 500 the inner catch produces for proxy failures.
  const originResult = await checkVaultOrigin(request, env, jsonHeaders);
  if ('errorResponse' in originResult) return originResult.errorResponse;

  try {
    const authResult = await authenticateVaultRequest(
      request, originResult.originValidated, env, jsonHeaders,
    );
    if ('errorResponse' in authResult) return authResult.errorResponse;
    const { user, bucketName } = authResult;
    requestForAuth = authResult.requestForAuth;

    const tierRejection = assertActiveTier(user, env, jsonHeaders);
    if (tierRejection) return tierRejection;

    const containerId = getContainerId(bucketName, sessionId);

    const ownershipResult = await assertSessionOwnership(env, bucketName, sessionId, jsonHeaders);
    if ('errorResponse' in ownershipResult) return ownershipResult.errorResponse;
    const { sessionKey } = ownershipResult;

    const container = getContainer(env.CONTAINER, containerId);
    const warmProbe = await safeCheckContainerHealth(container, containerId);
    if (!warmProbe.healthy) {
      return new Response(JSON.stringify({ error: 'Container not ready', code: 'CONTAINER_NOT_READY' }),
        { status: 503, headers: jsonHeaders });
    }

    if (env.STRESS_TEST_MODE !== 'active') {
      // Vault edits use long-lived WS for sync. Share the WS rate-limit
      // bucket with terminal so the per-user budget is single-keyed
      // (`ws-connect:<email>`) instead of fragmenting across tab types.
      // Apply the rate-limit only to WS upgrades; static HTTP fetches
      // for the SilverBullet shell would otherwise burn the budget on
      // page load (~30 asset requests).
      if (isWebSocket) {
        const wsRateResult = await checkRateLimit({
          kv: env.KV,
          key: `ws-connect:${user.email}`,
          limit: WS_RATE_LIMIT_MAX_CONNECTIONS,
          windowMs: WS_RATE_LIMIT_WINDOW_MS,
          ttlSeconds: WS_RATE_LIMIT_TTL_SECONDS,
        });
        if (!wsRateResult.allowed) {
          logger.warn('Vault WS rate limit exceeded', { email: user.email, count: wsRateResult.count });
          return new Response(null, {
            status: 429,
            headers: { ...jsonHeaders, 'Retry-After': String(wsRateResult.retryAfterSec) },
            webSocket: undefined,
          });
        }
      }
    }

    // Bump session lastAccessedAt out of band - vault edits should keep
    // the session alive the same way terminal activity does.
    ctx.waitUntil((async () => {
      const fresh = await env.KV.get<Session>(sessionKey, 'json');
      if (fresh) {
        const touched = { ...fresh, lastAccessedAt: new Date().toISOString() };
        await putSessionWithMetadata(env.KV, sessionKey, touched);
      }
    })().catch((err) => logger.warn('Failed to update lastAccessedAt', { error: toErrorMessage(err) })));

    // REQ-VAULT-008 AC5: the codeflare bootstrap-hop short-circuit. This
    // route is auth-gated by the chain above but never reaches the
    // container - we render the hop HTML with the encryption key embedded
    // and return it directly. The hop registers the key-shim service
    // worker, posts the key, sets the bootstrap cookie, and redirects to
    // /api/vault/<sid>/ so SB can boot with encryption already wired.
    if (remainingPath === '/.codeflare-bootstrap' && !isWebSocket) {
      try {
        const vaultEncryptionKey = await getVaultEncryptionKey(container);
        const html = injectVaultBootstrapHopHtml(sessionId, vaultEncryptionKey);
        const hopHeaders = new Headers({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Request-ID': requestId,
        });
        // CF-019: this GET navigation is the SPA entry point - seed the
        // double-submit CSRF cookie here so the token exists before any write.
        maybeIssueCsrfCookie(request, hopHeaders, sessionId);
        return new Response(html, { status: 200, headers: hopHeaders });
      } catch (err) {
        logger.error('vault bootstrap-hop render failed', toError(err));
        return new Response(
          JSON.stringify({ error: 'Vault bootstrap failed', code: 'VAULT_BOOTSTRAP_FAILED' }),
          { status: 500, headers: jsonHeaders },
        );
      }
    }

    if (remainingPath === '/.vault-key' && !isWebSocket && request.method === 'GET') {
      try {
        const vaultEncryptionKey = await getVaultEncryptionKey(container);
        return new Response(JSON.stringify({ key: vaultEncryptionKey }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Request-ID': requestId,
          },
        });
      } catch (err) {
        logger.error('vault key recovery failed', toError(err));
        return new Response(JSON.stringify({ error: 'Key recovery failed' }),
          { status: 500, headers: jsonHeaders });
      }
    }

    // REQ-VAULT-008 AC6: on the SB shell paths (`/` and `/index.html`),
    // redirect to the bootstrap-hop when the per-session bootstrap cookie
    // is absent. The hop sets the cookie before redirecting back here, so
    // subsequent shell-path requests fall straight through to the proxy.
    // Without this redirect SB boots, finds no SW key, and silently runs
    // unencrypted -- the exact regression REQ-VAULT-008 AC5 forbids.
    //
    // REQ-VAULT-013 AC9: the native SW precaches the shell `/` via
    // cache.addAll during install, BEFORE the hop sets the bootstrap cookie.
    // That precache fetch is SW-context (Sec-Fetch-Mode != navigate), so a
    // 302 here would make cache.addAll reject atomically and hang the SW
    // install. Suppress the redirect for SW-context fetches; top-level
    // navigations and clients with no Sec-Fetch-Mode still get the hop
    // (fail-safe), so a real first navigation never boots without the key.
    const isShellPathPre =
      remainingPath === '/' || remainingPath === '/index.html';
    if (
      isShellPathPre && !isWebSocket && request.method === 'GET'
      && !hasVaultBootstrapCookie(request) && !isServiceWorkerContextFetch(request)
    ) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/api/vault/${sessionId}/.codeflare-bootstrap`,
          'Cache-Control': 'no-store',
          'X-Request-ID': requestId,
        },
      });
    }

    // Rewrite the URL: strip the `/api/vault/<sid>` prefix so the
    // container's HTTP server sees `/vault/<remaining>`. The in-container
    // handler at host/src/server.ts strips the `/vault` prefix once more
    // before proxying to 127.0.0.1:3030, leaving SilverBullet to handle
    // a clean `/<remaining>` path.
    const vaultUrl = new URL(request.url);
    vaultUrl.pathname = '/vault' + remainingPath;

    logger.info('Forwarding vault request to container', {
      email: user.email,
      containerId,
      pathname: vaultUrl.pathname,
      method: request.method,
      isWebSocket: !!isWebSocket,
    });

    // Forward the auth-validated request (NOT the original `request`): see
    // the `let requestForAuth = request` comment above. Using `request`
    // here triggers "ReadableStream is disturbed" on PUT/POST/PATCH because
    // the CSRF synthesiser has already consumed the body to build its
    // header-rewritten clone. WebSocket upgrades flow through this same
    // line: `maybeSynthesizeCsrfHeader` is a no-op for GET (and WS upgrades
    // are always GET), so `requestForAuth === request` for the WS case and
    // the Upgrade / Sec-WebSocket-* headers are preserved verbatim.
    const response = await container.fetch(new Request(vaultUrl.toString(), requestForAuth));

    // SilverBullet 2.8.0 emits `<base href="/" />` in its index HTML so
    // every relative asset reference (e.g. `.client/client.js`) resolves
    // against the worker root, where the Worker has no route handler and
    // returns 404 - producing the "white screen" symptom under the
    // /api/vault/:sid/ subpath proxy. SilverBullet supports `SB_URL_PREFIX`
    // to render `<base href="<prefix>/" />`, but the prefix is per-session
    // (the worker knows :sid, the container does not), so the container
    // can't bake it in at supervisor start. Rewriting the response here
    // is the per-session adapter: replace the bare `<base href="/" />`
    // with the session-prefixed equivalent so the browser resolves
    // assets back through `/api/vault/<sid>/.client/...`.
    //
    // Scope: any text/html response is eligible. SilverBullet 2.8 serves
    // its SPA shell as a catch-all (every non-API path returns the same
    // shell HTML), so a `location.reload()` from the SB client lands on
    // whatever page path the user was viewing (`/Notes/Today`, not `/`),
    // and the rewrite MUST fire there too. Previously the rewrite was
    // gated to `/` and `/index.html` only, which meant a reload at any
    // deeper path returned the shell with the bare `<base href="/" />`,
    // every relative fetch from client.js then resolved to the Worker
    // root, and the tab went blank with all subsequent writes 404'ing.
    // The text/html guard alone is sufficient: SilverBullet's API
    // endpoints (`.fs/`, `index.json`, `.attachment/`) return
    // text/markdown / application/json / image-mime / etc., never
    // text/html, so we never rewrite an API payload.
    //
    // Header hygiene on rewrite: drop both Content-Length (body length
    // changed) and Content-Encoding (response.text() auto-decompresses
    // gzip/br upstream, so the rewritten body is plain text - leaving
    // the original encoding header would trigger ERR_CONTENT_DECODING
    // _FAILED in the browser).
    //
    // Observability: log a warning when the rewrite runs on a body
    // that did NOT contain `<base href="/" />` (i.e. the replace was a
    // no-op), so a future SilverBullet template change (single-quoted
    // href, added attribute, etc.) surfaces as a logged signal instead
    // of a silent white-screen regression.
    const contentType = response.headers.get('content-type') ?? '';

    // REQ-VAULT-008 AC3: inject the per-session vault encryption key into
    // SilverBullet's BootConfig response. The DO is the canonical key
    // source - SB sees the key through this same authenticated channel
    // and uses it as the IDB encryption key without ever showing the
    // user a passphrase prompt. We treat any 2xx /.config response as
    // injection-eligible regardless of upstream content-type because
    // SB's Go server has shipped both application/json and text/plain
    // for this endpoint across versions; the JSON.parse inside
    // injectVaultEncryptionConfig fails loud if the body is not JSON.
    if (remainingPath === '/.config' && response.ok) {
      try {
        const vaultEncryptionKey = await getVaultEncryptionKey(container);
        const body = await response.text();
        const rewritten = injectVaultEncryptionConfig(body, vaultEncryptionKey);
        const headers = new Headers(response.headers);
        // Drop body-shape headers (we rewrote the body so length/encoding
        // no longer apply) AND cache-validators (etag, last-modified)
        // because they describe the upstream un-rewritten body. A
        // browser SW with a stored copy would otherwise serve the WRONG
        // body on a 304 hit (the un-injected variant, missing the
        // encryption key).
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.delete('etag');
        headers.delete('last-modified');
        headers.set('content-type', 'application/json');
        return new Response(rewritten, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (err) {
        logger.error('vault /.config injection failed', toError(err));
        return new Response(JSON.stringify({
          error: 'Vault config injection failed',
          code: 'VAULT_CONFIG_INJECT_FAILED',
        }), { status: 500, headers: jsonHeaders });
      }
    }

    // REQ-VAULT-015 AC1: strip graphify-out/** entries from SB's space
    // listing. SB 2.x serves the listing as `index.json` (legacy) and
    // `/.fs/` (newer); both endpoints return a JSON array of file
    // metadata. The filter is a no-op for any other JSON shape.
    if (
      response.ok &&
      (remainingPath === '/index.json' || remainingPath === '/.fs' || remainingPath === '/.fs/')
    ) {
      const body = await response.text();
      const filtered = filterVaultFsListing(body);
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new Response(filtered, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    if (contentType.includes('text/html')) {
      return rewriteVaultHtmlResponse(response, sessionId, remainingPath, vaultUrl.pathname, contentType, logger, request);
    }
    return response;
  } catch (err) {
    logger.error('Vault request error', toError(err));
    return new Response(JSON.stringify({
      error: 'Vault request failed',
      code: 'VAULT_REQUEST_FAILED',
    }), { status: 500, headers: jsonHeaders });
  }
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables & { requestId: string } }>();

app.use('*', authMiddleware);

/**
 * GET /api/vault/:sessionId/status
 *
 * Thin status check. Returns whether the container is up and whether
 * SilverBullet is reachable on its in-container port. The Header.tsx
 * "Open vault" button can call this to disable itself when SilverBullet
 * is still warming up rather than opening a tab to a 503.
 */
app.get('/:sessionId/status', async (c) => {
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('sessionId');

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format', code: 'INVALID_SESSION' }, 400);
  }

  const sessionKey = getSessionKey(bucketName, sessionId);
  const session = await c.env.KV.get<Session>(sessionKey, 'json');
  if (!session) {
    throw new NotFoundError('Session');
  }

  try {
    const containerId = getContainerId(bucketName, sessionId);
    const container = getContainer(c.env.CONTAINER, containerId);
    const healthResult = await safeCheckContainerHealth(container, containerId);

    if (!healthResult.healthy) {
      return c.json({
        session,
        containerRunning: false,
        vaultReady: false,
      });
    }

    let vaultReady = false;
    try {
      const probe = await container.fetch(
        new Request('http://container/vault/', { method: 'GET' }),
      );
      vaultReady = probe.ok;
    } catch {
      // Container is healthy but SilverBullet supervisor may still be
      // starting up - report not-ready rather than 500.
    }

    return c.json({
      session,
      containerRunning: true,
      vaultReady,
      url: `/api/vault/${sessionId}/`,
    });
  } catch (_err) {
    return c.json({
      session,
      containerRunning: false,
      vaultReady: false,
      url: `/api/vault/${sessionId}/`,
    });
  }
});

export default app;
