/**
 * Browser IDE proxy path helpers (REQ-IDE-001, REQ-IDE-003).
 *
 * The in-container terminal server proxies `/api/vscode/*` requests to the
 * localhost OpenVSCode Server. Unlike the vault (which strips its `/vault`
 * prefix before forwarding), the IDE forwards the path UNCHANGED because
 * OpenVSCode runs with `--server-base-path=/api/vscode/<sessionId>` and expects
 * to receive its own path. These pure helpers live here (not in server.ts,
 * which boots a listening server on import) so they are unit-testable -- the
 * same reason stripVaultPrefix was extracted into vault-proxy.ts.
 */
import fs from 'node:fs';

/** Default lazy-start trigger path the OpenVSCode supervisor waits on. */
export const OPENVSCODE_REQUEST_TRIGGER = '/tmp/openvscode-requested';

/** True for the base-path-native IDE proxy surface `/api/vscode` and below. */
export function isVscodePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === '/api/vscode' || pathname.startsWith('/api/vscode/');
}

/**
 * The upstream path OpenVSCode should receive. The IDE forwards the path
 * UNCHANGED (no prefix strip): OpenVSCode's --server-base-path is
 * `/api/vscode/<sessionId>`, so it expects the full path. A missing pathname
 * falls back to `/api/vscode/`.
 *
 *   /api/vscode              -> /api/vscode
 *   /api/vscode/<sid>/       -> /api/vscode/<sid>/
 *   /api/vscode/<sid>/x/y    -> /api/vscode/<sid>/x/y
 */
export function vscodeUpstreamPath(pathname: string | null | undefined): string {
  return pathname ?? '/api/vscode/';
}

/**
 * REQ-IDE-003 AC2: lazy-start trigger. The OpenVSCode supervisor waits for this
 * file before launching the server; the host writes it (idempotently) on the
 * first `/api/vscode` request so sessions that never open the IDE never pay for
 * it. Returns true when it created the file, false if it already existed or the
 * write failed -- best-effort, because a trigger-write failure must never break
 * the proxy request (the supervisor also re-polls).
 */
export function requestOpenvscodeStart(triggerPath: string = OPENVSCODE_REQUEST_TRIGGER): boolean {
  try {
    if (fs.existsSync(triggerPath)) return false;
    fs.writeFileSync(triggerPath, '1');
    return true;
  } catch {
    return false;
  }
}
