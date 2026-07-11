/**
 * Browser IDE route-boundary parsing (REQ-IDE-001, REQ-IDE-002).
 *
 * `validateVscodeRoute` parses a `/api/vscode/:sessionId/...` URL and is
 * called from `src/index.ts` BEFORE the Hono router so the VS Code server
 * WebSocket protocol passes through (Hono cannot handle upgrades) and static
 * asset paths reach OpenVSCode instead of being rejected as unmatched.
 *
 * Session-keyed ONLY. Unlike the Vault (REQ-VAULT-021, which serves under a
 * bucket-stable token so one notes store is shared across a user's sessions),
 * the IDE keys on the sessionId in the URL: it is the sole container selector,
 * which is what gives each session an isolated editor (distinct base-path,
 * service-worker scope, and container). There is deliberately no bucket-token
 * branch and no routing cookie here.
 */
import { SESSION_ID_PATTERN } from '../lib/constants';

export interface VscodeRouteResult {
  isVscodeRoute: boolean;
  sessionId?: string;
  remainingPath?: string;
  isWebSocket?: boolean;
  errorResponse?: Response;
}

/**
 * Parse a `/api/vscode/:sessionId/...` URL. A bare `/api/vscode/<sid>` with no
 * trailing slash is not a route (OpenVSCode needs a clean path). A first
 * segment that is not a valid session id returns a 400 errorResponse the
 * caller returns verbatim.
 */
export function validateVscodeRoute(request: Request): VscodeRouteResult {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/vscode\/([^/]+)(\/.*)$/);

  if (!match) {
    return { isVscodeRoute: false };
  }

  const firstSegment = match[1];
  const remainingPath = match[2];
  const upgradeHeader = request.headers.get('Upgrade');
  const isWebSocket = upgradeHeader?.toLowerCase() === 'websocket';

  if (!SESSION_ID_PATTERN.test(firstSegment)) {
    return {
      isVscodeRoute: true,
      errorResponse: new Response(
        JSON.stringify({ error: 'Invalid session ID format', code: 'INVALID_SESSION' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    };
  }

  return { isVscodeRoute: true, sessionId: firstSegment, remainingPath, isWebSocket };
}
