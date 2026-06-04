/**
 * Codeflare Terminal Server
 *
 * WebSocket server that manages multiple PTY sessions.
 * One container serves multiple sessions (terminal tabs).
 *
 * Endpoints:
 * - WS  /terminal?session=<id> - Connect to terminal session
 * - GET  /health              - Health check with system metrics
 * - GET  /activity            - WebSocket connection activity (for idle detection)
 * - GET  /sessions            - List active sessions
 * - POST /sessions            - Create new session
 * - DELETE /sessions/:id      - Delete session
 * - GET  /ws-events           - Recent WebSocket event log (debugging)
 * - GET  /sync-log            - rclone sync log
 */

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'node:url';
import fs from 'node:fs';
import { createActivityTracker } from './activity-tracker.js';
import { getPrewarmConfig } from './prewarm-config.js';
import { getSyncStatus, getSystemMetrics } from './metrics.js';
import { checkContainerAuth } from './auth-check.js';
import { evaluateFinalSync } from './final-sync.js';
import { Session } from './session.js';
import { SessionManager, PREWARM_SESSION_ID } from './session-manager.js';
import type { LogLevel, Logger, WsEventLogger, WsEvent, TabConfigEntry, ActivityTracker, SessionOptions } from './types.js';

const WS_KEEPALIVE_PING_MS = 30000;

// Structured logger — replaces raw console.log/console.error calls
const log: Logger = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
  const entry = `[${level.toUpperCase()}] ${msg}`;
  if (meta) {
    const metaStr = JSON.stringify(meta);
    if (level === 'error') {
      console.error(entry, metaStr);
    } else {
      console.log(entry, metaStr);
    }
  } else {
    if (level === 'error') {
      console.error(entry);
    } else {
      console.log(entry);
    }
  }
};

// Start time for uptime calculation
const SERVER_START_TIME = Date.now();

const PORT = parseInt(process.env.TERMINAL_PORT ?? '8080', 10);
// Spawn a login shell so .bashrc runs and auto-starts the configured agent
// The .bashrc has agent auto-start logic that only works in interactive login shells
const TERMINAL_COMMAND = process.env.TERMINAL_COMMAND ?? '/bin/bash';
const TERMINAL_ARGS = process.env.TERMINAL_ARGS ?? '-l';  // Login shell flag
const WORKSPACE_DEFAULT = process.env.WORKSPACE ?? '/home/user/workspace';

// PTY persistence settings - safety-net floor only. The authoritative idle
// policy lives in collectMetrics (container DO) keyed off `lastInputAt`. This
// reaper only fires if that policy gets stuck. See AD47.
const PTY_KEEPALIVE_MS = parseInt(process.env.PTY_KEEPALIVE_MS ?? '7200000', 10); // 120 minutes
const PTY_CLEANUP_INTERVAL_MS = parseInt(process.env.PTY_CLEANUP_INTERVAL_MS ?? '60000', 10); // Check every minute

// Named constants for magic numbers
const WS_MAX_PAYLOAD = 64 * 1024;        // 64KB WebSocket max payload
const MAX_CONTROL_MSG_LENGTH = 200;       // Max length for JSON control message detection

// SilverBullet supervisor binds on 127.0.0.1:3030 inside the container
// (see entrypoint.sh:start_silverbullet_supervisor). The /vault HTTP +
// WS branch below proxies to it. Localhost-only by design — the auth
// boundary is the Worker proxy at /api/vault/:sid/.
const SILVERBULLET_HOST = process.env.SILVERBULLET_HOST ?? '127.0.0.1';
const SILVERBULLET_PORT = parseInt(process.env.SILVERBULLET_PORT ?? '3030', 10);

// Parse TAB_CONFIG for expected process names per terminal tab.
// TAB_CONFIG is set by the Container DO before container start.
function buildTabConfigMap(): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    const tabConfig: TabConfigEntry[] = JSON.parse(process.env.TAB_CONFIG ?? '[]');
    for (const tab of tabConfig) {
      if (tab.command) {
        map[tab.id] = tab.command;
      }
    }
  } catch {
    // Ignore parse errors, fall back to ptyProcess.process
  }
  return map;
}

// Determine actual working directory - fall back if WORKSPACE doesn't exist
// This handles the case where R2 mount fails or hasn't completed yet
let cachedWorkingDir: string | null = null;
function getWorkingDirectory(): string {
  if (cachedWorkingDir) return cachedWorkingDir;
  if (fs.existsSync(WORKSPACE_DEFAULT)) {
    cachedWorkingDir = WORKSPACE_DEFAULT;
    return cachedWorkingDir;
  }
  // Fall back to HOME or /tmp if workspace doesn't exist
  const fallback = process.env.HOME ?? '/tmp';
  log('warn', 'Workspace not found, falling back', { workspace: WORKSPACE_DEFAULT, fallback });
  cachedWorkingDir = fallback;
  return cachedWorkingDir;
}

// Ring buffer for recent WebSocket events (for debugging disconnects)
const WS_EVENT_BUFFER_SIZE = 100;

// Build a WsEventLogger that appends to the supplied ring buffer.
function createWsEventLogger(wsEventLog: WsEvent[]): WsEventLogger {
  return (sessionId: string, type: string, details?: Record<string, unknown>): void => {
    const event: WsEvent = {
      ts: new Date().toISOString(),
      session: sessionId.substring(0, 8),
      type,
      ...details,
    };
    wsEventLog.push(event);
    if (wsEventLog.length > WS_EVENT_BUFFER_SIZE) {
      wsEventLog.shift();
    }
  };
}

/**
 * The server's owned mutable state, hoisted out of module scope into a single
 * explicit object (CF-014). Handlers below read and mutate these fields through
 * the `state` reference instead of bare module-level globals.
 *
 * Note: the original CF-014 brief listed a `pendingAuthCheck` field, but the
 * auth boundary is now the pure `checkContainerAuth()` function (no mutable
 * state), so that field is intentionally absent.
 */
interface ServerState {
  readonly sessionManager: SessionManager;
  readonly wsEventLog: WsEvent[];
  readonly tabConfigMap: Record<string, string>;
  readonly activityTracker: ActivityTracker;
  readonly prewarmSessionId: string;
  readonly logWsEvent: WsEventLogger;
  readonly sessionOptions: SessionOptions;
}

function createServerState(): ServerState {
  const tabConfigMap = buildTabConfigMap();
  const wsEventLog: WsEvent[] = [];
  const logWsEvent = createWsEventLogger(wsEventLog);
  // Activity tracking for smart hibernation (WebSocket disconnect tracking)
  const activityTracker = createActivityTracker();

  // Shared options for Session and SessionManager
  const sessionOptions: SessionOptions = {
    tabConfigMap,
    terminalCommand: TERMINAL_COMMAND,
    terminalArgs: TERMINAL_ARGS,
    getWorkingDirectory,
    log,
    logWsEvent,
    activityTracker,
    ptyKeepaliveMs: PTY_KEEPALIVE_MS,
    maxSessions: 20,
    ptyCleanupIntervalMs: PTY_CLEANUP_INTERVAL_MS,
  };

  return {
    sessionManager: new SessionManager(sessionOptions),
    wsEventLog,
    tabConfigMap,
    activityTracker,
    prewarmSessionId: PREWARM_SESSION_ID,
    logWsEvent,
    sessionOptions,
  };
}

const state = createServerState();
const { sessionManager, logWsEvent } = state;

// Create HTTP server
const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const { pathname } = parseUrl(req.url ?? '');
  const method = req.method;

  // REQ-SEC-012: container auth-token check. Logic extracted to
  // ./auth-check.ts so it can be unit-tested without spawning node-pty.
  const authOutcome = checkContainerAuth(
    pathname ?? '',
    req.headers['authorization'],
    process.env.CONTAINER_AUTH_TOKEN,
  );
  if (!authOutcome.allowed) {
    res.writeHead(authOutcome.status, { 'Content-Type': 'application/json' });
    res.end(authOutcome.body);
    return;
  }

  // Health check with full metrics (consolidates separate health server)
  if (pathname === '/health' && method === 'GET') {
    const syncInfo = getSyncStatus();
    const sysMetrics = await getSystemMetrics(log);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'healthy',
        sessions: sessionManager.size,
        uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
        syncStatus: syncInfo.status,
        syncError: syncInfo.error,
        userPath: syncInfo.userPath,
        prewarmReady,
        initFlagObserved,
        terminalServiceReady,
        cpu: sysMetrics.cpu,
        mem: sysMetrics.mem,
        hdd: sysMetrics.hdd,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  // WebSocket event log for debugging disconnects
  if (pathname === '/ws-events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: state.wsEventLog }));
    return;
  }

  // Activity endpoint for smart hibernation (WS connection-based)
  if (pathname === '/activity' && method === 'GET') {
    state.activityTracker.recordHeartbeat();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.activityTracker.getActivityInfo(sessionManager)));
    return;
  }

  // List sessions
  if (pathname === '/sessions' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: sessionManager.list() }));
    return;
  }

  // Create session
  if (pathname === '/sessions' && method === 'POST') {
    const MAX_BODY_SIZE = 64 * 1024; // 64KB
    let body = '';
    let bodySize = 0;
    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (bodySize > MAX_BODY_SIZE) return;
      try {
        const { id, name } = JSON.parse(body || '{}') as { id?: string; name?: string };
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session ID required' }));
          return;
        }

        const session = sessionManager.getOrCreate(id, name ?? 'Terminal');
        if (!session) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session limit reached' }));
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session: session.toJSON() }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Delete session
  const deleteMatch = (pathname ?? '').match(/^\/sessions\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const id = deleteMatch[1];
    const deleted = sessionManager.delete(id);
    if (deleted) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true, id }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
    }
    return;
  }

  // Manual bisync trigger (REQ-STOR-015 AC1). Sends SIGUSR1 to the
  // bisync daemon, which interrupts its sleep and runs an immediate
  // bisync cycle. Idempotent: signals during a running bisync coalesce
  // to exactly one rerun (see entrypoint.sh trap).
  //
  // Hibernation note: the daemon PID is read from /tmp/sync-daemon.pid
  // at every call, never cached. If the container is sleeping or the
  // daemon has not yet written its PID file, the call returns 503; the
  // Worker fan-out treats 503 as "session not active, skip" rather
  // than propagating a user-visible error.
  if (pathname === '/internal/bisync-trigger' && method === 'POST') {
    try {
      const pidStr = fs.readFileSync('/tmp/sync-daemon.pid', 'utf8').trim();
      const pid = Number(pidStr);
      if (!Number.isFinite(pid) || pid <= 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not-running', error: 'invalid daemon PID' }));
        return;
      }
      try {
        process.kill(pid, 'SIGUSR1');
      } catch {
        // ESRCH: process gone (daemon crashed or container restarting).
        // Treat as not-running; the next container wake forces a
        // baseline bisync per REQ-STOR-004 AC4, absorbing this trigger.
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not-running', error: 'daemon process not found' }));
        return;
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'triggered' }));
    } catch {
      // PID file missing: daemon has not started yet (container still
      // running initial sync) or has been torn down (shutdown trap).
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not-running', error: 'sync daemon not started' }));
    }
    return;
  }

  // Awaited final sync (REQ-SESSION-011 AC2). Triggers a fresh bisync (SIGUSR1
  // to the daemon, the same proven path as /internal/bisync-trigger) and BLOCKS
  // until that bisync reaches a terminal status, so the Durable Object can drain
  // the workspace to R2 while the container is still fully alive instead of
  // relying on the post-SIGTERM kill grace (far too short for a bisync). The DO
  // calls this before stopping the container and bounds it with its own budget.
  //
  // Completion detection (REQ-SESSION-011 AC3): record the trigger time, then
  // wait for a `syncing` transition stamped at/after the trigger (our run
  // started), then for that run's `success`/`failed` transition (newer ts). The
  // two-phase wait ignores a bisync that was already in flight when we
  // triggered - the daemon coalesces our SIGUSR1 into a rerun whose `syncing`
  // ts lands after our trigger.
  if (pathname === '/internal/final-sync' && method === 'POST') {
    const triggerTs = Date.now();
    const readStatus = (): { status?: string; ts?: number } => {
      try { return JSON.parse(fs.readFileSync('/tmp/sync-status.json', 'utf8')); }
      catch { return {}; }
    };
    try {
      const pid = Number(fs.readFileSync('/tmp/sync-daemon.pid', 'utf8').trim());
      if (!Number.isFinite(pid) || pid <= 0) throw new Error('invalid daemon PID');
      process.kill(pid, 'SIGUSR1');
    } catch {
      // No daemon: container is mid-init or already tearing down. Nothing to
      // drain; let the caller proceed to stop.
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ synced: false, reason: 'daemon-not-running' }));
      return;
    }
    const INTERNAL_TIMEOUT_MS = 115_000; // just under the DO's 120s budget
    const POLL_MS = 500;
    // Two-phase completion detection lives in the pure evaluateFinalSync state
    // machine (final-sync.ts) so the syncing->success/failed discrimination is
    // unit-testable without spawning the daemon; this loop owns only the I/O.
    let runStartedTs = -1;
    while (Date.now() - triggerTs < INTERNAL_TIMEOUT_MS) {
      const ev = evaluateFinalSync(readStatus(), triggerTs, runStartedTs);
      runStartedTs = ev.runStartedTs;
      if (ev.result === 'success') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ synced: true }));
        return;
      }
      if (ev.result === 'failed') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ synced: false, reason: 'bisync-failed' }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ synced: false, reason: 'timeout' }));
    return;
  }

  // Sync log endpoint
  if (pathname === '/sync-log' && method === 'GET') {
    try {
      const MAX_LOG_SIZE = 100 * 1024; // 100KB
      const stat = fs.statSync('/tmp/sync.log');
      let logContent: string;
      if (stat.size > MAX_LOG_SIZE) {
        // Read only the last 100KB
        const buffer = Buffer.alloc(MAX_LOG_SIZE);
        const fd = fs.openSync('/tmp/sync.log', 'r');
        fs.readSync(fd, buffer, 0, MAX_LOG_SIZE, stat.size - MAX_LOG_SIZE);
        fs.closeSync(fd);
        logContent = '... (truncated)\n' + buffer.toString('utf8');
      } else {
        logContent = fs.readFileSync('/tmp/sync.log', 'utf8');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ log: logContent }));
    } catch {
      res.writeHead(404);
      res.end('No sync log found');
    }
    return;
  }

  // Vault HTTP proxy → SilverBullet at SILVERBULLET_HOST:SILVERBULLET_PORT.
  // Strip the `/vault` prefix; the worker already strips its own
  // `/api/vault/:sid` prefix before forwarding. SilverBullet sees a
  // clean `/<remaining>` path.
  if (pathname && (pathname === '/vault' || pathname.startsWith('/vault/'))) {
    let upstreamPath = pathname.slice('/vault'.length) || '/';
    // SilverBullet 2.8.0 serves the service worker only at the root path
    // (/service_worker.js, with Content-Type text/javascript). Requests
    // routed under /.client/service_worker.js fall through to the
    // catch-all SPA handler and come back as text/html, which the
    // browser then rejects with "ServiceWorker: bad MIME type" and the
    // user sees the registration error from screenshot 1. The base-href
    // rewrite in src/routes/vault.ts already makes SB client.js compute
    // the URL via document.baseURI so first-time clients hit
    // /api/vault/:sid/service_worker.js (which maps to root after both
    // prefix-strips and works), but browsers with a stale ServiceWorker
    // scope from a pre-rewrite session, or any future SB build that
    // changes the URL composition, can still arrive at /.client/...
    // Map both shapes to the canonical root path so the JS bundle is
    // always served with the correct MIME.
    if (upstreamPath === '/.client/service_worker.js') {
      upstreamPath = '/service_worker.js';
    } else if (
      upstreamPath !== '/service_worker.js'
      && upstreamPath.endsWith('/service_worker.js')
    ) {
      // Future SilverBullet build emitted a service-worker URL the proxy
      // does not recognise. Log so a version-bump regression surfaces in
      // structured logs instead of as a user-reported white-screen.
      log('warn', 'Vault service worker path unexpected shape', { upstreamPath });
    }
    const search = (req.url ?? '').includes('?') ? '?' + (req.url ?? '').split('?').slice(1).join('?') : '';
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      // Hop-by-hop headers and any auth we injected for the container
      // boundary must NOT be forwarded to the in-container app.
      if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding'
        || lk === 'upgrade' || lk === 'proxy-authenticate' || lk === 'proxy-authorization'
        || lk === 'te' || lk === 'trailer' || lk === 'authorization' || lk === 'host') continue;
      if (v !== undefined) headers[k] = v as string | string[];
    }
    const upstreamReq = http.request({
      host: SILVERBULLET_HOST,
      port: SILVERBULLET_PORT,
      method,
      path: upstreamPath + search,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', (err) => {
      log('warn', 'Vault proxy upstream error', { error: err.message, path: upstreamPath });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Vault editor unreachable', code: 'VAULT_UPSTREAM_UNREACHABLE' }));
      } else {
        res.end();
      }
    });
    req.pipe(upstreamReq);
    return;
  }

  // 404 for unknown paths
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Create WebSocket server.
//
// We deliberately use `noServer: true` (not the `{server, path}` form): when
// the `ws` library is given a `server` it attaches its own internal
// 'upgrade' listener that unconditionally calls handleUpgrade for every
// upgrade and `abortHandshake(socket, 400)` on path mismatch — which
// would destroy `/vault/*` upgrades before the vault WSS could claim
// them. Routing both /terminal and /vault from a single
// `server.on('upgrade')` below gives each WSS exclusive control over
// its own paths.
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const { query } = parseUrl(req.url ?? '', true);
  const sessionId = query.session as string | undefined;
  const isManualTab = query.manual === '1';
  const connectedAt = Date.now();

  // Reject early: port 8080 binds before R2 sync + .bashrc autostart writes.
  // If we accept now we'd spawn a fresh PTY with no autostart in .bashrc, and
  // the user would land in bare bash instead of their configured agent.
  // Close with 1013 (Try Again Later) so the client's reconnect logic retries
  // after a brief delay. Once the entrypoint touches the init-complete flag
  // and the pre-warm session is in the map, this gate opens.
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
  }, WS_KEEPALIVE_PING_MS);

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
    if (str.length < MAX_CONTROL_MSG_LENGTH && str.startsWith('{')) {
      try {
        const msg = JSON.parse(str) as Record<string, unknown>;

        // Validate type field AND correct field types before acting
        if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          if (msg.cols > 0 && msg.cols < 10000 && msg.rows > 0 && msg.rows < 10000) {
            session.resize(msg.cols as number, msg.rows as number);
          }
          return;
        }

        if (msg.type === 'data' && typeof msg.data === 'string') {
          session.write(msg.data as string);
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

// Vault WebSocket proxy → SilverBullet at SILVERBULLET_HOST:SILVERBULLET_PORT.
//
// SilverBullet uses WS for live-edit sync; the path is whatever the
// SilverBullet client picks (e.g. `/.client/ws`). We route /vault/* via
// `noServer: true` and proxy to upstream below.
const vaultWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

// Single upgrade dispatcher for the whole server. Both `wss` (terminal)
// and `vaultWss` (vault) use noServer:true; this listener inspects the
// upgrade URL and routes to the correct WSS. Unknown paths get the
// socket destroyed cleanly (HTTP 400) so misrouted clients fail fast.
server.on('upgrade', (req, socket, head) => {
  const { pathname } = parseUrl(req.url ?? '');

  if (pathname === '/terminal') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }

  if (pathname && (pathname === '/vault' || pathname.startsWith('/vault/'))) {
    handleVaultUpgrade(req, socket, head);
    return;
  }

  // Unknown WS path. Refuse cleanly so the client sees a proper
  // handshake failure rather than hanging.
  socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
  socket.destroy();
});

function handleVaultUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
  const { pathname } = parseUrl(req.url ?? '');
  // Strip the `/vault` prefix; the worker already stripped its own
  // `/api/vault/:sid` prefix. SilverBullet sees its native WS path.
  const upstreamPath = (pathname ?? '/vault').slice('/vault'.length) || '/';
  const search = (req.url ?? '').includes('?')
    ? '?' + (req.url ?? '').split('?').slice(1).join('?')
    : '';

  vaultWss.handleUpgrade(req, socket, head, (clientWs) => {
    const upstreamUrl = `ws://${SILVERBULLET_HOST}:${SILVERBULLET_PORT}${upstreamPath}${search}`;
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(upstreamUrl, {
        headers: {
          // Forward any client headers SilverBullet wants to inspect
          // (cookie, X-Forwarded-For). Drop hop-by-hop headers — the
          // `ws` client sets those itself.
          ...Object.fromEntries(
            Object.entries(req.headers).filter(([k]) => {
              const lk = k.toLowerCase();
              return lk !== 'connection' && lk !== 'upgrade'
                && lk !== 'sec-websocket-key' && lk !== 'sec-websocket-version'
                && lk !== 'sec-websocket-extensions' && lk !== 'sec-websocket-protocol'
                && lk !== 'authorization' && lk !== 'host';
            }),
          ) as Record<string, string>,
        },
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

// Pre-warm state (module-level so /health endpoint can read prewarmReady)
let prewarmReady = false;
let prewarmStartTime = 0;
// True after waitForInitFlag observes the flag file. Stays false if the
// 130s timeout fallback fires instead (entrypoint hung). Exposed via
// /health for production debugging: an `initFlagObserved=false`
// combined with `terminalServiceReady=true` means the host server is
// serving traffic from the timeout-fallback path (image-default state,
// not user-restored). `initFlagObserved=false` + `terminalServiceReady=false`
// is the cold-start warm-up window — normal and transient.
let initFlagObserved = false;
// True after the init flag is observed AND the pre-warm session is in the
// session map. Until then, /terminal WS upgrades are rejected with 1013 so
// the user's reconnect storm doesn't get a fresh PTY spawned against pre-sync
// state (no .claude.json yet, no .bashrc autostart yet — which would land
// the user in bare bash instead of their configured agent).
let terminalServiceReady = false;

const parsedTabConfig: TabConfigEntry[] = (() => {
  try { return JSON.parse(process.env.TAB_CONFIG ?? '[]') as TabConfigEntry[]; } catch { return []; }
})();
const prewarmConfig = getPrewarmConfig(parsedTabConfig);
const PREWARM_TIMEOUT_MS = 20000;     // Hard cap: consider ready after 20s regardless
const PREWARM_ORPHAN_MS = 120000;     // Kill pre-warmed session if not adopted within 2min
// Init-flag wait must exceed entrypoint's SYNC_TIMEOUT (120s in initial_sync_from_r2)
// + slack, so a legitimately-slow R2 sync never trips the fallback. If the
// entrypoint dies before writing the flag, the fallback releases pre-warm against
// image-default state (intentional — fail-open keeps the terminal reachable).
const PREWARM_INIT_WAIT_MS = 130000;
const PREWARM_INIT_POLL_MS = 250;

// Wait for the entrypoint to write its init-complete flag file before pre-warming.
// Allows the entrypoint to start the HTTP server early (so port 8080 binds inside
// Cloudflare's container port-wait window) without spawning the tab-1 PTY before
// the user's R2-restored state (.claude.json, .bashrc, MCP server registrations)
// is in place. On R2-sync failure or no-R2-credentials the entrypoint still writes
// the flag — pre-warm then runs against image-default state, which is intentional
// (a half-restored terminal is more useful than no terminal).
// No-ops in tests and dev mode where CODEFLARE_INIT_FLAG_FILE is unset.
function waitForInitFlag(): Promise<void> {
  const flagPath = process.env.CODEFLARE_INIT_FLAG_FILE;
  if (!flagPath) return Promise.resolve();
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      if (fs.existsSync(flagPath)) {
        initFlagObserved = true;
        log('info', 'Init-complete flag observed, starting pre-warm', { flagPath, waitedMs: Date.now() - start });
        resolve();
        return;
      }
      if (Date.now() - start >= PREWARM_INIT_WAIT_MS) {
        log('warn', 'Init-complete flag not seen within timeout, starting pre-warm anyway', { flagPath, timeoutMs: PREWARM_INIT_WAIT_MS });
        resolve();
        return;
      }
      setTimeout(tick, PREWARM_INIT_POLL_MS);
    };
    tick();
  });
}

// Start server
server.listen(PORT, '0.0.0.0', async () => {
  log('info', 'Terminal server listening', { port: PORT });
  log('info', 'Workspace config', { workspace: WORKSPACE_DEFAULT, workingDir: getWorkingDirectory(), keepAliveSec: PTY_KEEPALIVE_MS / 1000 });

  // Start periodic cleanup of dead sessions
  sessionManager.startCleanup();

  await waitForInitFlag();

  // Pre-warm tab 1 PTY so the first client connect is instant
  const prewarmSession = new Session(state.prewarmSessionId, 'Terminal', false, state.sessionOptions);
  sessionManager.sessions.set(state.prewarmSessionId, prewarmSession);
  prewarmSession.start();
  // Open the /terminal WS gate AFTER prewarm.start() returns so any client
  // that gets through finds a Session with ptyProcess already spawned (no
  // TOCTOU window where adoption races against the PTY fork). Fresh
  // (non-tab-1) sessions created from here on also read the final .bashrc
  // because waitForInitFlag has already resolved.
  terminalServiceReady = true;
  prewarmStartTime = Date.now();
  log('info', 'Pre-warming tab 1 PTY', { command: prewarmConfig.command, ptyAlive: prewarmSession.ptyProcess !== null, ptyPid: prewarmSession.ptyProcess?.pid ?? null });

  // Readiness = first PTY output + 1.5s settle delay.
  // The delay lets the agent render its initial UI before the user can click "Open".
  const PREWARM_SETTLE_MS = 1500;
  let prewarmDataListener: { dispose(): void } | null = null;
  if (prewarmSession.ptyProcess) {
    prewarmDataListener = prewarmSession.ptyProcess.onData((data: string) => {
      if (!prewarmReady) {
        const elapsed = Date.now() - prewarmStartTime;
        log('info', 'Pre-warm first output detected, settling', {
          elapsedSec: (elapsed / 1000).toFixed(1),
          command: prewarmConfig.command,
          firstChars: data.substring(0, 80).replace(/[\x00-\x1f]/g, '?'),
          bytesLen: data.length,
        });
        if (prewarmDataListener) {
          prewarmDataListener.dispose();
          prewarmDataListener = null;
        }
        setTimeout(() => {
          if (!prewarmReady) {
            prewarmReady = true;
            log('info', 'Pre-warm ready (settled)', { elapsedSec: ((Date.now() - prewarmStartTime) / 1000).toFixed(1) });
          }
        }, PREWARM_SETTLE_MS);
      }
    });
  } else {
    log('warn', 'Pre-warm: ptyProcess is null after start(), relying on timeout only');
  }

  // Hard timeout safety net (20s) — in case PTY produces no output at all
  setTimeout(() => {
    if (!prewarmReady) {
      prewarmReady = true;
      log('info', 'Pre-warm ready (timeout)', { elapsedSec: (PREWARM_TIMEOUT_MS / 1000).toFixed(1), command: prewarmConfig.command });
      if (prewarmDataListener) {
        prewarmDataListener.dispose();
        prewarmDataListener = null;
      }
    }
  }, PREWARM_TIMEOUT_MS);

  prewarmSession.orphanTimeout = setTimeout(() => {
    if (sessionManager.sessions.has(state.prewarmSessionId)) {
      log('warn', 'Pre-warm session expired without adoption, killing');
      sessionManager.delete(state.prewarmSessionId);
      prewarmReady = true;
    }
  }, PREWARM_ORPHAN_MS);
});

// Graceful shutdown helper
function shutdown(signal: string): void {
  log('info', `Received ${signal}, shutting down`);
  // M2: Kill all active sessions before exit to avoid orphaned PTY processes
  sessionManager.killAll();
  sessionManager.stopCleanup();
  wss.close();
  vaultWss.close();
  server.close();
  process.exit(0);
}

// Handle shutdown
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
