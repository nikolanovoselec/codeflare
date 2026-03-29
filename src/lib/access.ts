import type { AccessTier, AccessUser, BillingStatus, Env, SubscriptionTier, UserRole } from '../types';
import { verifyAccessJWT } from './jwt';
import { verifySessionJWT } from './session-jwt';
import { AuthError, ForbiddenError } from './error-types';
import { createLogger } from './logger';
import { isSaasModeActive } from './onboarding';
import { sendWelcomeEmail } from './email';
import { parseUserRecord } from './user-record';
import { SETUP_KEYS } from './kv-keys';

const logger = createLogger('access');

// Module-level cache for auth config (avoids KV reads on every request)
const AUTH_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedAuthDomain: string | null | undefined = undefined;
let cachedAccessAud: string | null | undefined = undefined;
let cachedAccessAudList: string[] | null | undefined = undefined;
let authConfigCachedAt = 0;
// CF-005: Tracks whether KV auth config has been fetched at least once.
let authConfigFetched = false;
// CF-002: Promise dedup — prevents concurrent cold requests from issuing redundant KV reads.
let pendingAuthConfigFetch: Promise<void> | null = null;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const VALID_ACCESS_TIERS = new Set<string>(['pending', 'standard', 'advanced', 'blocked']);
const VALID_SUBSCRIPTION_TIERS = new Set<string>([
  'blocked', 'pending', 'free', 'trial', 'standard', 'advanced', 'max', 'unlimited',
]);

/**
 * Reset cached auth config. Call when setup completes or config changes.
 */
export function resetAuthConfigCache(): void {
  cachedAuthDomain = undefined;
  cachedAccessAud = undefined;
  cachedAccessAudList = undefined;
  authConfigCachedAt = 0;
  authConfigFetched = false;
  pendingAuthConfigFetch = null;
}

export function getCookieValue(cookieHeader: string | null, key: string): string | null {
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
 * Extract user identity from the request.
 *
 * **Return value**: Returns `{ email, authenticated }` — the minimal identity
 * established by the auth provider (CF Access JWT, SaaS OIDC session, or
 * service token). The only exception is service-token auth, which also sets
 * `role: 'admin'` because the caller proved possession of the worker secret.
 *
 * For OIDC/SaaS and CF Access paths, the returned object does **not** include
 * `role`, `accessTier`, `subscriptionTier`, or billing fields. Those are
 * populated later by {@link authenticateRequest}, which calls
 * {@link resolveOrProvisionUser} (SaaS) or {@link resolveUserFromKV} (non-SaaS)
 * to hydrate the full {@link AccessUser} profile from KV.
 *
 * This partial return is intentional — it separates identity verification
 * (proving who the caller is) from authorization (determining what the caller
 * can do). Callers that only need to know "is there a valid session?" can use
 * this function directly; callers that need role/tier information must go
 * through `authenticateRequest`.
 *
 * Authentication methods (checked in order):
 *
 * 1. Service token (X-Service-Auth header) — for API/CLI/E2E clients.
 *    Constant-time comparison against SERVICE_AUTH_SECRET. Returns admin role.
 *
 * 2. SaaS mode + GitHub OIDC (codeflare_session cookie) — when SAAS_MODE=active
 *    and OAUTH_CLIENT_ID is set. HMAC-SHA256 JWT signed by OAUTH_JWT_SECRET.
 *    Replaces CF Access for SaaS deployments.
 *
 * 3. CF Access JWT (cf-access-jwt-assertion header or CF_Authorization cookie) —
 *    default/non-SaaS mode. Verified via JWKS from the CF Access auth domain.
 *
 * 4. Pre-setup fallback (cf-access-authenticated-user-email header) —
 *    trusted only before setup is complete (auth_domain not yet configured).
 *
 */
export async function getUserFromRequest(request: Request, env?: Env): Promise<AccessUser> {
  // Extract CF Access JWT early — evaluated after service token and SaaS OIDC checks
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
    pendingAuthConfigFetch = null; // HIGH-4: ensure stale promise doesn't block re-fetch
  }
  // CF-002: Deduplicate concurrent cold-start KV reads via Promise sentinel.
  // Pattern mirrors pendingJWKSFetch in jwt.ts.
  if (env?.KV && cachedAuthDomain === undefined) {
    if (!pendingAuthConfigFetch) {
      pendingAuthConfigFetch = (async () => {
        cachedAuthDomain = await env.KV.get(SETUP_KEYS.AUTH_DOMAIN);
        const audListRaw = await env.KV.get(SETUP_KEYS.ACCESS_AUD_LIST);
        if (audListRaw) {
          try {
            const parsed = JSON.parse(audListRaw);
            if (Array.isArray(parsed) && parsed.every((value: unknown) => typeof value === 'string')) {
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
        cachedAccessAud = await env.KV.get(SETUP_KEYS.ACCESS_AUD);
        authConfigCachedAt = Date.now();
        if (cachedAuthDomain && (cachedAccessAud || (cachedAccessAudList && cachedAccessAudList.length > 0))) {
          authConfigFetched = true;
        }
      })().finally(() => { pendingAuthConfigFetch = null; });
    }
    await pendingAuthConfigFetch;
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

  // SaaS mode + GitHub OIDC: verify codeflare_session cookie (HMAC JWT)
  // This replaces CF Access JWT verification when OAUTH_CLIENT_ID is configured.
  if (env && isSaasModeActive(env.SAAS_MODE) && env.OAUTH_CLIENT_ID) {
    if (!env.OAUTH_JWT_SECRET) {
      throw new AuthError('SaaS mode active but OAUTH_JWT_SECRET not configured');
    }
    const sessionToken = getCookieValue(request.headers.get('Cookie'), 'codeflare_session');
    if (!sessionToken) {
      return { email: '', authenticated: false };
    }
    const payload = await verifySessionJWT(sessionToken, env.OAUTH_JWT_SECRET);
    if (!payload) {
      return { email: '', authenticated: false };
    }
    return { email: normalizeEmail(payload.email), authenticated: true };
  }

  // CF Access JWT verification (non-SaaS mode or SaaS without GitHub OIDC)
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

  // Pre-setup fallback: trust email header (allows setup wizard to work).
  // CF-005: Only activate when auth is genuinely not configured (no domain + aud in KV).
  // Once auth HAS been configured and fetched, this path is permanently disabled for
  // the isolate's lifetime. Prevents KV transient errors from degrading to header trust.
  if (!authConfigured && !authConfigFetched) {
    const email = request.headers.get('cf-access-authenticated-user-email');
    if (email) {
      logger.warn('Pre-setup auth fallback activated — trusting header', { email: normalizeEmail(email), path: request.url });
      return { email: normalizeEmail(email), authenticated: true };
    }
  }

  // Service token authentication (fallback — non-SaaS only)
  // When CF Access validates a service token, it passes through cf-access-client-id header.
  // In SaaS mode there is no CF Access edge, so this header is attacker-controlled.
  const serviceTokenClientId = !isSaasModeActive(env?.SAAS_MODE)
    ? request.headers.get('cf-access-client-id')
    : null;

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
): Promise<{ addedBy: string; addedAt: string; role: UserRole; accessTier?: AccessTier; subscriptionTier?: SubscriptionTier; subscribedMode?: 'default' | 'advanced'; billingStatus?: BillingStatus; billingPeriodEnd?: string } | null> {
  const normalizedEmail = normalizeEmail(email);
  const raw = await kv.get(`user:${normalizedEmail}`, 'json');
  // CF-010/CF-017: Use parseUserRecord for validated, typed parsing
  const record = parseUserRecord(raw);
  if (!record) return null;
  const rawTier = record.accessTier;
  const rawSubTier = record.subscriptionTier;
  const subscriptionTier = rawSubTier && VALID_SUBSCRIPTION_TIERS.has(rawSubTier)
    ? (rawSubTier as SubscriptionTier)
    : undefined;
  return {
    addedBy: record.addedBy,
    addedAt: record.addedAt,
    role: record.role === 'admin' ? 'admin' : 'user',
    accessTier: rawTier && VALID_ACCESS_TIERS.has(rawTier) ? (rawTier as AccessTier) : undefined,
    subscriptionTier,
    subscribedMode: record.subscribedMode === 'advanced' ? 'advanced' : 'default',
    billingStatus: record.billingStatus,
    billingPeriodEnd: record.billingPeriodEnd,
  };
}

/**
 * Resolve an existing user from KV, or auto-provision a new one in SaaS mode.
 * New users are created with 'pending' tier and can self-subscribe via /api/auth/subscribe.
 *
 * Throws ForbiddenError when the user is not in KV and SaaS mode is off.
 */
export async function resolveOrProvisionUser(
  kv: KVNamespace,
  email: string,
  env: Env
): Promise<{ role: UserRole; accessTier: AccessTier; subscriptionTier?: SubscriptionTier; subscribedMode?: 'default' | 'advanced'; billingStatus?: BillingStatus; billingPeriodEnd?: string }> {
  const normalizedEmail = normalizeEmail(email);
  const kvEntry = await resolveUserFromKV(kv, normalizedEmail);

  if (kvEntry) {
    return {
      role: kvEntry.role,
      accessTier: kvEntry.accessTier ?? 'advanced',
      subscriptionTier: kvEntry.subscriptionTier,
      subscribedMode: kvEntry.subscribedMode,
      billingStatus: kvEntry.billingStatus,
      billingPeriodEnd: kvEntry.billingPeriodEnd,
    };
  }

  if (isSaasModeActive(env.SAAS_MODE)) {
    // Note: concurrent first-login requests may both reach this point and write
    // identical records. This is benign — both produce the same {role:'user',
    // accessTier:'pending', subscriptionTier:'pending'} entry.
    await kv.put(`user:${normalizedEmail}`, JSON.stringify({
      addedBy: 'jit',
      addedAt: new Date().toISOString(),
      role: 'user',
      accessTier: 'pending',
      subscriptionTier: 'pending',
    }));

    // Fire-and-forget welcome email with dedup flag.
    // Concurrent first-login requests can race past the check, but the flag
    // narrows the window from "always doubles" to milliseconds of KV propagation.
    const welcomeFlag = `welcome-sent:${normalizedEmail}`;
    const alreadySent = await kv.get(welcomeFlag);
    if (!alreadySent) {
      await kv.put(welcomeFlag, '1', { expirationTtl: 86400 });
      const customDomain = await kv.get(SETUP_KEYS.CUSTOM_DOMAIN);
      const instanceUrl = customDomain ? `https://${customDomain}` : undefined;
      void sendWelcomeEmail({ userEmail: normalizedEmail, instanceUrl, env });
    }

    return { role: 'user', accessTier: 'pending', subscriptionTier: 'pending', subscribedMode: 'default' };
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
    const { role, accessTier, subscriptionTier, subscribedMode, billingStatus, billingPeriodEnd } = await resolveOrProvisionUser(env.KV, normalizedEmail, env);
    const bucketName = getBucketName(normalizedEmail, env.CLOUDFLARE_WORKER_NAME);
    return { user: { ...rawUser, email: normalizedEmail, role, accessTier, subscriptionTier, subscribedMode, billingStatus, billingPeriodEnd }, bucketName };
  }

  // Non-SaaS mode: existing allowlist behavior
  const kvEntry = await resolveUserFromKV(env.KV, normalizedEmail);
  if (!kvEntry) {
    throw new ForbiddenError('User not in allowlist');
  }
  const { role, accessTier, subscriptionTier, subscribedMode, billingStatus, billingPeriodEnd } = kvEntry;
  const bucketName = getBucketName(normalizedEmail, env.CLOUDFLARE_WORKER_NAME);
  return { user: { ...rawUser, email: normalizedEmail, role, accessTier, subscriptionTier, subscribedMode, billingStatus, billingPeriodEnd }, bucketName };
}
