/**
 * Vault routes — proxy from the Worker to the in-container SilverBullet
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

const logger = createLogger('vault');

export interface VaultRouteResult {
  isVaultRoute: boolean;
  sessionId?: string;
  remainingPath?: string;
  isWebSocket?: boolean;
  errorResponse?: Response;
}

/**
 * Parse a `/api/vault/:sessionId/...` URL. Used both for HTTP requests
 * and WebSocket upgrades — SilverBullet uses WS for live-edit sync.
 *
 * Returns isVaultRoute=true for any path under `/api/vault/<id>/`. A
 * bare `/api/vault/<id>` (no trailing slash) is rejected: requests to a
 * directory without a trailing slash must redirect or the SilverBullet
 * client emits broken relative-URL fetches. The Hono status route
 * `/api/vault/:sid/status` does NOT count as a vault proxy path — the
 * caller (src/index.ts) checks for that pattern before calling us.
 */
/**
 * Synthesise `X-Requested-With: XMLHttpRequest` on a request clone when
 * (and ONLY when) the caller has already validated the request's Origin
 * against the codeflare CORS allowlist. The synthesis lets SilverBullet's
 * client.js writes (which never set the header) bypass the CSRF guard in
 * `authenticateRequest` without weakening protection: per the Fetch spec,
 * browsers always set Origin on cross-origin state-changing requests, so
 * once Origin is allowlist-validated, the X-Requested-With check is
 * redundant defence.
 *
 * Safety invariant (enforced by THIS function, not by call-site ordering):
 *   - If `originValidated` is false → return the original request unchanged.
 *   - If the request already carries `X-Requested-With` → unchanged.
 *   - If the method is not state-changing (GET/HEAD/OPTIONS) → unchanged.
 *   - Otherwise clone the FULL request (preserves body, signal, etc.) and
 *     set the synthesised header.
 *
 * The full-clone form `new Request(request, { headers })` is critical:
 * `authenticateRequest` only reads method + headers today, but the next
 * change there could legitimately need the body (e.g. to verify a CSRF
 * token in the payload); a partial reconstruction would silently fail.
 *
 * Browser baseline this depends on: Origin set on every cross-origin
 * state-changing request. True in all major browsers since 2020
 * (Chrome 76+, Firefox 70+, Safari 13.1+). Older browsers fall through
 * the `originValidated=false` branch and hit the original CSRF guard.
 *
 * Exported solely so the unit test in src/__tests__/routes/vault.test.ts
 * can pin the behavioural cases (validated+write synthesises; validated
 * +read passes through; not-validated passes through; header-already-
 * present passes through; cloned body preserved; case-insensitive method).
 */
export function maybeSynthesizeCsrfHeader(request: Request, originValidated: boolean): Request {
  if (!originValidated) return request;
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return request;
  if (request.headers.has('X-Requested-With')) return request;
  const headers = new Headers(request.headers);
  headers.set('X-Requested-With', 'XMLHttpRequest');
  return new Request(request, { headers });
}

/**
 * Minimal no-op Service Worker served by the Worker for `service_worker.js`
 * registration requests. SilverBullet's real SW (offline-cache bundle) cannot
 * be served via the vault proxy because Chrome omits cookies on the SW script
 * fetch - the browser's `navigator.serviceWorker.register()` call sends only
 * `Accept`, `DNT`, and `Service-Worker: script` (no `Cookie`), so any cookie-
 * gated route returns 401 and registration fails permanently. The vault UI
 * does not depend on SilverBullet's offline cache; all editor operations run
 * from page context with cookies intact, so a no-op SW is enough to satisfy
 * the browser's registration handshake without breaking anything functional.
 *
 * If a real SW becomes load-bearing in a future SilverBullet version, the
 * mitigation is to inline its source here (the fetch still cannot reach the
 * container without cookies).
 */
export const VAULT_NOOP_SERVICE_WORKER_JS =
  '// Codeflare vault no-op service worker - see src/routes/vault.ts.\n' +
  'self.addEventListener("install", () => self.skipWaiting());\n' +
  'self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));\n';

/**
 * Identify a browser-initiated Service Worker registration GET. The
 * `service-worker: script` request header is set by the user agent and is
 * a Fetch-spec forbidden header name today, so page JavaScript cannot
 * forge it via `fetch()`. The path-suffix check pins the SilverBullet-
 * served SW URL; any other path falls through to the normal auth chain.
 *
 * Defence-in-depth: also require the request to have no `Cookie` header.
 * The bypass exists only because Chrome's SW spec compliance strips
 * cookies on the registration fetch; if a cookie is somehow present
 * (different browser, different bypass-route, future spec change), let
 * the normal auth chain handle it - that path returns the real upstream
 * SW for authenticated users or 401 for unauthenticated ones, which is
 * the original (correct) behaviour rather than this static-noop shortcut.
 * If the forbidden-header status of `Service-Worker` ever changes and a
 * cookieless GET becomes page-JS-spoofable, the attacker still only
 * gets back the static no-op JS string with no user data leakage.
 */
export function isServiceWorkerRegistration(request: Request, remainingPath: string | undefined): boolean {
  if (request.method !== 'GET') return false;
  if (remainingPath !== '/service_worker.js') return false;
  if (request.headers.get('service-worker') !== 'script') return false;
  if (request.headers.get('Cookie')) return false;
  return true;
}

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
 * Forward a vault HTTP or WebSocket request to the in-container
 * SilverBullet server.
 *
 * Auth + rate limit chain is the same as `handleWebSocketUpgrade` in
 * terminal.ts. WebSocket upgrades share the same per-user rate-limit
 * key (`ws-connect:<email>`) — a vault edit session is the same kind
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
  // and registration would fail forever. Serve a no-op SW directly from the
  // Worker to satisfy the browser's registration handshake without round-
  // tripping to the container; the SW JS is identical for every session
  // and contains no user data. See VAULT_NOOP_SERVICE_WORKER_JS for context.
  if (isServiceWorkerRegistration(request, remainingPath)) {
    return new Response(VAULT_NOOP_SERVICE_WORKER_JS, {
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

  // CORS origin check on every request — vault is reachable from any
  // tab the user opens, and we want to keep the same allowlist as the
  // rest of the app rather than minting a new policy here.
  const origin = request.headers.get('Origin');
  let originValidated = false;
  if (origin) {
    const originAllowed = await isAllowedOrigin(origin, env);
    if (!originAllowed) {
      logger.warn('Vault request rejected: origin not allowed', { origin });
      return new Response(
        JSON.stringify({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' }),
        { status: 403, headers: jsonHeaders },
      );
    }
    originValidated = true;
  }

  // Hoisted out of the inner try so line 342's container.fetch can forward
  // the same body-owning Request that authenticateRequest received. The
  // original `request` body is a one-shot ReadableStream; once the CSRF
  // synthesiser builds a clone via `new Request(request, { headers })`,
  // the original is disturbed and any later `new Request(url, request)`
  // throws "This ReadableStream is disturbed". Forwarding `requestForAuth`
  // instead means a PUT body is read exactly once: by the container fetch.
  // For GETs and unvalidated-origin requests, the helper returns `request`
  // unchanged, so this is a no-op there.
  let requestForAuth = request;
  try {
    let user;
    let bucketName;
    try {
      // SilverBullet's client.js writes pages via PUT/DELETE/PATCH without
      // `X-Requested-With`. See `maybeSynthesizeCsrfHeader` for the full
      // security analysis; safety is enforced inside the helper, not by
      // statement ordering here.
      requestForAuth = maybeSynthesizeCsrfHeader(request, originValidated);
      ({ user, bucketName } = await authenticateRequest(requestForAuth, env));
    } catch (err) {
      if (err instanceof AuthError) {
        return new Response(JSON.stringify({ error: err.message, code: 'AUTH_FAILED' }),
          { status: 401, headers: jsonHeaders });
      }
      if (err instanceof ForbiddenError) {
        return new Response(JSON.stringify({ error: err.message, code: 'FORBIDDEN' }),
          { status: 403, headers: jsonHeaders });
      }
      throw err;
    }

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

    const containerId = getContainerId(bucketName, sessionId);

    // Session ownership: KV get on the session key for this bucket.
    // If KV does not have it under this bucket, the user does not own
    // the session (different bucket, or session never existed).
    const sessionKey = getSessionKey(bucketName, sessionId);
    const session = await env.KV.get<Session>(sessionKey, 'json');
    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }),
        { status: 404, headers: jsonHeaders });
    }
    if (session.status === 'stopped') {
      return new Response(JSON.stringify({ error: 'Container stopped', code: 'CONTAINER_STOPPED' }),
        { status: 503, headers: jsonHeaders });
    }

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

    // Bump session lastAccessedAt out of band — vault edits should keep
    // the session alive the same way terminal activity does.
    ctx.waitUntil((async () => {
      const fresh = await env.KV.get<Session>(sessionKey, 'json');
      if (fresh) {
        const touched = { ...fresh, lastAccessedAt: new Date().toISOString() };
        await putSessionWithMetadata(env.KV, sessionKey, touched);
      }
    })().catch((err) => logger.warn('Failed to update lastAccessedAt', { error: toErrorMessage(err) })));

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
    if (contentType.includes('text/html')) {
      const prefix = `/api/vault/${sessionId}`;
      const body = await response.text();
      const rewritten = body.replace(
        /<base\s+href="\/"\s*\/?>/gi,
        `<base href="${prefix}/" />`,
      );
      // Only warn on the shell paths where the rewrite is load-bearing
      // (`/` and `/index.html`). On any other text/html path - error
      // pages, 404 HTML, future plug-served HTML - a no-op rewrite is
      // expected, not a signal. Logging unconditionally fills prod logs
      // with false positives on every non-shell error response.
      const isShellPath =
        remainingPath === '/' || remainingPath === '/index.html';
      if (rewritten === body && response.status === 200 && isShellPath) {
        logger.warn('vault base-href rewrite no-op', {
          pathname: vaultUrl.pathname,
          contentType,
        });
      }
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new Response(rewritten, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
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
      // starting up — report not-ready rather than 500.
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
