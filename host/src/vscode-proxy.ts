/**
 * Browser IDE proxy path helpers (REQ-IDE-001, REQ-IDE-003).
 *
 * The in-container terminal server proxies `/api/vscode/*` requests to the
 * loopback code-server runtime. The browser keeps the session-scoped public
 * location, while this trusted host strips only the exact current-session
 * prefix before forwarding root-relative HTTP and WebSocket paths. These pure
 * helpers live here so the security transformation is unit-testable.
 */
import fs from 'node:fs';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

/** Default lazy-start trigger path the Browser IDE supervisor waits on. */
export const OPENVSCODE_REQUEST_TRIGGER = '/tmp/openvscode-requested';
export const CODEFLARE_WORKSPACE_ROOT = '/home/user/workspace';
const WORKSPACE_SELECTOR_KEYS = Object.freeze(['folder', 'workspace', 'ew']);

// VS Code's remote protocol uses messages around 256 KiB. The terminal's
// defensive 64 KiB cap therefore cannot be reused here: `ws` rejects an
// oversized message with close code 1009, causing an endless reconnect loop.
// 32 MiB is a generous defensive upper bound, far above any real protocol
// message, so no legitimate frame is ever rejected.
const OPENVSCODE_WS_MAX_PAYLOAD = 32 * 1024 * 1024;
const OPENVSCODE_PREOPEN_MAX_BYTES = 8 * 1024 * 1024;
export const OPENVSCODE_WORKBENCH_MAX_BYTES = 2 * 1024 * 1024;
const WORKBENCH_CONFIGURATION_PATTERN = /<meta\s+id="vscode-workbench-web-configuration"\s+data-settings="([^"]*)"\s*\/?>/g;

/** Create the no-server WebSocket endpoint used by the Browser IDE bridge. */
export function createVscodeWebSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload: OPENVSCODE_WS_MAX_PAYLOAD });
}

interface QueuedVscodeFrame {
  readonly data: RawData;
  readonly isBinary: boolean;
}

function vscodeFrameByteLength(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, part) => total + part.byteLength, 0)
    : data.byteLength;
}

/**
 * Attach the downstream listener before the upstream handshake completes.
 * Early VS Code initialization frames are retained in order, while fixed
 * frame and byte caps prevent a stalled localhost server from exhausting
 * memory. Every client frame is meaningful IDE activity for idle detection.
 */
export function bridgeVscodeClientMessages(
  client: WebSocket,
  upstream: WebSocket,
  recordInput: () => void,
  maxQueuedFrames = 128,
  maxQueuedBytes = OPENVSCODE_PREOPEN_MAX_BYTES,
): void {
  let queuedFrames: readonly QueuedVscodeFrame[] = [];
  let queuedBytes = 0;
  let active = true;

  const cleanup = (): void => {
    if (!active) return;
    active = false;
    queuedFrames = [];
    queuedBytes = 0;
    client.off('message', onClientMessage);
    client.off('close', cleanup);
    client.off('error', cleanup);
    upstream.off('open', onUpstreamOpen);
    upstream.off('close', cleanup);
    upstream.off('error', cleanup);
  };

  const onClientMessage = (data: RawData, isBinary: boolean): void => {
    recordInput();
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING) {
      cleanup();
      return;
    }
    const frameBytes = vscodeFrameByteLength(data);
    if (
      queuedFrames.length >= maxQueuedFrames
      || queuedBytes + frameBytes > maxQueuedBytes
    ) {
      cleanup();
      client.close(1013, 'upstream-not-ready');
      upstream.close(1013, 'upstream-not-ready');
      return;
    }
    queuedFrames = [...queuedFrames, { data, isBinary }];
    queuedBytes += frameBytes;
  };

  const onUpstreamOpen = (): void => {
    upstream.off('open', onUpstreamOpen);
    const frames = queuedFrames;
    queuedFrames = [];
    queuedBytes = 0;
    for (const frame of frames) {
      if (upstream.readyState !== WebSocket.OPEN) break;
      upstream.send(frame.data, { binary: frame.isBinary });
    }
  };

  client.on('message', onClientMessage);
  client.on('close', cleanup);
  client.on('error', cleanup);
  upstream.on('open', onUpstreamOpen);
  upstream.on('close', cleanup);
  upstream.on('error', cleanup);
}

/** True for the public IDE proxy surface `/api/vscode` and below. */
export function isVscodePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === '/api/vscode' || pathname.startsWith('/api/vscode/');
}

/**
 * Strip only `/api/vscode/<expectedSessionId>` for code-server. Query strings
 * are intentionally rejected here and remain caller-owned for the separate
 * selector validation/request-target step. Any missing, mismatched, encoded, or
 * lookalike prefix fails closed before an upstream request is created.
 */
export function vscodeUpstreamPath(
  pathname: string | null | undefined,
  expectedSessionId: string | null | undefined,
): string | null {
  if (!pathname || !expectedSessionId || pathname.includes('?')) return null;
  const prefix = `/api/vscode/${expectedSessionId}`;
  if (pathname === prefix) return '/';
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length);
}

/**
 * Build the exact loopback request target without exposing a workspace path in
 * the browser. Public workspace selectors are never trusted, even when they name
 * the fixed root. Only the root document receives the internal fixed selector;
 * asset and protocol query bytes remain unchanged.
 */
export function vscodeUpstreamRequestTarget(
  rawUrl: string | null | undefined,
  upstreamPath: string,
): string | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, 'http://codeflare.invalid');
  } catch {
    return null;
  }
  if (WORKSPACE_SELECTOR_KEYS.some((key) => parsed.searchParams.has(key))) return null;
  const queryIndex = rawUrl.indexOf('?');
  const search = queryIndex === -1 ? '' : rawUrl.slice(queryIndex);
  if (upstreamPath !== '/') return `${upstreamPath}${search}`;
  const separator = search ? '&' : '?';
  return `/${search}${separator}folder=${encodeURIComponent(CODEFLARE_WORKSPACE_ROOT)}`;
}

/**
 * Project the fixed workspace into Code OSS's pinned workbench bootstrap while
 * the public browser URL remains selector-free. Code OSS reads folder queries
 * from document.location, not code-server's private upstream URL, so the
 * trusted host must supply the equivalent remote folder in server config.
 * HTML shape drift fails closed instead of silently opening an empty window.
 */
// Symmetric attribute-entity round-trip: decode releases &amp; last and encode
// escapes & first, so any entity or literal &/</" inside a configuration value
// survives projection byte-identical instead of re-emitting double-encoded.
function decodeWorkbenchAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function encodeWorkbenchAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function projectVscodeWorkbenchWorkspace(html: string): string | null {
  if (Buffer.byteLength(html) > OPENVSCODE_WORKBENCH_MAX_BYTES) return null;
  const matches = [...html.matchAll(WORKBENCH_CONFIGURATION_PATTERN)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const matchStart = match.index;
  if (matchStart === undefined) return null;

  let configuration: Record<string, unknown>;
  try {
    const parsed = JSON.parse(decodeWorkbenchAttribute(match[1])) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    configuration = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const remoteAuthority = configuration.remoteAuthority;
  if (typeof remoteAuthority !== 'string' || remoteAuthority.length === 0 || remoteAuthority.length > 255) {
    return null;
  }
  try {
    const authority = new URL(`https://${remoteAuthority}`);
    if (!authority.host || authority.pathname !== '/'
      || authority.search || authority.hash || authority.username || authority.password) return null;
  } catch {
    return null;
  }

  const projected = {
    ...configuration,
    folderUri: {
      scheme: 'vscode-remote',
      authority: remoteAuthority,
      path: CODEFLARE_WORKSPACE_ROOT,
    },
  };
  const encoded = encodeWorkbenchAttribute(JSON.stringify(projected));
  // Replacer function: a literal replacement string would expand $-patterns
  // ($&, $') that can legitimately appear inside the encoded JSON.
  const projectedMarker = match[0].replace(match[1], () => encoded);
  return `${html.slice(0, matchStart)}${projectedMarker}${html.slice(matchStart + match[0].length)}`;
}

/** Rewrite a root-relative code-server redirect beneath the public session path. */
export function rewriteVscodeLocation(location: string, sessionId: string): string {
  if (!location.startsWith('/') || location.startsWith('//')) return location;
  try {
    const parsed = new URL(location, 'http://codeflare.invalid');
    for (const key of WORKSPACE_SELECTOR_KEYS) parsed.searchParams.delete(key);
    return `/api/vscode/${sessionId}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return `/api/vscode/${sessionId}/`;
  }
}

/**
 * REQ-IDE-003 AC2: lazy-start trigger. The Browser IDE supervisor waits for this
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
 * REQ-IDE-003 (advanced-mode only): the Browser IDE supervisor is armed only in
 * advanced session mode. `mode` is the container's `SESSION_MODE`. Fail-open
 * when it is unset/empty so behaviour is unchanged; block only a session that is
 * explicitly a non-advanced mode -- otherwise such a session would sit on the
 * auto-refreshing warming page forever (its supervisor never launches).
 */
export function vscodeModeAllowed(mode: string | undefined | null): boolean {
  return !mode || mode === 'advanced';
}

/**
 * How long the warming page keeps reloading before it calls the start a
 * failure. A supervisor that has not bound `:13337` within two minutes is not
 * slow, it is broken, and refreshing forever presents that as slowness.
 */
export const VSCODE_WARMING_GIVE_UP_MS = 120_000;

/**
 * The lazy-start warming page (REQ-IDE-003 AC3). The first `/api/vscode` request
 * triggers the supervisor, and the connect to `:13337` fails until code-server
 * binds (a few seconds). Rather than dumping raw JSON into a plain `_blank`
 * browser tab, serve a tiny HTML page that auto-refreshes so the tab lands on
 * the real editor once it is up. 503 = not-ready; browsers still render the body
 * and honour the meta refresh.
 *
 * Past `VSCODE_WARMING_GIVE_UP_MS` it stops refreshing and says so. A meta
 * refresh cannot count its own attempts -- each reload is a fresh document --
 * so the caller owns the elapsed clock and passes it in.
 */
export function vscodeWarmingResponse(elapsedMs = 0): VscodeHostResponse {
  if (elapsedMs >= VSCODE_WARMING_GIVE_UP_MS) {
    return {
      status: 504,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark light"><title>Editor did not start</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p>The editor did not start. Reload to try again, or restart the session.</p></body></html>',
    };
  }
  const seconds = Math.floor(elapsedMs / 1000);
  return {
    status: 503,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><meta name="color-scheme" content="dark light"><title>Starting editor</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p>Starting the editor&hellip; ${seconds}s</p></body></html>`,
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
