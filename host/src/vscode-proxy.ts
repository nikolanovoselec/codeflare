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
import { WebSocketServer } from 'ws';

/** Default lazy-start trigger path the OpenVSCode supervisor waits on. */
export const OPENVSCODE_REQUEST_TRIGGER = '/tmp/openvscode-requested';

// VS Code's remote protocol uses messages around 256 KiB. The terminal's
// defensive 64 KiB cap therefore cannot be reused here: `ws` rejects an
// oversized message with close code 1009, causing an endless reconnect loop.
// Keep this bounded to the Cloudflare WebSocket message ceiling.
const OPENVSCODE_WS_MAX_PAYLOAD = 32 * 1024 * 1024;

/** Create the no-server WebSocket endpoint used by the OpenVSCode bridge. */
export function createVscodeWebSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload: OPENVSCODE_WS_MAX_PAYLOAD });
}

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

/** A response the host serves directly for the browser-IDE proxy surface. */
export interface VscodeHostResponse {
  status: number;
  contentType: string;
  body: string;
}

/**
 * REQ-IDE-003 (advanced-mode only): the OpenVSCode supervisor is armed only in
 * advanced session mode. `mode` is the container's `SESSION_MODE`. Fail-open
 * when it is unset/empty so behaviour is unchanged; block only a session that is
 * explicitly a non-advanced mode -- otherwise such a session would sit on the
 * auto-refreshing warming page forever (its supervisor never launches).
 */
export function vscodeModeAllowed(mode: string | undefined | null): boolean {
  return !mode || mode === 'advanced';
}

/**
 * The lazy-start warming page (REQ-IDE-003 AC2). The first `/api/vscode` request
 * triggers the supervisor, and the connect to `:13337` fails until OpenVSCode
 * binds (a few seconds). Rather than dumping raw JSON into a plain `_blank`
 * browser tab, serve a tiny HTML page that auto-refreshes so the tab lands on
 * the real editor once it is up. 503 = not-ready; browsers still render the body
 * and honour the meta refresh.
 */
export function vscodeWarmingResponse(): VscodeHostResponse {
  return {
    status: 503,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><meta name="color-scheme" content="dark light"><title>Starting editor</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p>Starting the editor&hellip;</p></body></html>',
  };
}

/**
 * REQ-IDE-003: the IDE is an advanced-mode affordance. A non-advanced session
 * (e.g. a hand-typed `/api/vscode` URL) gets a clear, NON-refreshing page rather
 * than an endless warming loop for a supervisor that will never arm.
 */
export function vscodeDisabledResponse(): VscodeHostResponse {
  return {
    status: 409,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark light"><title>Editor unavailable</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p>The browser editor is available in advanced sessions only.</p></body></html>',
  };
}
