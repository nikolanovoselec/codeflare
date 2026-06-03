import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { Env } from './types';
import userRoutes from './routes/user-profile';
import containerRoutes from './routes/container/index';
import sessionRoutes from './routes/session/index';
import terminalRoutes, { validateWebSocketRoute, handleWebSocketUpgrade } from './routes/terminal';
import vaultRoutes, { validateVaultRoute, handleVaultRequest } from './routes/vault';
import usersRoutes from './routes/users';
import setupRoutes from './routes/setup/index';
import storageRoutes from './routes/storage';
import presetRoutes from './routes/presets';
import preferenceRoutes from './routes/preferences';
import llmKeysRoutes from './routes/llm-keys';
import deployKeysRoutes from './routes/deploy-keys';
import publicRoutes from './routes/public/index';
import usageRoutes from './routes/usage';
import adminTiersRoutes from './routes/admin/tiers';
import billingRoutes from './routes/billing';
import stripeWebhookRoute from './routes/stripe-webhook';
import { REQUEST_ID_LENGTH, REQUEST_ID_PATTERN, CORS_MAX_AGE_SECONDS } from './lib/constants';
import { AppError, toError } from './lib/error-types';
import { isAllowedOrigin } from './lib/cors-cache';
import {
  getSetupCompleteCache,
  setSetupCompleteCache,
} from './lib/cache-reset';
import { createLogger, setLogLevel } from './lib/logger';
import type { LogLevel } from './lib/logger';
import { authenticateRequest } from './lib/access';
import { SETUP_KEYS } from './lib/kv-keys';
import { verifySessionJWT, shouldRefreshJWT, signSessionJWT, SESSION_JWT_AUD, cookieDomainAttr } from './lib/session-jwt';
import { warnIfNoEncryptionKey } from './lib/kv-crypto';
import { isOnboardingLandingPageActive, isSaasModeActive } from './lib/onboarding';
import { isActiveUser } from './lib/access-tier';
import { getEffectiveTier } from './lib/subscription';
import authApiRoutes from './routes/auth';
import authRedirectRoutes from './routes/auth-redirects';
import githubAuthRoutes from './routes/github-auth';

// Type for app context with request ID
type AppVariables = {
  requestId: string;
};

/** Security headers applied to every response (middleware + SPA handler) */
const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Content-Security-Policy': "default-src 'none'",
};

/**
 * CF-001: Apply SECURITY_HEADERS to a response built outside the Hono pipeline.
 * The module-level fetch handler returns early (vault/websocket routes) BEFORE
 * app.fetch, so those responses never hit the post-handler middleware that sets
 * SECURITY_HEADERS. Wrapping those early returns here closes the gap.
 *
 * No-op for 101 (WebSocket upgrade) responses, which cannot carry these headers,
 * and for responses that already have them (avoids double-cloning the SPA path).
 */
export function withSecurityHeaders(response: Response, opts?: { csp?: boolean }): Response {
  if (response.status === 101) return response;
  if (response.headers.has('X-Content-Type-Options')) return response;
  const secured = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    // The vault path proxies SilverBullet, which serves its own HTML with
    // inline scripts/styles, web workers and eval; a `default-src 'none'`
    // CSP blocks all of it. Callers serving proxied vault content pass
    // `csp: false` to keep the transport/clickjacking headers while letting
    // the proxied app run (same-origin, authenticated, user-owned content).
    if (key === 'Content-Security-Policy' && opts?.csp === false) continue;
    secured.headers.set(key, value);
  }
  return secured;
}

/**
 * Create a redirect response that includes security headers (HSTS, etc.).
 * Wraps the bare `new Response(null, { status, headers: { Location } })` pattern
 * so redirect responses aren't missing security headers.
 */
export function redirectWithHeaders(location: string, status: 301 | 302 | 307 | 308 = 302): Response {
  const headers: Record<string, string> = {
    Location: location,
    ...SECURITY_HEADERS,
  };
  return new Response(null, { status, headers });
}

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const logger = createLogger('index');

// ============================================================================
// Request Tracing Middleware
// ============================================================================
app.use('*', async (c, next) => {
  // CF-001: Hard enforcement - STRESS_TEST_MODE must never bypass rate limits in SaaS production.
  if (c.env.SAAS_MODE === 'active' && c.env.STRESS_TEST_MODE === 'active') {
    logger.error('BLOCKED: STRESS_TEST_MODE active in SaaS production', undefined, { path: c.req.path });
    return c.json({ error: 'Misconfiguration: stress test mode cannot be active in SaaS production' }, 503);
  }

  // CF-017: Warn on first request if credentials will be stored as plaintext
  warnIfNoEncryptionKey(c.env.ENCRYPTION_KEY);

  const clientId = c.req.header('X-Request-ID');
  const requestId = (clientId && REQUEST_ID_PATTERN.test(clientId))
    ? clientId
    : crypto.randomUUID().slice(0, REQUEST_ID_LENGTH);
  c.header('X-Request-ID', requestId);
  c.set('requestId', requestId);

  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    c.header(key, value);
  }

  logger.info('Request completed', {
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: duration,
  });
});

// SaaS mode: cookie refresh middleware - extends session when < 15 min remaining
app.use('*', async (c, next) => {
  await next();
  // Only refresh for SaaS OIDC mode
  if (!isSaasModeActive(c.env.SAAS_MODE) || !c.env.OAUTH_CLIENT_ID || !c.env.OAUTH_JWT_SECRET) return;
  const cookieHeader = c.req.header('Cookie');
  if (!cookieHeader) return;
  const match = cookieHeader.match(/codeflare_session=([^;]+)/);
  if (!match) return;
  try {
    const payload = await verifySessionJWT(match[1], c.env.OAUTH_JWT_SECRET, SESSION_JWT_AUD);
    if (payload && shouldRefreshJWT(payload)) {
      const refreshed = await signSessionJWT(
        { email: payload.email, sub: payload.sub, ghLogin: payload.ghLogin, aud: SESSION_JWT_AUD },
        c.env.OAUTH_JWT_SECRET,
      );
      const domainAttr = cookieDomainAttr(await c.env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN));
      c.header('Set-Cookie', `codeflare_session=${refreshed}; HttpOnly; Secure; SameSite=Lax; Path=/${domainAttr}; Max-Age=3600`);
    }
  } catch { /* non-fatal - don't break the response */ }
});

// CORS middleware - restrict to trusted origins (configurable via ALLOWED_ORIGINS env var)
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');

  // Determine allowed origin for this request
  let allowedOrigin: string | null = null;
  if (!origin) {
    // No origin header (same-origin, curl, etc.) - skip CORS headers entirely
    allowedOrigin = null;
  } else if (await isAllowedOrigin(origin, c.env)) {
    // Check against configurable allowed patterns
    allowedOrigin = origin;
  }

  // Handle preflight OPTIONS requests
  if (c.req.method === 'OPTIONS') {
    const headers: Record<string, string> = {};
    if (allowedOrigin) {
      headers['Access-Control-Allow-Origin'] = allowedOrigin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With, X-Vault-Csrf';
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers['Access-Control-Max-Age'] = CORS_MAX_AGE_SECONDS.toString();
    }
    // Apply HSTS to preflight responses (not covered by post-handler middleware)
    headers['Strict-Transport-Security'] = SECURITY_HEADERS['Strict-Transport-Security'];
    return new Response(null, { status: 204, headers });
  }

  // Continue to next handler
  await next();

  // Set CORS headers on response
  if (allowedOrigin) {
    c.res.headers.set('Access-Control-Allow-Origin', allowedOrigin);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  }
});

// Body size limit on API routes (64 KiB) - storage routes define their own limits
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/storage/')) {
    return next();
  }
  return bodyLimit({ maxSize: 64 * 1024 })(c, next);
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Static assets are served by Cloudflare Workers Assets at /
// Frontend SPA handles all non-API routes via its own routing

// Auth routes (mounted before setup routes)
app.route('/api/auth', authApiRoutes);
app.route('/auth/github', githubAuthRoutes);
app.route('/auth', authRedirectRoutes);

// Public auth providers endpoint (outside /api/* to bypass CF Access).
// SaaS mode: show GitHub only + any custom IdPs listed by UUID in SAAS_EXTRA_IDPS.
// Non-SaaS: show all social IdPs + extra IdPs.
const SOCIAL_IDP_TYPES = new Set(['google', 'github', 'facebook', 'linkedin']);
app.get('/public/auth/providers', async (c) => {
  const saas = isSaasModeActive(c.env.SAAS_MODE);

  // SaaS mode with GitHub OIDC: return hardcoded provider with direct login URL
  if (saas && c.env.OAUTH_CLIENT_ID) {
    return c.json({
      providers: [{ id: 'github', type: 'github', name: 'GitHub', loginUrl: '/auth/github/login' }],
    });
  }

  // CF Access mode: fetch IdP list from KV
  const idpList = await c.env.KV.get<Array<{ id: string; type: string; name: string }>>(SETUP_KEYS.IDP_LIST, 'json');
  const extraIds = new Set(
    (c.env.SAAS_EXTRA_IDPS || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  const filtered = (idpList || []).filter(p => {
    if (extraIds.has(p.id)) return true;
    return saas ? p.type === 'github' : SOCIAL_IDP_TYPES.has(p.type);
  });
  return c.json({ providers: filtered });
});

// Setup routes (public - no auth required)
app.route('/api/setup', setupRoutes);
// CF-004: Stripe is mounted outside /api/*, so the /api/* bodyLimit doesn't cover it.
// The webhook reads the raw body before signature verification - cap it (1 MiB).
app.use('/public/stripe/*', bodyLimit({ maxSize: 1024 * 1024 }));
app.route('/public/stripe', stripeWebhookRoute);  // Must be before /public catch-all
app.route('/public', publicRoutes);

// API routes
app.route('/api/user', userRoutes);
app.route('/api/container', containerRoutes);
app.route('/api/sessions', sessionRoutes);
app.route('/api/terminal', terminalRoutes);
app.route('/api/vault', vaultRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/storage', storageRoutes);
app.route('/api/presets', presetRoutes);
app.route('/api/preferences', preferenceRoutes);
app.route('/api/llm-keys', llmKeysRoutes);
app.route('/api/deploy-keys', deployKeysRoutes);
app.route('/api/usage', usageRoutes);
app.route('/api/admin/tiers', adminTiersRoutes);
app.route('/api/billing', billingRoutes);

// 404 fallback - only for API routes
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ============================================================================
// Global Error Handler
// ============================================================================
// Convention: Routes should throw AppError subclasses for error handling.
// Exception: Routes with domain-specific error response shapes (e.g., startup-status)
// may catch and return directly when the shape differs from AppError.toJSON().
type AppStatusCode = 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 503;

app.onError((err, c) => {
  const requestId = c.get('requestId') || 'unknown';

  if (err instanceof AppError) {
    logger.warn(err.message, {
      requestId,
      code: err.code,
      statusCode: err.statusCode,
    });
    return c.json(err.toJSON(), err.statusCode as AppStatusCode);
  }

  // Hono throws HTTPException for framework-level rejections (e.g. bodyLimit ->
  // 413). Preserve its real status instead of masking it as a generic 500.
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  logger.error('Unexpected error', toError(err), { requestId });
  return c.json({ error: 'An unexpected error occurred' }, 500);
});

/**
 * Custom fetch handler that intercepts WebSocket requests BEFORE Hono
 * This is required because Hono doesn't handle WebSocket upgrade correctly
 * See: https://github.com/cloudflare/workerd/issues/2319
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (env.LOG_LEVEL) {
      setLogLevel(env.LOG_LEVEL as LogLevel);
    }

    const url = new URL(request.url);
    const onboardingLandingActive = isOnboardingLandingPageActive(env.ONBOARDING_LANDING_PAGE);

    // AUTH: WebSocket upgrade handled here before Hono middleware.
    // See also: src/routes/terminal.ts (WebSocket auth), src/middleware/auth.ts (HTTP auth)
    const wsRouteResult = validateWebSocketRoute(request);

    if (wsRouteResult.isWebSocketRoute) {
      // Return early error if validation failed
      if (wsRouteResult.errorResponse) {
        return withSecurityHeaders(wsRouteResult.errorResponse);
      }

      // Handle WebSocket upgrade (101 responses are passed through unchanged)
      return withSecurityHeaders(await handleWebSocketUpgrade(request, env, ctx, wsRouteResult));
    }

    // Vault proxy (HTTP + WS) - intercept BEFORE Hono so SilverBullet's
    // static assets and live-sync WS URLs are not filtered by Hono
    // routes. `/api/vault/:sid/status` falls through to Hono for the
    // small JSON status endpoint; everything else is proxied to the
    // in-container SilverBullet server.
    const vaultRouteResult = validateVaultRoute(request);
    if (vaultRouteResult.isVaultRoute) {
      if (vaultRouteResult.errorResponse) {
        return withSecurityHeaders(vaultRouteResult.errorResponse);
      }
      if (vaultRouteResult.remainingPath !== '/status') {
        return withSecurityHeaders(await handleVaultRequest(request, env, ctx, vaultRouteResult), { csp: false });
      }
    }

    // Only route API and health requests through Hono
    // Non-API routes fall through to static assets (SPA)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/public/') || url.pathname === '/health') {
      return app.fetch(request, env, ctx);
    }

    // Setup redirect: if setup is not complete, redirect non-setup pages to /setup
    const path = url.pathname;
    if (path !== '/setup' && !path.startsWith('/setup/')) {
      // Check setup status (with in-memory cache)
      if (getSetupCompleteCache() === null) {
        const status = await env.KV.get(SETUP_KEYS.COMPLETE);
        setSetupCompleteCache(status === 'true');
      }
      if (!getSetupCompleteCache()) {
        return redirectWithHeaders('/setup');
      }
    }

    // Root behavior is mode-dependent:
    // - SaaS mode: redirect active users to /app/, serve SPA (LoginPage) otherwise
    // - default mode: redirect / to /app/
    // - onboarding mode: serve SPA (OnboardingLanding component handles the UI)
    if (path === '/') {
      const saasActive = isSaasModeActive(env.SAAS_MODE);
      if (saasActive) {
        try {
          const { user } = await authenticateRequest(request, env);
          // HIGH-1: Use billing-aware tier resolution, not raw tier field
          const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd);
          if (isActiveUser(effectiveTier)) {
            return redirectWithHeaders('/app/');
          }
          // Authenticated but pending/blocked - redirect to subscribe page
          return redirectWithHeaders('/app/subscribe');
        } catch {
          // Not authenticated - serve SPA (LoginPage)
        }
      } else if (!onboardingLandingActive) {
        return redirectWithHeaders('/app/');
      } else {
        try {
          await authenticateRequest(request, env);
          return redirectWithHeaders('/app/');
        } catch {
          // Unauthenticated - serve landing page
        }
      }
    }

    // For all other routes, serve from static assets
    // With not_found_handling = "single-page-application", missing routes get index.html
    const assetResponse = await env.ASSETS.fetch(request);
    const secureResponse = new Response(assetResponse.body, assetResponse);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      secureResponse.headers.set(key, value);
    }
    // CSP includes Turnstile origins (challenges.cloudflare.com) because the SPA
    // renders the onboarding landing page with Turnstile widget when onboarding is active.
    // style-src retains 'unsafe-inline' (CF-016): the React SPA renders many inline
    // style={{...}} attributes across components, which CSP nonces/hashes cannot cover
    // (those apply to <style> elements, not the style= attribute). Removing it would break
    // rendering and require rewriting every call site. script-src is already nonce-free and
    // tight; this residual is style-injection-only (low blast radius).
    secureResponse.headers.set('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' wss:; img-src 'self' data: https://www.gravatar.com; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    return secureResponse;
  }
};

// Export Durable Objects
// Export container class for Durable Objects
export { container } from './container';
export { Timekeeper as timekeeper } from './timekeeper/index';
