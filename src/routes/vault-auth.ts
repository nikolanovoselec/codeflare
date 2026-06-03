/**
 * Vault auth-chain guards (CF-024a extraction from vault.ts; originally
 * the CF-002 inline-to-guard split).
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
import type { Env } from '../types';
import { authenticateRequest } from '../lib/access';
import { isSaasModeActive } from '../lib/onboarding';
import { isActiveUser } from '../lib/access-tier';
import { getEffectiveTier } from '../lib/subscription';
import { createLogger } from '../lib/logger';
import { isAllowedOrigin } from '../lib/cors-cache';
import { AuthError, ForbiddenError } from '../lib/error-types';
import { maybeSynthesizeCsrfHeader, inferOriginValidated } from './vault-html';

const logger = createLogger('vault');

/** Origin allowlist guard. Mirrors the inline CORS check. */
export async function checkVaultOrigin(
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
export async function authenticateVaultRequest(
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
export function assertActiveTier(
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
