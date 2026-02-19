/**
 * Terminal routes — dual responsibility by design (AD36).
 *
 * AUTH: WebSocket authentication for terminal connections.
 * See also: src/index.ts (WebSocket upgrade intercept), src/middleware/auth.ts (HTTP auth)
 *
 * 1. **WebSocket intercept** (`validateWebSocketRoute` + `handleWebSocketUpgrade`):
 *    Called from `src/index.ts` BEFORE the Hono router because Hono cannot
 *    handle WebSocket upgrade requests (AD13). These functions perform their
 *    own authentication by calling `authenticateRequest()` directly.
 *
 * 2. **Hono status route** (`GET /api/terminal/:sessionId/status`):
 *    Served through the normal Hono middleware chain with `authMiddleware`.
 *
 * Both paths live here because they are terminal-related concerns. Splitting
 * them into separate files would add indirection for no structural benefit.
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, Session } from '../types';
import { getSessionKey } from '../lib/kv-keys';
import { SESSION_ID_PATTERN, REQUEST_ID_LENGTH, REQUEST_ID_PATTERN, WS_RATE_LIMIT_WINDOW_MS, WS_RATE_LIMIT_MAX_CONNECTIONS, WS_RATE_LIMIT_TTL_SECONDS } from '../lib/constants';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { getContainerId, checkContainerHealth } from '../lib/container-helpers';
import { authenticateRequest } from '../lib/access';
import { createLogger } from '../lib/logger';
import { containerSessionsCB } from '../lib/circuit-breakers';
import { isAllowedOrigin } from '../lib/cors-cache';
import { AuthError, ForbiddenError, NotFoundError, toError, toErrorMessage } from '../lib/error-types';

const logger = createLogger('terminal');

/**
 * Result of WebSocket routing validation
 */
interface WebSocketRouteResult {
  /** Whether the request matches a WebSocket terminal route */
  isWebSocketRoute: boolean;
  /** The full session ID including terminal suffix (e.g., "abc123-1") */
  fullSessionId?: string;
  /** The base session ID without terminal suffix */
  baseSessionId?: string;
  /** The terminal ID (1-6) */
  terminalId?: string;
  /** Error response if validation failed */
  errorResponse?: Response;
}

/**
 * Validate and parse a WebSocket terminal route
 * This extracts the routing logic from index.ts to keep it modular
 *
 * @param request - The incoming request
 * @param env - Environment bindings
 * @returns Routing result with validation status
 */
export function validateWebSocketRoute(request: Request, env: Env): WebSocketRouteResult {
  const url = new URL(request.url);

  // Check if this matches the WebSocket terminal route pattern
  const wsMatch = url.pathname.match(/^\/api\/terminal\/([^\/]+)\/ws$/);
  const upgradeHeader = request.headers.get('Upgrade');

  // Not a WebSocket terminal route
  if (!wsMatch || upgradeHeader?.toLowerCase() !== 'websocket') {
    return { isWebSocketRoute: false };
  }

  const fullSessionId = wsMatch[1];

  // Parse compound sessionId (e.g., "abc123-1" -> baseSession="abc123", terminalId="1")
  const compoundMatch = fullSessionId.match(/^(.+)-([1-6])$/);
  const baseSessionId = compoundMatch ? compoundMatch[1] : fullSessionId;
  const terminalId = compoundMatch ? compoundMatch[2] : '1';

  // Validate sessionId format (8-24 lowercase alphanumeric)
  if (!SESSION_ID_PATTERN.test(baseSessionId)) {
    return {
      isWebSocketRoute: true,
      errorResponse: new Response(JSON.stringify({ error: 'Invalid session ID format', code: 'INVALID_SESSION' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    };
  }

  return {
    isWebSocketRoute: true,
    fullSessionId,
    baseSessionId,
    terminalId,
  };
}

/**
 * Handle WebSocket upgrade for terminal connections
 * This must be called from index.ts BEFORE Hono because Hono doesn't handle WebSocket upgrades correctly
 *
 * @param request - The incoming request
 * @param env - Environment bindings
 * @param ctx - Execution context
 * @param routeResult - Pre-validated routing result
 * @returns WebSocket upgrade response or error response
 */
export async function handleWebSocketUpgrade(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  routeResult: WebSocketRouteResult
): Promise<Response> {
  // Extract or generate X-Request-ID for tracing
  const clientRequestId = request.headers.get('X-Request-ID');
  const requestId = (clientRequestId && REQUEST_ID_PATTERN.test(clientRequestId))
    ? clientRequestId
    : crypto.randomUUID().slice(0, REQUEST_ID_LENGTH);

  const { fullSessionId, baseSessionId, terminalId } = routeResult;

  if (!fullSessionId || !baseSessionId || !terminalId) {
    return new Response(JSON.stringify({ error: 'Invalid routing result', code: 'INVALID_ROUTING' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId }
    });
  }

  const jsonHeaders: Record<string, string> = { 'Content-Type': 'application/json', 'X-Request-ID': requestId };

  // Browser clients send Sec-WebSocket-Key + Sec-Fetch-Mode; require Origin for these (FIX-16).
  // CLI clients (e.g., websocat, wscat) don't send Sec-Fetch-Mode — intentionally allowed without Origin.
  const isBrowserClient = !!request.headers.get('Sec-WebSocket-Key') &&
                          !!request.headers.get('Sec-Fetch-Mode');
  if (isBrowserClient && !request.headers.get('Origin')) {
    return new Response('Origin header required for browser WebSocket connections', {
      status: 403,
      headers: jsonHeaders,
    });
  }

  // Validate Origin header for WebSocket upgrade (S5-14)
  const origin = request.headers.get('Origin');
  if (origin) {
    const devMode = env.DEV_MODE === 'true';
    let originAllowed = await isAllowedOrigin(origin, env);
    if (!originAllowed && devMode) {
      try {
        const originUrl = new URL(origin);
        originAllowed = originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1';
      } catch {
        // Invalid origin URL
      }
    }
    if (!originAllowed) {
      logger.warn('WebSocket upgrade rejected: origin not allowed', { origin });
      return new Response(JSON.stringify({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' }), {
        status: 403,
        headers: jsonHeaders,
      });
    }
  }

  try {
    // Authenticate user (shared logic with authMiddleware)
    let user;
    let bucketName;
    try {
      ({ user, bucketName } = await authenticateRequest(request, env));
    } catch (err) {
      if (err instanceof AuthError) {
        return new Response(JSON.stringify({ error: err.message, code: 'AUTH_FAILED' }), { status: 401, headers: jsonHeaders });
      }
      if (err instanceof ForbiddenError) {
        return new Response(JSON.stringify({ error: err.message, code: 'FORBIDDEN' }), { status: 403, headers: jsonHeaders });
      }
      throw err;
    }

    // WebSocket connection rate limiting: 30 connections/min per user (FIX-21)
    // Fail-open on KV errors (AD35)
    try {
      const wsRateKey = `ws-connect:${user.email}`;
      const wsRateData = await env.KV.get<{ count: number; windowStart: number }>(wsRateKey, 'json');
      const now = Date.now();

      let count = 1;
      let windowStart = now;

      if (wsRateData && wsRateData.windowStart > now - WS_RATE_LIMIT_WINDOW_MS) {
        count = wsRateData.count + 1;
        windowStart = wsRateData.windowStart;
      }

      if (count > WS_RATE_LIMIT_MAX_CONNECTIONS) {
        const retryAfterSec = Math.ceil((WS_RATE_LIMIT_WINDOW_MS - (now - windowStart)) / 1000);
        logger.warn('WebSocket rate limit exceeded', { email: user.email, count });
        return new Response(null, {
          status: 429,
          headers: { ...jsonHeaders, 'Retry-After': String(retryAfterSec) },
          webSocket: undefined,
        });
      }

      await env.KV.put(wsRateKey, JSON.stringify({ count, windowStart }), {
        expirationTtl: WS_RATE_LIMIT_TTL_SECONDS,
      });
    } catch (err) {
      // Fail-open: KV errors should not block WebSocket connections (AD35)
      logger.warn('WebSocket rate limit KV error, allowing connection', { error: toErrorMessage(err) });
    }

    const containerId = getContainerId(bucketName, baseSessionId);

    logger.info('User authenticated for WebSocket', { email: user.email, containerId, terminalId });

    // Validate session exists using BASE sessionId
    const sessionKey = getSessionKey(bucketName, baseSessionId);
    const session = await env.KV.get<Session>(sessionKey, 'json');

    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }), {
        status: 404,
        headers: jsonHeaders,
      });
    }

    // Update last accessed timestamp (don't await)
    // Re-read session inside waitUntil to avoid stale read-modify-write race (FIX-23)
    ctx.waitUntil((async () => {
      const fresh = await env.KV.get<Session>(sessionKey, 'json');
      if (fresh) {
        fresh.lastAccessedAt = new Date().toISOString();
        await env.KV.put(sessionKey, JSON.stringify(fresh));
      }
    })().catch(err => logger.warn('Failed to update lastAccessedAt', { error: toErrorMessage(err) })));

    // Get container using session-specific ID (one container per browser tab)
    const container = getContainer(env.CONTAINER, containerId);

    // Build terminal WebSocket URL
    const terminalUrl = new URL(request.url);
    terminalUrl.pathname = '/terminal';
    terminalUrl.searchParams.set('session', fullSessionId);  // Pass full compound ID to container
    terminalUrl.searchParams.set('name', session.name);
    terminalUrl.searchParams.set('terminalId', terminalId);
    // Forward manual flag so container can skip .bashrc autostart for user-created tabs
    const incomingUrl = new URL(request.url);
    if (incomingUrl.searchParams.get('manual') === '1') {
      terminalUrl.searchParams.set('manual', '1');
    }

    logger.info('Forwarding WebSocket to container', { pathname: terminalUrl.pathname, search: terminalUrl.search });

    // Forward WebSocket request directly to container
    // Using the original request preserves WebSocket upgrade headers
    const response = await container.fetch(new Request(terminalUrl.toString(), request));

    logger.info('Container WebSocket response', {
      status: response.status,
      fullSessionId,
      terminalId,
      containerId,
    });
    return response;
  } catch (err) {
    logger.error('WebSocket upgrade error', toError(err));
    // Don't expose internal error details to client
    return new Response(JSON.stringify({
      error: 'WebSocket connection failed',
      code: 'WS_CONNECTION_FAILED',
    }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables & { requestId: string } }>();

// Use shared auth middleware
app.use('*', authMiddleware);

/**
 * GET /api/terminal/:sessionId/status
 * Get terminal connection status for a session
 *
 * Uses :sessionId (not :id) because the path /api/terminal/:sessionId/status
 * refers to a terminal's session, not the terminal resource itself
 */
app.get('/:sessionId/status', async (c) => {
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('sessionId');

  // Validate session
  const sessionKey = getSessionKey(bucketName, sessionId);
  const session = await c.env.KV.get<Session>(sessionKey, 'json');

  if (!session) {
    throw new NotFoundError('Session');
  }

  // Check container status
  try {
    const containerId = getContainerId(bucketName, sessionId);
    const container = getContainer(c.env.CONTAINER, containerId);

    // Check terminal server health (runs on default port 8080)
    const healthResult = await checkContainerHealth(container);

    if (!healthResult.healthy) {
      return c.json({
        session,
        containerRunning: true,
        terminalServerReady: false,
      });
    }

    // Check if this session has an active PTY (terminal server on default port)
    const sessionsResponse = await containerSessionsCB.execute(() =>
      container.fetch(
        new Request('http://container/sessions', { method: 'GET' })
      )
    );

    let ptyActive = false;
    if (sessionsResponse.ok) {
      const data = (await sessionsResponse.json()) as {
        sessions: { id: string }[];
      };
      ptyActive = data.sessions.some((s) => s.id === sessionId);
    }

    return c.json({
      session,
      containerRunning: true,
      terminalServerReady: true,
      ptyActive,
      wsUrl: `/api/terminal/${sessionId}/ws`,
    });
  } catch (err) {
    // Container not running
    return c.json({
      session,
      containerRunning: false,
      terminalServerReady: false,
      ptyActive: false,
      wsUrl: `/api/terminal/${sessionId}/ws`,
    });
  }
});

export default app;
