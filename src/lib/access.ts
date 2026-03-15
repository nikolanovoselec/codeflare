import type { AccessTier, AccessUser, Env, UserRole } from '../types';
import { verifyAccessJWT } from './jwt';
import { AuthError, ForbiddenError } from './error-types';
import { createLogger } from './logger';
import { isSaasModeActive } from './onboarding';

const logger = createLogger('access');

// Module-level cache for auth config (avoids KV reads on every request)
const AUTH_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedAuthDomain: string | null | undefined = undefined;
let cachedAccessAud: string | null | undefined = undefined;
let cachedAccessAudList: string[] | null | undefined = undefined;
let authConfigCachedAt = 0;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const VALID_ACCESS_TIERS = new Set<string>(['pending', 'standard', 'advanced', 'blocked']);

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
          logger.warn('Failed to parse access_aud_list', { raw: audListRaw });
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

  // Direct service auth validation — checked FIRST because CF Access may
  // inject a JWT for service tokens whose audience doesn't match our app's
  // access_aud, AND CF Access strips CF-Access-Client-Secret from forwarded
  // requests. Uses custom X-Service-Auth header to bypass both issues.
  // Only active when SERVICE_AUTH_SECRET is set as a worker secret.
  if (env?.SERVICE_AUTH_SECRET) {
    const serviceAuth = request.headers.get('X-Service-Auth');
    if (serviceAuth) {
      // Constant-time comparison to prevent timing attacks
      const expected = new TextEncoder().encode(env.SERVICE_AUTH_SECRET);
      const actual = new TextEncoder().encode(serviceAuth);
      if (expected.byteLength !== actual.byteLength) {
        // Length mismatch — fall through to normal rejection
        return { email: '', authenticated: false};
      }
      const match = await crypto.subtle.timingSafeEqual(expected, actual);
      if (match) {
        // Use SERVICE_TOKEN_EMAIL or fixed e2e identity.
        // CF Access may strip CF-Access-Client-Id, so we don't rely on it here.
        // Role is set to 'admin' — the caller proved they have the worker secret,
        // so they're trusted without a KV allowlist lookup.
        const serviceEmail = env.SERVICE_TOKEN_EMAIL || 'e2e-service@codeflare.local';
        return { email: normalizeEmail(serviceEmail), authenticated: true, role: 'admin'};
      }
      // timingSafeEqual failed
      return { email: '', authenticated: false};
    } else {
      // SERVICE_AUTH_SECRET is set but header not sent — note this but continue to other auth methods
      // (caller might be using JWT auth instead)
    }
  } else {
    // SERVICE_AUTH_SECRET not in env — note for diagnostics but continue to other auth methods
  }

  // JWT verification: if token present and auth is configured, verify it
  if (jwtToken && authConfigured && cachedAuthDomain) {
    for (const expectedAud of accessAudList) {
      const verifiedEmail = await verifyAccessJWT(jwtToken, cachedAuthDomain, expectedAud);
      if (verifiedEmail) {
        return { email: normalizeEmail(verifiedEmail), authenticated: true };
      }
    }

    // JWT verification failed for all expected audiences
    return { email: '', authenticated: false };
  }

  // Post-setup (auth configured) but NO JWT: reject even if header is present (FIX-1).
  // This prevents header spoofing when Cloudflare Access is configured.
  if (authConfigured && !jwtToken) {
    return { email: '', authenticated: false };
  }

  // Pre-setup fallback: trust email header (allows setup wizard to work)
  const email = request.headers.get('cf-access-authenticated-user-email');

  if (email) {
    return { email: normalizeEmail(email), authenticated: true };
  }

  // Service token authentication (fallback)
  // When CF Access validates a service token, it passes through cf-access-client-id header.
  // Only used if no JWT was available (JWT takes precedence).
  const serviceTokenClientId = request.headers.get('cf-access-client-id');

  if (serviceTokenClientId) {
    // Service token was validated by CF Access
    // Use SERVICE_TOKEN_EMAIL env var or fall back to a default based on client ID
    const serviceEmail = env?.SERVICE_TOKEN_EMAIL || `service-${serviceTokenClientId.split('.')[0]}@codeflare.local`;
    return { email: normalizeEmail(serviceEmail), authenticated: true };
  }

  return { email: '', authenticated: false };
}

/** Strip trailing hyphens without regex (avoids CodeQL ReDoS false positive on /-+$/). */
function trimTrailingHyphens(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '-') end--;
  return end === s.length ? s : s.substring(0, end);
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

  // Strip trailing hyphens AFTER truncation — substring can reintroduce them.
  // Also strip from the final result — long workerName can make prefix end with "-" and truncated be empty.
  // Uses iterative trim instead of regex to satisfy CodeQL ReDoS analysis.
  const truncated = trimTrailingHyphens(sanitized.substring(0, Math.max(0, maxSanitizedLength)));
  return trimTrailingHyphens(`${prefix}${truncated}`);
}

/**
 * Resolve a user entry from KV, returning role and access tier information.
 * Defaults missing role to 'user' for backward compatibility with
 * entries created before role support was added.
 */
export async function resolveUserFromKV(
  kv: KVNamespace,
  email: string
): Promise<{ addedBy: string; addedAt: string; role: UserRole; accessTier?: AccessTier } | null> {
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
  const obj = parsed as { addedBy?: unknown; addedAt?: unknown; role?: unknown; accessTier?: unknown };
  const rawTier = typeof obj.accessTier === 'string' ? obj.accessTier : undefined;
  return {
    addedBy: typeof obj.addedBy === 'string' ? obj.addedBy : 'unknown',
    addedAt: typeof obj.addedAt === 'string' ? obj.addedAt : '',
    role: obj.role === 'admin' ? 'admin' : 'user',
    accessTier: rawTier && VALID_ACCESS_TIERS.has(rawTier) ? (rawTier as AccessTier) : undefined,
  };
}

/**
 * Resolve an existing user from KV, or auto-provision a new one in SaaS mode.
 * New users are always created with 'pending' tier (requires admin approval).
 *
 * Throws ForbiddenError when the user is not in KV and SaaS mode is off.
 */
export async function resolveOrProvisionUser(
  kv: KVNamespace,
  email: string,
  env: Env
): Promise<{ role: UserRole; accessTier: AccessTier }> {
  const normalizedEmail = normalizeEmail(email);
  const kvEntry = await resolveUserFromKV(kv, normalizedEmail);

  if (kvEntry) {
    return { role: kvEntry.role, accessTier: kvEntry.accessTier ?? 'advanced' };
  }

  if (isSaasModeActive(env.SAAS_MODE)) {
    // Note: concurrent first-login requests may both reach this point and write
    // identical records. This is benign — both produce the same {role:'user',
    // accessTier:'pending'} entry. KV eventual consistency prevents true atomicity.
    await kv.put(`user:${normalizedEmail}`, JSON.stringify({
      addedBy: 'jit',
      addedAt: new Date().toISOString(),
      role: 'user',
      accessTier: 'pending',
    }));

    return { role: 'user', accessTier: 'pending' };
  }

  throw new ForbiddenError('User not in allowlist');
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
  // Service auth users already have a role — skip KV allowlist lookup
  if (rawUser.role) {
    const bucketName = getBucketName(normalizedEmail, env.CLOUDFLARE_WORKER_NAME);
    return { user: { ...rawUser, email: normalizedEmail }, bucketName };
  }

  // SaaS mode: use resolveOrProvisionUser for JIT provisioning + accessTier
  if (isSaasModeActive(env.SAAS_MODE)) {
    const { role, accessTier } = await resolveOrProvisionUser(env.KV, normalizedEmail, env);
    const bucketName = getBucketName(normalizedEmail, env.CLOUDFLARE_WORKER_NAME);
    return { user: { ...rawUser, email: normalizedEmail, role, accessTier }, bucketName };
  }

  // Non-SaaS mode: existing allowlist behavior
  const kvEntry = await resolveUserFromKV(env.KV, normalizedEmail);
  if (!kvEntry) {
    throw new ForbiddenError('User not in allowlist');
  }
  const { role, accessTier } = kvEntry;
  const bucketName = getBucketName(normalizedEmail, env.CLOUDFLARE_WORKER_NAME);
  return { user: { ...rawUser, email: normalizedEmail, role, accessTier }, bucketName };
}
