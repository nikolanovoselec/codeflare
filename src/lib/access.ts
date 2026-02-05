import type { AccessUser, Env, UserRole } from '../types';
import { verifyAccessJWT } from './jwt';
import { AuthError, ForbiddenError } from './error-types';

// Module-level cache for auth config (avoids KV reads on every request)
const AUTH_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedAuthDomain: string | null | undefined = undefined;
let cachedAccessAud: string | null | undefined = undefined;
let cachedAccessAudList: string[] | null | undefined = undefined;
let authConfigCachedAt = 0;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Reset cached auth config. Call when setup completes or config changes.
 */
export function resetAuthConfigCache(): void {
  cachedAuthDomain = undefined;
  cachedAccessAud = undefined;
  cachedAccessAudList = undefined;
  authConfigCachedAt = 0;
}

function getCookieValue(cookieHeader: string | null, key: string): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const [rawKey, ...rest] = pair.trim().split('=');
    if (rawKey === key) {
      return rest.join('=') || null;
    }
  }
  return null;
}

/**
 * Extract user info from Cloudflare Access.
 *
 * Supports three authentication methods:
 *
 * 1. Browser/JWT authentication (via CF Access login):
 *    - cf-access-jwt-assertion: full JWT (verified via JWKS when auth_domain/access_aud are configured)
 *    - cf-access-authenticated-user-email: user's email (fallback when JWT config not yet stored)
 *
 * 2. Service token authentication (for API/CLI clients):
 *    - CF-Access-Client-Id: service token ID
 *    - CF-Access-Client-Secret: service token secret
 *    When CF Access validates a service token, it sets cf-access-client-id header.
 *    Service tokens are mapped to SERVICE_TOKEN_EMAIL env var or default email.
 *
 * In DEV_MODE, returns a test user when no Access headers are present.
 */
export async function getUserFromRequest(request: Request, env?: Env): Promise<AccessUser> {
  // Check for JWT assertion header first (primary auth method)
  const jwtAssertionHeader = request.headers.get('cf-access-jwt-assertion');
  const jwtCookie = getCookieValue(request.headers.get('Cookie'), 'CF_Authorization');
  const jwtToken = jwtAssertionHeader || jwtCookie;

  // Load auth config from KV REGARDLESS of JWT presence (FIX-1).
  // This determines whether we're in pre-setup or post-setup state.
  // Invalidate stale cache after TTL (FIX-9)
  if (authConfigCachedAt > 0 && Date.now() - authConfigCachedAt > AUTH_CONFIG_CACHE_TTL_MS) {
    cachedAuthDomain = undefined;
    cachedAccessAud = undefined;
    cachedAccessAudList = undefined;
  }
  if (env?.KV) {
    if (cachedAuthDomain === undefined) {
      cachedAuthDomain = await env.KV.get('setup:auth_domain');
    }
    if (cachedAccessAudList === undefined) {
      const audListRaw = await env.KV.get('setup:access_aud_list');
      if (audListRaw) {
        try {
          const parsed = JSON.parse(audListRaw);
          if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
            cachedAccessAudList = parsed;
          } else {
            cachedAccessAudList = null;
          }
        } catch {
          cachedAccessAudList = null;
        }
      } else {
        cachedAccessAudList = null;
      }
    }
    if (cachedAccessAud === undefined) {
      cachedAccessAud = await env.KV.get('setup:access_aud');
    }
    authConfigCachedAt = Date.now();
  }

  const accessAudList = cachedAccessAudList && cachedAccessAudList.length > 0
    ? cachedAccessAudList
    : (cachedAccessAud ? [cachedAccessAud] : []);
  const authConfigured = !!(cachedAuthDomain && accessAudList.length > 0);

  // JWT verification: if token present and auth is configured, verify it
  if (jwtToken && authConfigured && cachedAuthDomain) {
    for (const expectedAud of accessAudList) {
      const verifiedEmail = await verifyAccessJWT(jwtToken, cachedAuthDomain, expectedAud);
      if (verifiedEmail) {
        return { email: normalizeEmail(verifiedEmail), authenticated: true };
      }
    }

    // JWT verification failed
    // In DEV_MODE, fall through to header-based trust
    if (env?.DEV_MODE !== 'true') {
      return { email: '', authenticated: false };
    }
  }

  // Post-setup (auth configured) but NO JWT: reject even if header is present (FIX-1).
  // This prevents header spoofing when Cloudflare Access is configured.
  if (authConfigured && !jwtToken && env?.DEV_MODE !== 'true') {
    return { email: '', authenticated: false };
  }

  // Pre-setup fallback: trust email header (allows setup wizard to work)
  const email = request.headers.get('cf-access-authenticated-user-email');

  if (email) {
    return { email: normalizeEmail(email), authenticated: true };
  }

  // Service token authentication
  // When CF Access validates service token, it passes through cf-access-client-id
  const serviceTokenClientId = request.headers.get('cf-access-client-id');

  if (serviceTokenClientId) {
    // Service token was validated by CF Access
    // Use SERVICE_TOKEN_EMAIL env var or fall back to a default based on client ID
    const serviceEmail = env?.SERVICE_TOKEN_EMAIL || `service-${serviceTokenClientId.split('.')[0]}@codeflare.local`;
    return { email: normalizeEmail(serviceEmail), authenticated: true };
  }

  // DEV_MODE bypass: return user from SERVICE_TOKEN_EMAIL when no Access headers
  if (env?.DEV_MODE === 'true') {
    const devEmail = env?.SERVICE_TOKEN_EMAIL || 'test@example.com';
    return { email: normalizeEmail(devEmail), authenticated: true };
  }

  return { email: '', authenticated: false };
}

/**
 * Generate a bucket name from email.
 * Format: {workerName}-{sanitized-email}
 * Rules: lowercase, replace @ and . with -, truncate to 63 chars
 *
 * @param email - User email address
 * @param workerName - CLOUDFLARE_WORKER_NAME (defaults to 'codeflare')
 */
export function getBucketName(email: string, workerName?: string): string {
  const sanitized = email
    .toLowerCase()
    .trim()
    .replace(/@/g, '-')
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const prefix = `${workerName || 'codeflare'}-`;
  const maxLength = 63;
  const maxSanitizedLength = maxLength - prefix.length;

  return `${prefix}${sanitized.substring(0, maxSanitizedLength)}`;
}

/**
 * Resolve a user entry from KV, returning role information.
 * Defaults missing role to 'user' for backward compatibility with
 * entries created before role support was added.
 */
export async function resolveUserFromKV(
  kv: KVNamespace,
  email: string
): Promise<{ addedBy: string; addedAt: string; role: UserRole } | null> {
  const normalizedEmail = normalizeEmail(email);
  const raw = await kv.get(`user:${normalizedEmail}`);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { addedBy?: unknown; addedAt?: unknown; role?: unknown };
  return {
    addedBy: typeof obj.addedBy === 'string' ? obj.addedBy : 'unknown',
    addedAt: typeof obj.addedAt === 'string' ? obj.addedAt : '',
    role: obj.role === 'admin' ? 'admin' : 'user',
  };
}

/**
 * Authenticate a request and resolve user identity + bucket name.
 * Shared between authMiddleware (Hono routes) and handleWebSocketUpgrade (raw handler).
 *
 * Throws AuthError if not authenticated, ForbiddenError if user not in allowlist.
 */
export async function authenticateRequest(
  request: Request,
  env: Env
): Promise<{ user: AccessUser; bucketName: string }> {
  // CSRF protection: require X-Requested-With header on state-changing methods
  const method = request.method.toUpperCase();
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    if (!request.headers.get('X-Requested-With')) {
      throw new ForbiddenError('Missing X-Requested-With header');
    }
  }

  const rawUser = await getUserFromRequest(request, env);
  if (!rawUser.authenticated) {
    throw new AuthError('Not authenticated');
  }
  const normalizedEmail = normalizeEmail(rawUser.email);
  if (!normalizedEmail) {
    throw new AuthError('Not authenticated');
  }
  let role: UserRole;
  if (env.DEV_MODE !== 'true') {
    const kvEntry = await resolveUserFromKV(env.KV, normalizedEmail);
    if (!kvEntry) {
      throw new ForbiddenError('User not in allowlist');
    }
    role = kvEntry.role;
  } else {
    role = 'admin';
  }
  const bucketName = getBucketName(normalizedEmail, env.CLOUDFLARE_WORKER_NAME);
  return { user: { ...rawUser, email: normalizedEmail, role }, bucketName };
}
