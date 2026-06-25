/**
 * Vault route-boundary parsing (CF-024a extraction from vault.ts).
 *
 * `validateVaultRoute` parses a `/api/vault/:sessionId/...` URL and is
 * called from `src/index.ts` BEFORE the Hono router so WebSocket upgrade
 * requests can pass through. Behaviour is identical to the previous
 * inline form in vault.ts; vault.ts re-exports it so existing importers
 * keep their `from '../routes/vault'` paths working unchanged.
 */
import { SESSION_ID_PATTERN } from '../lib/constants';
import { VAULT_BUCKET_TOKEN_PATTERN } from '../lib/vault-bucket-token';

export interface VaultRouteResult {
  isVaultRoute: boolean;
  /** Set for the legacy/session-keyed path `/api/vault/<sid>/...` (entry + /status). */
  sessionId?: string;
  /**
   * Set for the bucket-stable SB-serving path `/api/vault/b/<token>/...` (REQ-VAULT-021).
   * The session id for these requests is carried in the `cf_vault_sid` cookie, never the
   * URL, so `location.href` (and thus the SilverBullet IndexedDB names) stays bucket-stable.
   */
  bucketToken?: string;
  remainingPath?: string;
  isWebSocket?: boolean;
  errorResponse?: Response;
}

function invalid(code: string, message: string): VaultRouteResult {
  return {
    isVaultRoute: true,
    errorResponse: new Response(
      JSON.stringify({ error: message, code }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ),
  };
}

/**
 * Parse a `/api/vault/:sessionId/...` URL. Used both for HTTP requests
 * and WebSocket upgrades - SilverBullet uses WS for live-edit sync.
 *
 * Returns isVaultRoute=true for any path under `/api/vault/<id>/`. A
 * bare `/api/vault/<id>` (no trailing slash) is rejected: requests to a
 * directory without a trailing slash must redirect or the SilverBullet
 * client emits broken relative-URL fetches. The Hono status route
 * `/api/vault/:sid/status` does NOT count as a vault proxy path - the
 * caller (src/index.ts) checks for that pattern before calling us.
 */
export function validateVaultRoute(request: Request): VaultRouteResult {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/vault\/([^/]+)(\/.*)$/);

  if (!match) {
    return { isVaultRoute: false };
  }

  const firstSegment = match[1];
  const remainingPath = match[2];
  const upgradeHeader = request.headers.get('Upgrade');
  const isWebSocket = upgradeHeader?.toLowerCase() === 'websocket';

  // Bucket-stable SB-serving path: `/api/vault/<token>/...` (REQ-VAULT-021). The first
  // segment is the opaque per-bucket token (32 hex), distinct from a 24-hex session id.
  // The session id is NOT in the URL — it rides in the `cf_vault_sid` cookie — so the
  // served URL (and therefore SilverBullet's IndexedDB names) stays stable across
  // sessions. SB's own boot/base-href/SW-scope machinery builds `/api/vault/<token>/`
  // unchanged; only container routing reads the real session id from the cookie.
  if (VAULT_BUCKET_TOKEN_PATTERN.test(firstSegment)) {
    return { isVaultRoute: true, bucketToken: firstSegment, remainingPath, isWebSocket };
  }

  // Session-keyed path: `/api/vault/<sid>/...` (the open/prewarm entry and /status).
  if (!SESSION_ID_PATTERN.test(firstSegment)) {
    return invalid('INVALID_SESSION', 'Invalid session ID format');
  }

  return { isVaultRoute: true, sessionId: firstSegment, remainingPath, isWebSocket };
}
