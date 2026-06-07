import type { AccessTier, AccessUser, BillingStatus, Env, SubscriptionTier, UserRole } from '../types';
import { verifyAccessJWT } from './jwt';
import { verifySessionJWT, SESSION_JWT_AUD } from './session-jwt';
import { AuthError, ForbiddenError } from './error-types';
import { createLogger } from './logger';
import { isSaasModeActive } from './onboarding';
import { isEnterpriseMode } from './subscription';
import { sendWelcomeEmail } from './email';
import { parseUserRecord } from './user-record';
import { SETUP_KEYS } from './kv-keys';

const logger = createLogger('access');

// Module-level cache for auth config (avoids KV reads on every request)
const AUTH_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// CF-149: pre-setup (negative/null) auth config is the spoofable-email trust
// window. Expire it after 30s instead of 5min so a freshly-configured
// instance stops trusting cf-access-authenticated-user-email much sooner.
const AUTH_CONFIG_NULL_TTL_MS = 30 * 1000; // 30 seconds
let cachedAuthDomain: string | null | undefined = undefined;
let cachedAccessAud: string | null | undefined = undefined;
let cachedAccessAudList: string[] | null | undefined = undefined;
let authConfigCachedAt = 0;
// CF-005: Tracks whether KV auth config has been fetched at least once.
let authConfigFetched = false;
// CF-002: Promise dedup - prevents concurrent cold requests from issuing redundant KV reads.
let pendingAuthConfigFetch: Promise<void> | null = null;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// CF-019: vault CSRF token (defense-in-depth). The cookie is issued on the
// vault GET path (see src/routes/vault.ts) and compared header===cookie in
// authenticateRequest. NOTE: for an origin-validated request the Worker mints
// the X-Vault-Csrf header from the cookie (vault-html.ts), so this is NOT an
// independent second factor that proves client token knowledge - the Origin
// allowlist (checkVaultOrigin) remains the primary CSRF defense. The token
// layers on top and leaves room for a future client-echoed double-submit.
export const CSRF_COOKIE_NAME = 'codeflare_vault_csrf';
export const CSRF_HEADER_NAME = 'X-Vault-Csrf';

/** Constant-time string equality for the double-submit token compare. */
async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
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
 * Extract user identity from the request.
 *
 * **Return value**: Returns `{ email, authenticated }` - the minimal identity
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
 * This partial return is intentional - it separates identity verification
 * (proving who the caller is) from authorization (determining what the caller
 * can do). Callers that only need to know "is there a valid session?" can use
 * this function directly; callers that need role/tier information must go
 * through `authenticateRequest`.
 *
 * Authentication methods (checked in order):
 *
 * 1. Service token (X-Service-Auth header) - for API/CLI/E2E clients.
 *    Constant-time comparison against SERVICE_AUTH_SECRET. Returns admin role.
 *
 * 2. SaaS mode + GitHub OIDC (codeflare_session cookie) - when SAAS_MODE=active
 *    and OAUTH_CLIENT_ID is set. HMAC-SHA256 JWT signed by OAUTH_JWT_SECRET.
 *    Replaces CF Access for SaaS deployments.
 *
 * 3. CF Access JWT (cf-access-jwt-assertion header or CF_Authorization cookie) -
 *    default/non-SaaS mode. Verified via JWKS from the CF Access auth domain.
 *
 * 4. Pre-setup fallback (cf-access-authenticated-user-email header) -
 *    trusted only before setup is complete (auth_domain not yet configured).
 *
 */
/** Extract the CF Access JWT from the assertion header or CF_Authorization cookie. */
function extractAccessJwt(request: Request): string | null {
  const jwtAssertionHeader = request.headers.get('cf-access-jwt-assertion');
  const jwtCookie = getCookieValue(request.headers.get('Cookie'), 'CF_Authorization');
  return jwtAssertionHeader || jwtCookie;
}

/** Auth config derived from the module-level cache after {@link loadAuthConfig}. */
interface ResolvedAuthConfig {
  accessAudList: string[];
  authConfigured: boolean;
  authDomain: string | null | undefined;
}

/**
 * Load auth config from KV REGARDLESS of JWT presence (FIX-1) and return the
 * derived audience list + configured flag. Mutates the module-level cache.
 *
 * This determines whether we're in pre-setup or post-setup state.
 * Invalidate stale cache after TTL (FIX-9).
 * CF-149: when the cached config is the negative/null (pre-setup) state, use
 * the shorter NULL TTL so the header-trust window shrinks from 5min to 30s.
 * A populated config (cachedAuthDomain is a non-empty string) keeps the 5min
 * TTL. cachedAuthDomain === undefined means "not yet fetched" and is handled
 * by the cold-fetch branch below, not here.
 */
async function loadAuthConfig(env?: Env): Promise<ResolvedAuthConfig> {
  const configIsPopulated = !!cachedAuthDomain;
  const effectiveTtlMs = configIsPopulated ? AUTH_CONFIG_CACHE_TTL_MS : AUTH_CONFIG_NULL_TTL_MS;
  if (authConfigCachedAt > 0 && Date.now() - authConfigCachedAt > effectiveTtlMs) {
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
  return { accessAudList, authConfigured, authDomain: cachedAuthDomain };
}

/**
 * Direct service auth validation via the X-Service-Auth header.
 *
 * Checked FIRST because CF Access may inject a JWT for service tokens whose
 * audience doesn't match our app's access_aud, AND CF Access strips
 * CF-Access-Client-Secret from forwarded requests. Uses custom X-Service-Auth
 * header to bypass both issues. Only active when SERVICE_AUTH_SECRET is set as
 * a worker secret.
 *
 * Returns an {@link AccessUser} when the header is present (whether it matches
 * or not - a present-but-wrong header is a hard rejection), or `null` to fall
 * through to other auth methods when the secret is unset or the header is absent.
 */
async function validateServiceAuthHeader(request: Request, env?: Env): Promise<AccessUser | null> {
  if (!env?.SERVICE_AUTH_SECRET) {
    // SERVICE_AUTH_SECRET not in env - note for diagnostics but continue to other auth methods
    return null;
  }
  const serviceAuth = request.headers.get('X-Service-Auth');
  if (!serviceAuth) {
    // SERVICE_AUTH_SECRET is set but header not sent - note this but continue to other auth methods
    // (caller might be using JWT auth instead)
    return null;
  }
  // Constant-time comparison to prevent timing attacks
  const expected = new TextEncoder().encode(env.SERVICE_AUTH_SECRET);
  const actual = new TextEncoder().encode(serviceAuth);
  if (expected.byteLength !== actual.byteLength) {
    // Length mismatch - fall through to normal rejection
    return { email: '', authenticated: false};
  }
  const match = await crypto.subtle.timingSafeEqual(expected, actual);
  if (match) {
    // Use SERVICE_TOKEN_EMAIL or fixed e2e identity.
    // CF Access may strip CF-Access-Client-Id, so we don't rely on it here.
    // Role is set to 'admin' - the caller proved they have the worker secret,
    // so they're trusted without a KV allowlist lookup.
    // SAST-false-positive: 'e2e-service@codeflare.local' is a test fixture,
    // not a hardcoded secret. The .local TLD is RFC 6762 reserved and
    // obviously non-production; the actual auth gate is the worker secret.
    const serviceEmail = env.SERVICE_TOKEN_EMAIL || 'e2e-service@codeflare.local';
    return { email: normalizeEmail(serviceEmail), authenticated: true, role: 'admin'};
  }
  // timingSafeEqual failed
  return { email: '', authenticated: false};
}

/**
 * SaaS mode + GitHub OIDC: verify codeflare_session cookie (HMAC JWT).
 * This replaces CF Access JWT verification when OAUTH_CLIENT_ID is configured.
 *
 * Returns an {@link AccessUser} when SaaS OIDC is the active auth path (the
 * caller must NOT fall through to CF Access in that case), or `null` when SaaS
 * OIDC is not configured. Throws when SaaS mode is active but the JWT secret is
 * missing.
 */
async function validateSaasOidc(request: Request, env?: Env): Promise<AccessUser | null> {
  if (!(env && isSaasModeActive(env.SAAS_MODE) && env.OAUTH_CLIENT_ID)) {
    return null;
  }
  if (!env.OAUTH_JWT_SECRET) {
    throw new AuthError('SaaS mode active but OAUTH_JWT_SECRET not configured');
  }
  const sessionToken = getCookieValue(request.headers.get('Cookie'), 'codeflare_session');
  if (!sessionToken) {
    return { email: '', authenticated: false };
  }
  const payload = await verifySessionJWT(sessionToken, env.OAUTH_JWT_SECRET, SESSION_JWT_AUD);
  if (!payload) {
    return { email: '', authenticated: false };
  }
  return { email: normalizeEmail(payload.email), authenticated: true };
}

/**
 * CF Access JWT verification (non-SaaS mode or SaaS without GitHub OIDC).
 *
 * Returns an {@link AccessUser} when a JWT is present and auth is configured
 * (whether verification succeeds or fails - a present-but-invalid JWT is a hard
 * rejection), or `null` to fall through when no JWT/config is available.
 */
async function verifyCfAccessJwt(
  jwtToken: string | null,
  config: ResolvedAuthConfig,
): Promise<AccessUser | null> {
  if (!(jwtToken && config.authConfigured && config.authDomain)) {
    return null;
  }
  for (const expectedAud of config.accessAudList) {
    const verifiedEmail = await verifyAccessJWT(jwtToken, config.authDomain, expectedAud);
    if (verifiedEmail) {
      return { email: normalizeEmail(verifiedEmail), authenticated: true };
    }
  }
  // JWT verification failed for all expected audiences
  return { email: '', authenticated: false };
}

/**
 * Pre-setup fallback: trust email header (allows setup wizard to work).
 *
 * CF-005: Only activate when auth is genuinely not configured (no domain + aud
 * in KV). Once auth HAS been configured and fetched, this path is permanently
 * disabled for the isolate's lifetime. Prevents KV transient errors from
 * degrading to header trust. Returns `null` when the fallback does not apply.
 */
function preSetupHeaderFallback(request: Request, config: ResolvedAuthConfig): AccessUser | null {
  if (config.authConfigured || authConfigFetched) {
    return null;
  }
  const email = request.headers.get('cf-access-authenticated-user-email');
  if (email) {
    logger.warn('Pre-setup auth fallback activated - trusting header', { email: normalizeEmail(email), path: request.url });
    return { email: normalizeEmail(email), authenticated: true };
  }
  return null;
}

export async function getUserFromRequest(request: Request, env?: Env): Promise<AccessUser> {
  // Extract CF Access JWT early - evaluated after service token and SaaS OIDC checks
  const jwtToken = extractAccessJwt(request);

  const config = await loadAuthConfig(env);

  const serviceAuthResult = await validateServiceAuthHeader(request, env);
  if (serviceAuthResult) return serviceAuthResult;

  const saasResult = await validateSaasOidc(request, env);
  if (saasResult) return saasResult;

  const cfAccessResult = await verifyCfAccessJwt(jwtToken, config);
  if (cfAccessResult) return cfAccessResult;

  // Post-setup (auth configured) but NO JWT: reject even if header is present (FIX-1).
  // This prevents header spoofing when Cloudflare Access is configured.
  if (config.authConfigured && !jwtToken) {
    return { email: '', authenticated: false };
  }

  const preSetupResult = preSetupHeaderFallback(request, config);
  if (preSetupResult) return preSetupResult;

  // Service token authentication (fallback - non-SaaS only)
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

  // Strip trailing hyphens AFTER truncation - substring can reintroduce them.
  // Also strip from the final result - long workerName can make prefix end with "-" and truncated be empty.
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
    // identical records. This is benign - both produce the same {role:'user',
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
 * Parse the configured codeflare Access groups from the setup value. Several
 * groups may be configured (comma- or newline-separated); a user in ANY of them
 * may use the deployment. A single value parses to a one-element list, so the
 * historical single-group configuration keeps working unchanged.
 */
export function parseAccessGroups(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,\n]/).map((g) => g.trim()).filter((g) => g.length > 0);
}

/**
 * Resolve which single configured Access group the user belongs to, by calling
 * the Access get-identity endpoint with the user's CF_Authorization token and
 * intersecting the user's group membership with `configuredGroups`. Returns the
 * matched group (the canonical configured spelling), or null if the user is in
 * none. Fails CLOSED (returns null) on any missing input or error — an
 * enterprise group gate must never admit, nor attribute, on uncertainty.
 *
 * A user is expected to map to AT MOST ONE codeflare group (the IdP enforces
 * single-membership). If more than one matches it is an IdP misconfiguration, so
 * the first by configured order is returned and a warning is logged.
 *
 * get-identity lives on the team auth domain
 * (`https://<team>.cloudflareaccess.com/cdn-cgi/access/get-identity`) and returns
 * the full identity including group membership. The exact shape of the groups
 * field can vary by IdP, so membership is matched defensively against a group's
 * name, id, or email (and against a plain string element).
 */
export async function resolveUserAccessGroup(
  accessToken: string | null,
  authDomain: string | null | undefined,
  configuredGroups: string[],
): Promise<string | null> {
  if (configuredGroups.length === 0) return null;
  if (!accessToken || !authDomain) {
    logger.warn('Enterprise group gate: missing token or auth domain — denying', {
      hasToken: !!accessToken,
      hasDomain: !!authDomain,
    });
    return null;
  }
  // Defense in depth: authDomain is sourced from setup KV (not the request), but
  // validate it matches the Cloudflare Access team-domain shape before interpolating
  // it into an outbound URL so a corrupted/misconfigured KV value cannot redirect the
  // get-identity call to an arbitrary host.
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(authDomain)) {
    logger.warn('Enterprise group gate: auth domain is not a *.cloudflareaccess.com host — denying');
    return null;
  }
  try {
    const response = await fetch(`https://${authDomain}/cdn-cgi/access/get-identity`, {
      method: 'GET',
      headers: { Cookie: `CF_Authorization=${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logger.warn('Enterprise group gate: get-identity returned non-OK — denying', { status: response.status });
      return null;
    }
    const identity = (await response.json()) as { groups?: unknown };
    const userGroups = Array.isArray(identity?.groups) ? identity.groups : [];
    const isMember = (configured: string): boolean =>
      userGroups.some((g) => {
        if (typeof g === 'string') return g === configured;
        if (g && typeof g === 'object') {
          const rec = g as { id?: unknown; name?: unknown; email?: unknown };
          return rec.id === configured || rec.name === configured || rec.email === configured;
        }
        return false;
      });
    const matched = configuredGroups.filter(isMember);
    if (matched.length === 0) return null;
    if (matched.length > 1) {
      logger.warn('Enterprise group gate: user matched multiple codeflare groups — IdP misconfiguration (a user should map to at most one); using the first by configured order', { matched });
    }
    return matched[0] ?? null;
  } catch (err) {
    logger.warn('Enterprise group gate: get-identity call failed — denying', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve the single Cloudflare Access group (among the configured codeflare
 * groups) that the current request's user belongs to, for per-user gateway
 * attribution (stamped as cf-aig-metadata.group). Enterprise-mode only; returns
 * null when not enterprise, when no groups are configured, or when the user
 * matches none. Issues at most one get-identity call — invoke it ONCE per session
 * start (see the container /start route), never per request. REQ-ENTERPRISE-004.
 */
export async function resolveSessionAccessGroup(request: Request, env: Env): Promise<string | null> {
  if (!isEnterpriseMode(env)) return null;
  const configuredGroups = parseAccessGroups(await env.KV.get(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP));
  if (configuredGroups.length === 0) return null;
  const { authDomain } = await loadAuthConfig(env);
  const accessToken = extractAccessJwt(request);
  return resolveUserAccessGroup(accessToken, authDomain, configuredGroups);
}

/**
 * Resolve an existing user from KV, or JIT-provision a new ENTERPRISE user.
 *
 * Enterprise deployments delegate identity to the customer's Cloudflare Access:
 * any Access-authenticated user entitled to the deployment is provisioned
 * automatically on first access as a custom `unlimited` user. Entitlement is the
 * presence of a valid Access JWT (verified upstream by {@link getUserFromRequest});
 * when `ENTERPRISE_ACCESS_GROUP` configures one or more groups at setup,
 * membership in ANY of them is additionally verified via
 * {@link resolveUserAccessGroup} and non-members are rejected with the standard
 * `ForbiddenError` (the same response a non-allowlisted user gets in non-SaaS mode).
 *
 * Existing records (a setup admin or a prior JIT user) are returned unchanged —
 * JIT never overwrites a role or downgrades an admin. No welcome email is sent
 * (the customer's own directory owns onboarding). REQ-ENTERPRISE-010.
 */
export async function resolveOrProvisionEnterpriseUser(
  kv: KVNamespace,
  email: string,
  accessToken: string | null,
  authDomain: string | null | undefined
): Promise<{ role: UserRole; accessTier: AccessTier; subscriptionTier?: SubscriptionTier; subscribedMode?: 'default' | 'advanced'; billingStatus?: BillingStatus; billingPeriodEnd?: string }> {
  const normalizedEmail = normalizeEmail(email);
  const kvEntry = await resolveUserFromKV(kv, normalizedEmail);

  if (kvEntry) {
    // Existing record (setup admin or prior enterprise-jit user) — return as-is,
    // never overwrite the role or downgrade an admin. Every enterprise user is
    // implicitly Pro/advanced (REQ-ENTERPRISE-008 AC3), so force subscribedMode to
    // 'advanced' here. Note: resolveUserFromKV already coerces a missing field to
    // 'default', so a `?? 'advanced'` fallback would be dead code — records that
    // predate the field (older JIT records, setup admins) come back as 'default'
    // and must still resolve advanced. This function only ever runs in enterprise
    // mode, so unconditionally returning 'advanced' is correct.
    return {
      role: kvEntry.role,
      accessTier: kvEntry.accessTier ?? 'advanced',
      subscriptionTier: kvEntry.subscriptionTier,
      subscribedMode: 'advanced',
      billingStatus: kvEntry.billingStatus,
      billingPeriodEnd: kvEntry.billingPeriodEnd,
    };
  }

  // Unknown user. Optional group gate against customer-managed Access groups: a
  // user in ANY configured group may use the deployment (REQ-ENTERPRISE-010).
  const configuredGroups = parseAccessGroups(await kv.get(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP));
  if (configuredGroups.length > 0) {
    const matchedGroup = await resolveUserAccessGroup(accessToken, authDomain, configuredGroups);
    if (!matchedGroup) {
      throw new ForbiddenError('User not in allowlist');
    }
  }

  // Provision a custom unlimited user. Concurrent first-logins write identical
  // records (benign). accessTier 'advanced' is the highest real access tier
  // ('unlimited' is a subscription tier, not an access tier). subscribedMode
  // 'advanced' is persisted so returning users read it back (REQ-ENTERPRISE-008
  // AC3) instead of degrading to 'default'. No welcome email.
  await kv.put(`user:${normalizedEmail}`, JSON.stringify({
    addedBy: 'enterprise-jit',
    addedAt: new Date().toISOString(),
    role: 'user',
    accessTier: 'advanced',
    subscriptionTier: 'unlimited',
    subscribedMode: 'advanced',
  }));

  return { role: 'user', accessTier: 'advanced', subscriptionTier: 'unlimited', subscribedMode: 'advanced' };
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
  // CSRF protection on state-changing methods. Two layers:
  //
  //   1. CF-019 vault CSRF token (defense-in-depth, NOT an independent factor).
  //      If the request carries both the CSRF cookie and the X-Vault-Csrf
  //      header they MUST match. For an origin-validated vault request the
  //      Worker itself mints the header from the cookie (vault-html.ts), so a
  //      match does not prove independent client knowledge - the Origin
  //      allowlist (checkVaultOrigin, applied before auth) is the real CSRF
  //      defense and a cross-site request is already 403'd there. A present-
  //      cookie/missing-header (or vice-versa) falls THROUGH to layer 2 rather
  //      than hard-rejecting, so non-vault routes and clients that predate the
  //      token (SilverBullet client.js, CLI) keep working. When both are
  //      present and EQUAL we skip layer 2.
  //   2. X-Requested-With requirement (defense-in-depth, unchanged).
  const method = request.method.toUpperCase();
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const csrfCookie = getCookieValue(request.headers.get('Cookie'), CSRF_COOKIE_NAME);
    const csrfHeader = request.headers.get(CSRF_HEADER_NAME);
    let doubleSubmitSatisfied = false;
    if (csrfCookie && csrfHeader) {
      if (!(await timingSafeEqualStrings(csrfCookie, csrfHeader))) {
        throw new ForbiddenError('CSRF token mismatch');
      }
      doubleSubmitSatisfied = true;
    }
    // Fall back to the legacy X-Requested-With gate only when the double-submit
    // token did not already establish CSRF safety.
    if (!doubleSubmitSatisfied && !request.headers.get('X-Requested-With')) {
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
  // Service auth users already have a role - skip KV allowlist lookup
  if (rawUser.role) {
    const bucketName = getBucketName(normalizedEmail, env.CLOUDFLARE_WORKER_NAME);
    return { user: { ...rawUser, email: normalizedEmail }, bucketName };
  }

  // Enterprise mode: JIT-provision the Access-authenticated user (optionally gated
  // by ENTERPRISE_ACCESS_GROUP). Gated entirely on ENTERPRISE_MODE=active, so the
  // SaaS and non-SaaS branches below are byte-identical when the flag is unset.
  // REQ-ENTERPRISE-010.
  if (isEnterpriseMode(env)) {
    const accessToken = extractAccessJwt(request);
    const { authDomain } = await loadAuthConfig(env);
    const { role, accessTier, subscriptionTier, subscribedMode, billingStatus, billingPeriodEnd } = await resolveOrProvisionEnterpriseUser(env.KV, normalizedEmail, accessToken, authDomain);
    const bucketName = getBucketName(normalizedEmail, env.CLOUDFLARE_WORKER_NAME);
    return { user: { ...rawUser, email: normalizedEmail, role, accessTier, subscriptionTier, subscribedMode, billingStatus, billingPeriodEnd }, bucketName };
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
