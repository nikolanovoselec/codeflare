/**
 * Terminal WebSocket connection handler (CF-014 companion).
 *
 * Owns the /terminal WS session protocol: the warming-up gate, session
 * attach, the raw-vs-JSON input classification (REQ-TERM-019), and the
 * close/error bookkeeping. server.ts owns the WebSocketServer instance and
 * upgrade routing; this module is importable in unit tests.
 */
import type http from 'node:http';
import { parse as parseUrl } from 'node:url';
import { WebSocket, type WebSocketServer } from 'ws';
import type { SessionManager } from './session-manager.js';
import type { Logger, WsEventLogger } from './types.js';

const AGENT_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface TerminalWsDeps {
  sessionManager: SessionManager;
  log: Logger;
  logWsEvent: WsEventLogger;
  /** Live readiness flags owned by server.ts's prewarm lifecycle. */
  readiness(): { initFlagObserved: boolean; terminalServiceReady: boolean };
  keepalivePingMs: number;
  maxControlMsgLength: number;
  queryHerdrScroll?: () => Promise<boolean | null>;
}

export function attachTerminalConnectionHandler(wss: WebSocketServer, deps: TerminalWsDeps): void {
  const { sessionManager, log, logWsEvent } = deps;

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const { query } = parseUrl(req.url ?? '', true);
    const sessionId = query.session as string | undefined;
    const isManualTab = query.manual === '1';
    const connectedAt = Date.now();
    let latestHerdrScrollRequest = -1;

    // Reject early: port 8080 binds before R2 sync + .bashrc autostart writes.
    // If we accept now we'd spawn a fresh PTY with no autostart in .bashrc, and
    // the user would land in bare bash instead of their configured agent.
    // Close with 1013 (Try Again Later) so the client's reconnect logic retries
    // after a brief delay. Once the entrypoint touches the init-complete flag
    // and the pre-warm session is in the map, this gate opens.
    const { initFlagObserved, terminalServiceReady } = deps.readiness();
    if (!terminalServiceReady) {
      log('info', 'WS upgrade rejected: terminal service warming up', { initFlagObserved, sessionId: sessionId?.substring(0, 8) });
      ws.close(1013, 'container-warming-up');
      return;
    }

    if (!sessionId) {
      ws.close(1008, 'Session ID required');
      return;
    }

    const shortId = sessionId.substring(0, 8);

    // WebSocket keepalive: send protocol-level ping every 30s to prevent
    // NAT/load-balancer idle timeouts from silently dropping connections
    let lastPongAt = Date.now();
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, deps.keepalivePingMs);

    ws.on('pong', () => {
      lastPongAt = Date.now();
    });

    // Sanitize session name
    const name = ((query.name as string) ?? '').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 100) || 'Terminal';

    // Get or create session (pass manual flag for user-created tabs)
    const session = sessionManager.getOrCreate(sessionId, name, isManualTab);
    if (!session) {
      ws.close(1013, 'Session limit reached');
      return;
    }

    // Attach client to session
    session.attach(ws);

    log('info', 'WS connected', { session: shortId, ptyAlive: session.isPtyAlive(), ptyPid: session.ptyProcess?.pid ?? null, totalClients: session.clients.size });
    logWsEvent(sessionId, 'connect', { clients: session.clients.size, ptyAlive: session.isPtyAlive(), ptyPid: session.ptyProcess?.pid ?? null });

    // Handle incoming messages
    // RAW data goes directly to PTY, JSON only for control messages (resize)
    ws.on('message', (message: Buffer | string) => {
      const str = message.toString();

      // Try to parse as JSON for known control messages only
      // Length-gated: control messages are small; skip parsing for large terminal input
      if (str.length <= deps.maxControlMsgLength && str.startsWith('{')) {
        try {
          const msg = JSON.parse(str) as Record<string, unknown>;

          // Validate type field AND correct field types before acting
          if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
            if (msg.cols > 0 && msg.cols < 10000 && msg.rows > 0 && msg.rows < 10000) {
              session.resize(msg.cols as number, msg.rows as number, ws);
            }
            return;
          }

          if (msg.type === 'focus') {
            session.claimResizeAuthority(ws);
            return;
          }

          if (msg.type === 'herdr-scroll-probe') {
            const keys = Object.keys(msg);
            if (keys.length === 4
                && keys.every((key) => key === 'type' || key === 'requestId' || key === 'cols' || key === 'rows')
                && typeof msg.requestId === 'number' && Number.isSafeInteger(msg.requestId) && msg.requestId >= 0
                && typeof msg.cols === 'number' && Number.isSafeInteger(msg.cols) && msg.cols > 0 && msg.cols < 10000
                && typeof msg.rows === 'number' && Number.isSafeInteger(msg.rows) && msg.rows > 0 && msg.rows < 10000
                && deps.queryHerdrScroll) {
              const requestId = msg.requestId as number;
              latestHerdrScrollRequest = Math.max(latestHerdrScrollRequest, requestId);
              const cols = msg.cols as number;
              const rows = msg.rows as number;
              void deps.queryHerdrScroll().then((aboveBottom) => {
                if (requestId !== latestHerdrScrollRequest
                    || !session.clients.has(ws)
                    || ws.readyState !== WebSocket.OPEN) return;
                if (aboveBottom !== null && !session.canResize(ws)) {
                  ws.send(JSON.stringify({
                    type: 'herdr-scroll-state', requestId,
                    available: false,
                    aboveBottom: false,
                  }));
                  return;
                }
                ws.send(JSON.stringify({
                  type: 'herdr-scroll-state', requestId,
                  available: aboveBottom !== null,
                  aboveBottom: aboveBottom === true,
                }));
                if (aboveBottom !== null) session.resize(cols, rows, ws);
              });
            }
            return;
          }

          if (msg.type === 'data' && typeof msg.data === 'string') {
            session.write(msg.data as string);
            return;
          }

          if (msg.type === 'agent-event-disposition') {
            const keys = Object.keys(msg);
            if (keys.length === 3
                && keys.every((key) => key === 'type' || key === 'eventId' || key === 'disposition')
                && typeof msg.eventId === 'string'
                && AGENT_EVENT_ID_PATTERN.test(msg.eventId)
                && (msg.disposition === 'suppress' || msg.disposition === 'display-request')) {
              session.submitAgentEventDisposition(msg.eventId, ws, msg.disposition);
            }
            return;
          }

          if (msg.type === 'agent-event-displayed') {
            const keys = Object.keys(msg);
            if (keys.length === 2
                && keys.every((key) => key === 'type' || key === 'eventId')
                && typeof msg.eventId === 'string'
                && AGENT_EVENT_ID_PATTERN.test(msg.eventId)) {
              session.confirmAgentEventDisplay(msg.eventId, ws);
            }
            return;
          }

          if (msg.type === 'kill') {
            log('info', 'Kill requested by client', { session: shortId });
            session.kill();
            sessionManager.sessions.delete(sessionId);
            ws.close(1000, 'Session killed');
            return;
          }

          if (msg.type === 'heartbeat') {
            // Heartbeat messages from legacy frontends — acknowledged but ignored.
            // Idle detection is now based on input change detection, not heartbeats.
            return;
          }

          // Guard: any JSON with a type string field that we don't handle
          // should NOT fall through to raw PTY write
          if (typeof msg.type === 'string') {
            return;
          }
        } catch {
          // Not valid JSON — treat as raw terminal input
        }
      }

      // Raw terminal input - write directly to PTY
      session.write(str);
    });

    // Handle client disconnect
    ws.on('close', (code: number, reason: Buffer) => {
      clearInterval(pingInterval);
      const duration = Math.floor((Date.now() - connectedAt) / 1000);
      const reasonStr = reason ? reason.toString() : '';
      const pongAge = Math.floor((Date.now() - lastPongAt) / 1000);
      const remainingClients = Math.max(0, session.clients.size - 1);
      log('info', 'WS closed', { session: shortId, code, reason: reasonStr, durationSec: duration, lastPongAgeSec: pongAge, ptyAlive: session.isPtyAlive(), remainingClients });
      logWsEvent(sessionId, 'close', { code, reason: reasonStr, durationSec: duration, lastPongAgeSec: pongAge, ptyAlive: session.isPtyAlive(), remainingClients });
      session.detach(ws, sessionManager);
    });

    // Handle errors
    ws.on('error', (err: Error & { code?: string }) => {
      const duration = Math.floor((Date.now() - connectedAt) / 1000);
      log('error', 'WS error', { session: shortId, message: err.message, errCode: err.code ?? null, durationSec: duration, ptyAlive: session.isPtyAlive() });
      logWsEvent(sessionId, 'error', { message: err.message, errCode: err.code ?? null, durationSec: duration, ptyAlive: session.isPtyAlive() });
      session.detach(ws, sessionManager);
    });

    // Connection ready - no JSON message, just start sending PTY data
  });
}
