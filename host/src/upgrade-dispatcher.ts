/**
 * WebSocket upgrade dispatcher (CF-014 companion).
 *
 * Owns the single server 'upgrade' listener plus the vault and vscode WS
 * proxy bridges (handleVaultUpgrade / handleVscodeUpgrade). server.ts owns
 * the terminal WSS; both proxy WSS instances live here. Every WSS uses
 * noServer:true — see the terminal WSS creation comment in server.ts for why
 * the `{server, path}` form cannot be used.
 */
import type http from 'node:http';
import { parse as parseUrl } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { checkContainerAuth } from './auth-check.js';
import { stripVaultPrefix } from './vault-proxy.js';
import {
  bridgeVscodeClientMessages,
  createVscodeWebSocketServer,
  isVscodePath,
  vscodeUpstreamPath,
  vscodeUpstreamRequestTarget,
  requestOpenvscodeStart,
  vscodeModeAllowed,
} from './vscode-proxy.js';
import type { ProxyTarget } from './request-router.js';
import type { ActivityTracker, Logger } from './types.js';

export interface UpgradeDispatcherDeps {
  /** The /terminal WSS (owned by server.ts, where its connection handler is attached). */
  terminalWss: WebSocketServer;
  activityTracker: ActivityTracker;
  log: Logger;
  silverbullet: ProxyTarget;
  openvscode: ProxyTarget;
  wsMaxPayload: number;
}

export interface UpgradeDispatcher {
  handleUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void;
  /** Close the proxy WSS this dispatcher owns (used by graceful shutdown). */
  close(): void;
}

// Forward client headers minus hop-by-hop / handshake / injected container
// auth. For code-server, discard all client forwarding metadata and rebuild one
// canonical external identity from the Worker's validated headers.
function filterUpgradeHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => {
      const lk = k.toLowerCase();
      return lk !== 'connection' && lk !== 'upgrade'
        && lk !== 'sec-websocket-key' && lk !== 'sec-websocket-version'
        && lk !== 'sec-websocket-extensions' && lk !== 'sec-websocket-protocol'
        && lk !== 'authorization' && lk !== 'host';
    }),
  ) as Record<string, string>;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function vscodeUpgradeHeaders(
  headers: http.IncomingHttpHeaders,
  target: ProxyTarget,
): Record<string, string> {
  const filtered = filterUpgradeHeaders(headers);
  const output = Object.fromEntries(
    Object.entries(filtered).filter(([name]) => {
      const lower = name.toLowerCase();
      return lower !== 'forwarded' && !lower.startsWith('x-forwarded-') && lower !== 'origin';
    }),
  );
  const suppliedHost = singleHeader(headers['x-forwarded-host']);
  const suppliedProto = singleHeader(headers['x-forwarded-proto']);
  let canonicalHost = `${target.host}:${target.port}`;
  let canonicalProto = 'http';
  if (suppliedHost && (suppliedProto === 'http' || suppliedProto === 'https')) {
    try {
      const external = new URL(`${suppliedProto}://${suppliedHost}`);
      if (external.pathname === '/' && !external.username && !external.password) {
        canonicalHost = external.host;
        canonicalProto = suppliedProto;
      }
    } catch {
      // Direct authenticated host probes use the loopback identity fallback.
    }
  }
  const suppliedOrigin = singleHeader(headers.origin);
  return {
    ...output,
    Host: canonicalHost,
    'X-Forwarded-Host': canonicalHost,
    'X-Forwarded-Proto': canonicalProto,
    ...(suppliedOrigin ? { Origin: suppliedOrigin } : {}),
  };
}

export function createUpgradeDispatcher(deps: UpgradeDispatcherDeps): UpgradeDispatcher {
  const { log } = deps;

  // Vault WebSocket proxy → SilverBullet.
  //
  // SilverBullet uses WS for live-edit sync; the path is whatever the
  // SilverBullet client picks (e.g. `/.client/ws`). We route /vault/* via
  // `noServer: true` and proxy to upstream below.
  const vaultWss = new WebSocketServer({ noServer: true, maxPayload: deps.wsMaxPayload });
  const vscodeWss = createVscodeWebSocketServer();

  function handleVaultUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const { pathname } = parseUrl(req.url ?? '');
    // Strip the `/vault` prefix; the worker already stripped its own
    // `/api/vault/:sid` prefix. SilverBullet sees its native WS path.
    const upstreamPath = stripVaultPrefix(pathname);
    const search = (req.url ?? '').includes('?')
      ? '?' + (req.url ?? '').split('?').slice(1).join('?')
      : '';

    vaultWss.handleUpgrade(req, socket, head, (clientWs) => {
      const upstreamUrl = `ws://${deps.silverbullet.host}:${deps.silverbullet.port}${upstreamPath}${search}`;
      let upstream: WebSocket;
      try {
        upstream = new WebSocket(upstreamUrl, {
          headers: filterUpgradeHeaders(req.headers),
        });
      } catch (err) {
        log('warn', 'Vault WS upstream construct failed', { error: (err as Error).message });
        clientWs.close(1011, 'upstream-construct-failed');
        return;
      }

      const closeBoth = (code: number, reason: string): void => {
        try { clientWs.close(code, reason); } catch { /* ignore */ }
        try { upstream.close(code, reason); } catch { /* ignore */ }
      };

      upstream.on('open', () => {
        // Bridge in both directions. `ws` emits Buffer for binary frames
        // and string for text frames; send() handles both transparently.
        clientWs.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        upstream.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
        });
      });

      clientWs.on('close', (code, reason) => {
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          try { upstream.close(code, reason.toString()); } catch { /* ignore */ }
        }
      });
      upstream.on('close', (code, reason) => {
        if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
          try { clientWs.close(code, reason.toString()); } catch { /* ignore */ }
        }
      });

      clientWs.on('error', (err) => {
        log('warn', 'Vault WS client error', { message: err.message });
        closeBoth(1011, 'client-error');
      });
      upstream.on('error', (err) => {
        log('warn', 'Vault WS upstream error', { message: err.message });
        closeBoth(1011, 'upstream-error');
      });
    });
  }

  // Browser IDE WebSocket bridge -> code-server's root-relative VS Code
  // protocol endpoint. The caller validates and strips the exact session prefix
  // before a downstream or upstream socket is opened.
  function handleVscodeUpgrade(
    req: http.IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
    upstreamPath: string,
  ): void {
    const upstreamTarget = vscodeUpstreamRequestTarget(req.url, upstreamPath);
    if (upstreamTarget === null) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    vscodeWss.handleUpgrade(req, socket, head, (clientWs) => {
      const upstreamUrl = `ws://${deps.openvscode.host}:${deps.openvscode.port}${upstreamTarget}`;
      let upstream: WebSocket;
      try {
        upstream = new WebSocket(upstreamUrl, {
          headers: vscodeUpgradeHeaders(req.headers, deps.openvscode),
        });
      } catch (err) {
        log('warn', 'Vscode WS upstream construct failed', { error: (err as Error).message });
        clientWs.close(1011, 'upstream-construct-failed');
        return;
      }

      const closeBoth = (code: number, reason: string): void => {
        try { clientWs.close(code, reason); } catch { /* ignore */ }
        try { upstream.close(code, reason); } catch { /* ignore */ }
      };

      bridgeVscodeClientMessages(clientWs, upstream, () => deps.activityTracker.recordInput());
      upstream.on('open', () => {
        upstream.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
        });
      });

      clientWs.on('close', (code, reason) => {
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          try { upstream.close(code, reason.toString()); } catch { /* ignore */ }
        }
      });
      upstream.on('close', (code, reason) => {
        if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
          try { clientWs.close(code, reason.toString()); } catch { /* ignore */ }
        }
      });

      clientWs.on('error', (err) => {
        log('warn', 'Vscode WS client error', { message: err.message });
        closeBoth(1011, 'client-error');
      });
      upstream.on('error', (err) => {
        log('warn', 'Vscode WS upstream error', { message: err.message });
        closeBoth(1011, 'upstream-error');
      });
    });
  }

  // Single upgrade dispatcher for the whole server. All WSS instances use
  // noServer:true; this listener inspects the upgrade URL and routes to the
  // correct WSS. Unknown paths get the socket destroyed cleanly (HTTP 400)
  // so misrouted clients fail fast.
  function handleUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const { pathname } = parseUrl(req.url ?? '');
    const authOutcome = checkContainerAuth(
      pathname ?? '',
      singleHeader(req.headers.authorization),
      process.env.CONTAINER_AUTH_TOKEN,
    );
    if (!authOutcome.allowed) {
      const reason = authOutcome.status === 401 ? 'Unauthorized' : 'Service Unavailable';
      socket.write(`HTTP/1.1 ${authOutcome.status} ${reason}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${authOutcome.body}`);
      socket.destroy();
      return;
    }

    if (pathname === '/terminal') {
      deps.terminalWss.handleUpgrade(req, socket, head, (ws) => {
        deps.terminalWss.emit('connection', ws, req);
      });
      return;
    }

    if (pathname && (pathname === '/vault' || pathname.startsWith('/vault/'))) {
      handleVaultUpgrade(req, socket, head);
      return;
    }

    if (isVscodePath(pathname)) {
      // Advanced-mode only (REQ-IDE-003): mirror the HTTP branch's guard so a
      // non-advanced session never arms the lazy-start trigger for a supervisor
      // that will never launch. Refuse the upgrade cleanly (the client sees a
      // failed handshake); the Worker auth chain remains the real boundary.
      if (!vscodeModeAllowed(process.env.SESSION_MODE)) {
        socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
        socket.destroy();
        return;
      }
      const upstreamPath = vscodeUpstreamPath(pathname, process.env.SESSION_ID);
      if (upstreamPath === null) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      requestOpenvscodeStart();
      handleVscodeUpgrade(req, socket, head, upstreamPath);
      return;
    }

    // Unknown WS path. Refuse cleanly so the client sees a proper
    // handshake failure rather than hanging.
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
  }

  return {
    handleUpgrade,
    close(): void {
      vaultWss.close();
    },
  };
}
