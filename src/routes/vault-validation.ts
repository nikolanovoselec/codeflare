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

export interface VaultRouteResult {
  isVaultRoute: boolean;
  sessionId?: string;
  remainingPath?: string;
  isWebSocket?: boolean;
  errorResponse?: Response;
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
