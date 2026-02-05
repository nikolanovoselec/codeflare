import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './types';
import userRoutes from './routes/user-profile';
import containerRoutes from './routes/container/index';
import sessionRoutes from './routes/session/index';
import terminalRoutes, { validateWebSocketRoute, handleWebSocketUpgrade } from './routes/terminal';
import usersRoutes from './routes/users';
import setupRoutes from './routes/setup/index';
import adminRoutes from './routes/admin';
import storageRoutes from './routes/storage';
import presetRoutes from './routes/presets';
import preferenceRoutes from './routes/preferences';
import publicRoutes from './routes/public/index';
import { REQUEST_ID_LENGTH, REQUEST_ID_PATTERN, CORS_MAX_AGE_SECONDS } from './lib/constants';
import { AppError } from './lib/error-types';
import { isAllowedOrigin } from './lib/cors-cache';
import {
  resetSetupCache as resetSetupCacheShared,
  getSetupCompleteCache,
  setSetupCompleteCache,
} from './lib/cache-reset';
import { createLogger, setLogLevel } from './lib/logger';
import type { LogLevel } from './lib/logger';
import { authenticateRequest } from './lib/access';
import { isOnboardingLandingPageActive } from './lib/onboarding';

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

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const logger = createLogger('index');

// ============================================================================
// Request Tracing Middleware
// ============================================================================
app.use('*', async (c, next) => {
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

// CORS middleware - restrict to trusted origins (configurable via ALLOWED_ORIGINS env var)
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');

  // Determine allowed origin for this request
  let allowedOrigin: string | null = null;
  if (!origin) {
    // No origin header (same-origin, curl, etc.) — skip CORS headers entirely
    allowedOrigin = null;
  } else if (await isAllowedOrigin(origin, c.env)) {
    // Check against configurable allowed patterns
    allowedOrigin = origin;
  } else if (c.env.DEV_MODE === 'true') {
    // Allow localhost only in development mode
    try {
      const originUrl = new URL(origin);
      if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') {
        allowedOrigin = origin;
      }
    } catch {
      // Invalid origin URL, skip
    }
  }

  // Handle preflight OPTIONS requests
  if (c.req.method === 'OPTIONS') {
    const headers: Record<string, string> = {};
    if (allowedOrigin) {
      headers['Access-Control-Allow-Origin'] = allowedOrigin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With';
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

// Body size limit on API routes (64 KiB) — storage routes define their own limits
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

// Setup routes (public - no auth required)
app.route('/api/setup', setupRoutes);
app.route('/public', publicRoutes);

// Admin routes (requires admin role via CF Access)
app.route('/api/admin', adminRoutes);

// API routes
app.route('/api/user', userRoutes);
app.route('/api/container', containerRoutes);
app.route('/api/sessions', sessionRoutes);
app.route('/api/terminal', terminalRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/storage', storageRoutes);
app.route('/api/presets', presetRoutes);
app.route('/api/preferences', preferenceRoutes);

// 404 fallback - only for API routes
app.notFound((c) => c.json({ error: 'Not found' }, 404));

/**
 * Reset the in-memory setup cache. Call this when setup completes
 * so the next request re-checks KV.
 *
 * Resets the local setupComplete flag plus all shared caches
 * (CORS origins, auth config, JWKS) via the centralized helper.
 */
export function resetSetupCache() {
  resetSetupCacheShared();
}

// Server-rendered onboarding page removed — now served by the SPA.
// The SPA fetches config from GET /public/onboarding-config and renders
// the OnboardingLanding component with Turnstile + waitlist form.


// ============================================================================
// Global Error Handler
// ============================================================================
// Convention: Routes should throw AppError subclasses for error handling.
// Exception: Routes with domain-specific error response shapes (e.g., startup-status)
// may catch and return directly when the shape differs from AppError.toJSON().
type AppStatusCode = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

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

  logger.error('Unexpected error', err instanceof Error ? err : new Error(String(err)), { requestId });
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
    const wsRouteResult = validateWebSocketRoute(request, env);

    if (wsRouteResult.isWebSocketRoute) {
      // Return early error if validation failed
      if (wsRouteResult.errorResponse) {
        return wsRouteResult.errorResponse;
      }

      // Handle WebSocket upgrade
      return handleWebSocketUpgrade(request, env, ctx, wsRouteResult);
    }

    // Only route API and health requests through Hono
    // Non-API routes fall through to static assets (SPA)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/public/') || url.pathname === '/health') {
      return app.fetch(request, env, ctx);
    }

    // Setup redirect: if setup is not complete, redirect non-setup pages to /setup
    const path = url.pathname;
    if (path !== '/setup' && !path.startsWith('/setup/')) {
      // Check setup status (with in-memory cache)
      if (getSetupCompleteCache() === null) {
        const status = await env.KV.get('setup:complete');
        setSetupCompleteCache(status === 'true');
      }
      if (!getSetupCompleteCache()) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/setup' },
        });
      }
    }

    // Root behavior is mode-dependent:
    // - default mode: redirect / to /app/
    // - onboarding mode: serve SPA (OnboardingLanding component handles the UI)
    if (path === '/') {
      if (!onboardingLandingActive) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/app/' },
        });
      }

      try {
        // If this browser already has a valid Access session + allowlist membership,
        // redirect directly to the authenticated app shell.
        await authenticateRequest(request, env);
        return new Response(null, {
          status: 302,
          headers: { Location: '/app/' },
        });
      } catch {
        // Unauthenticated or not allowlisted users stay on the public landing page.
        // Fall through to serve the SPA which renders the OnboardingLanding component.
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
    secureResponse.headers.set('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' wss:; img-src 'self' data: https://www.gravatar.com; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    return secureResponse;
  }
};

// Export Durable Objects
// Export container class for Durable Objects
export { container } from './container';
