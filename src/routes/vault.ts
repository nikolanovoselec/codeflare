/**
 * Vault routes — proxy from the Worker to the in-container SilverBullet
 * server that hosts the persistent vault at /home/user/.obsidian_vault.
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
  if (origin) {
    const originAllowed = await isAllowedOrigin(origin, env);
    if (!originAllowed) {
      logger.warn('Vault request rejected: origin not allowed', { origin });
      return new Response(
        JSON.stringify({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' }),
        { status: 403, headers: jsonHeaders },
      );
    }
  }

  try {
    let user;
    let bucketName;
    try {
      ({ user, bucketName } = await authenticateRequest(request, env));
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

    const response = await container.fetch(new Request(vaultUrl.toString(), request));

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
    // Scope guards (both required to enter the rewrite path):
    //   1. Path is the shell root (`/` or `/index.html`) - SilverBullet
    //      serves the SPA shell from those paths only; HTML error pages
    //      or note renders at other paths pass through unchanged so we
    //      don't pay an eager `.text()` decode cost on every response.
    //   2. Content-Type is text/html - JS bundles, PNG icons, manifest
    //      JSON pass through.
    //
    // Header hygiene on rewrite: drop both Content-Length (body length
    // changed) and Content-Encoding (response.text() auto-decompresses
    // gzip/br upstream, so the rewritten body is plain text - leaving
    // the original encoding header would trigger ERR_CONTENT_DECODING
    // _FAILED in the browser).
    //
    // Observability: log a warning when the rewrite runs but matches
    // nothing, so a future SilverBullet template change (single-quoted
    // href, added attribute, etc.) surfaces as a logged signal instead
    // of a silent white-screen regression in production.
    const contentType = response.headers.get('content-type') ?? '';
    const isShellPath = remainingPath === '/' || remainingPath.endsWith('/index.html');
    if (isShellPath && contentType.includes('text/html')) {
      const prefix = `/api/vault/${sessionId}`;
      const body = await response.text();
      const rewritten = body.replace(
        /<base\s+href="\/"\s*\/?>/gi,
        `<base href="${prefix}/" />`,
      );
      if (rewritten === body) {
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
