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

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { createActivityTracker } from './activity-tracker.js';
import { getPrewarmConfig } from './prewarm-config.js';
import { getSyncStatus, getSystemMetrics } from './metrics.js';
import { Session } from './session.js';
import { SessionManager, PREWARM_SESSION_ID } from './session-manager.js';

const WS_KEEPALIVE_PING_MS = 30000;

// Structured logger — replaces raw console.log/console.error calls
function log(level, msg, meta) {
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
}

// Start time for uptime calculation
const SERVER_START_TIME = Date.now();

const PORT = process.env.TERMINAL_PORT || 8080;
// Spawn a login shell so .bashrc runs and auto-starts the configured agent
// The .bashrc has agent auto-start logic that only works in interactive login shells
const TERMINAL_COMMAND = process.env.TERMINAL_COMMAND || '/bin/bash';
const TERMINAL_ARGS = process.env.TERMINAL_ARGS || '-l';  // Login shell flag
const WORKSPACE_DEFAULT = process.env.WORKSPACE || '/home/user/workspace';

// PTY persistence settings
const PTY_KEEPALIVE_MS = parseInt(process.env.PTY_KEEPALIVE_MS || '2700000', 10); // 45 minutes
const PTY_CLEANUP_INTERVAL_MS = parseInt(process.env.PTY_CLEANUP_INTERVAL_MS || '60000', 10); // Check every minute

// Named constants for magic numbers
const WS_MAX_PAYLOAD = 64 * 1024;        // 64KB WebSocket max payload
const MAX_CONTROL_MSG_LENGTH = 200;       // Max length for JSON control message detection

// Parse TAB_CONFIG for expected process names per terminal tab
// TAB_CONFIG is set by the Container DO before container start
let tabConfigMap = {};
try {
  const tabConfig = JSON.parse(process.env.TAB_CONFIG || '[]');
  for (const tab of tabConfig) {
    if (tab.command) {
      tabConfigMap[tab.id] = tab.command;
    }
  }
} catch {
  // Ignore parse errors, fall back to ptyProcess.process
}

// Determine actual working directory - fall back if WORKSPACE doesn't exist
// This handles the case where R2 mount fails or hasn't completed yet
let cachedWorkingDir = null;
function getWorkingDirectory() {
  if (cachedWorkingDir) return cachedWorkingDir;
  if (fs.existsSync(WORKSPACE_DEFAULT)) {
    cachedWorkingDir = WORKSPACE_DEFAULT;
    return cachedWorkingDir;
  }
  // Fall back to HOME or /tmp if workspace doesn't exist
  const fallback = process.env.HOME || '/tmp';
  log('warn', 'Workspace not found, falling back', { workspace: WORKSPACE_DEFAULT, fallback });
  cachedWorkingDir = fallback;
  return cachedWorkingDir;
}

// Ring buffer for recent WebSocket events (for debugging disconnects)
const WS_EVENT_BUFFER_SIZE = 100;
const wsEventLog = [];
function logWsEvent(sessionId, type, details) {
  const event = {
    ts: new Date().toISOString(),
    session: sessionId.substring(0, 8),
    type,
    ...details,
  };
  wsEventLog.push(event);
  if (wsEventLog.length > WS_EVENT_BUFFER_SIZE) {
    wsEventLog.shift();
  }
}

// Activity tracking for smart hibernation (WebSocket disconnect tracking)
const activityTracker = createActivityTracker();

// Shared options for Session and SessionManager
const sessionOptions = {
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

// Initialize session manager
const sessionManager = new SessionManager(sessionOptions);

/**
 * Timing-safe comparison of bearer tokens.
 * Uses crypto.timingSafeEqual to prevent timing side-channel attacks.
 * @param {string} provided - The token from the Authorization header
 * @param {string} expected - The expected CONTAINER_AUTH_TOKEN
 * @returns {boolean}
 */
function safeTokenCompare(provided, expected) {
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const { pathname } = parseUrl(req.url);
  const method = req.method;

  // Internal endpoints exempt from auth — used by DO schedule-based callbacks
  // (collectMetrics, onActivityExpired) via getTcpPort().fetch() which bypasses
  // the DO's fetch() override that injects auth headers.
  // These endpoints are behind the container network boundary (no external access).
  const authExemptPaths = new Set(['/health', '/activity']);
  if (!authExemptPaths.has(pathname)) {
    // Validate container auth token (internal-only service, no CORS needed)
    const expectedToken = process.env.CONTAINER_AUTH_TOKEN;
    if (!expectedToken) {
      // L17: When CONTAINER_AUTH_TOKEN is not set, return 503 (server not ready)
      // rather than silently skipping auth, which would leave all endpoints unprotected
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server not configured (missing auth token)' }));
      return;
    }
    const authHeader = req.headers['authorization'];
    const providedToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    // L18: Use timing-safe comparison to prevent timing side-channel attacks
    if (!providedToken || !safeTokenCompare(providedToken, expectedToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
    res.end(JSON.stringify({ events: wsEventLog }));
    return;
  }

  // Activity endpoint for smart hibernation (WS connection-based)
  if (pathname === '/activity' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(activityTracker.getActivityInfo(sessionManager)));
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
    req.on('data', (chunk) => {
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
        const { id, name } = JSON.parse(body || '{}');
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session ID required' }));
          return;
        }

        const session = sessionManager.getOrCreate(id, name || 'Terminal');
        if (!session) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session limit reached' }));
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session: session.toJSON() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Delete session
  const deleteMatch = pathname.match(/^\/sessions\/([^\/]+)$/);
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

  // Sync log endpoint
  if (pathname === '/sync-log' && method === 'GET') {
    try {
      const MAX_LOG_SIZE = 100 * 1024; // 100KB
      const stat = fs.statSync('/tmp/sync.log');
      let logContent;
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

  // 404 for unknown paths
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Create WebSocket server
const wss = new WebSocketServer({ server, path: '/terminal', maxPayload: WS_MAX_PAYLOAD });

wss.on('connection', (ws, req) => {
  const { query } = parseUrl(req.url, true);
  const sessionId = query.session;
  const isManualTab = query.manual === '1';
  const connectedAt = Date.now();

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
  const name = (query.name || '').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 100) || 'Terminal';

  // Get or create session (pass manual flag for user-created tabs)
  const session = sessionManager.getOrCreate(sessionId, name, isManualTab);
  if (!session) {
    ws.close(1013, 'Session limit reached');
    return;
  }

  // Attach client to session
  session.attach(ws);

  log('info', 'WS connected', { session: shortId, ptyAlive: session.isPtyAlive(), ptyPid: session.ptyProcess?.pid || null, totalClients: session.clients.size });
  logWsEvent(sessionId, 'connect', { clients: session.clients.size, ptyAlive: session.isPtyAlive(), ptyPid: session.ptyProcess?.pid || null });

  // Handle incoming messages
  // RAW data goes directly to PTY, JSON only for control messages (resize)
  ws.on('message', (message) => {
    const str = message.toString();

    // Try to parse as JSON for known control messages only
    // Length-gated: control messages are small; skip parsing for large terminal input
    if (str.length < MAX_CONTROL_MSG_LENGTH && str.startsWith('{')) {
      try {
        const msg = JSON.parse(str);

        // Validate type field AND correct field types before acting
        if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          if (msg.cols > 0 && msg.cols < 10000 && msg.rows > 0 && msg.rows < 10000) {
            session.resize(msg.cols, msg.rows);
          }
          return;
        }

        if (msg.type === 'data' && typeof msg.data === 'string') {
          session.write(msg.data);
          return;
        }

        // Unknown type or wrong field types — fall through to raw input
      } catch {
        // Not valid JSON — treat as raw terminal input
      }
    }

    // Raw terminal input - write directly to PTY
    session.write(str);
  });

  // Handle client disconnect
  ws.on('close', (code, reason) => {
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
  ws.on('error', (err) => {
    const duration = Math.floor((Date.now() - connectedAt) / 1000);
    log('error', 'WS error', { session: shortId, message: err.message, errCode: err.code || null, durationSec: duration, ptyAlive: session.isPtyAlive() });
    logWsEvent(sessionId, 'error', { message: err.message, errCode: err.code || null, durationSec: duration, ptyAlive: session.isPtyAlive() });
    session.detach(ws, sessionManager);
  });

  // Connection ready - no JSON message, just start sending PTY data
});

// Pre-warm state (module-level so /health endpoint can read prewarmReady)
let prewarmReady = false;
let prewarmStartTime = 0;

const parsedTabConfig = (() => {
  try { return JSON.parse(process.env.TAB_CONFIG || '[]'); } catch { return []; }
})();
const prewarmConfig = getPrewarmConfig(parsedTabConfig);
const PREWARM_TIMEOUT_MS = 20000;     // Hard cap: consider ready after 20s regardless
const PREWARM_ORPHAN_MS = 120000;     // Kill pre-warmed session if not adopted within 2min

// Start server
server.listen(PORT, '0.0.0.0', () => {
  log('info', 'Terminal server listening', { port: PORT });
  log('info', 'Workspace config', { workspace: WORKSPACE_DEFAULT, workingDir: getWorkingDirectory(), keepAliveSec: PTY_KEEPALIVE_MS / 1000 });

  // Start periodic cleanup of dead sessions
  sessionManager.startCleanup();

  // Pre-warm tab 1 PTY so the first client connect is instant
  const prewarmSession = new Session(PREWARM_SESSION_ID, 'Terminal', false, sessionOptions);
  sessionManager.sessions.set(PREWARM_SESSION_ID, prewarmSession);
  prewarmSession.start();
  prewarmStartTime = Date.now();
  log('info', 'Pre-warming tab 1 PTY', { command: prewarmConfig.command });

  // Readiness = first PTY output + 1.5s settle delay.
  // The delay lets the agent render its initial UI before the user can click "Open".
  const PREWARM_SETTLE_MS = 1500;
  let prewarmDataListener = null;
  if (prewarmSession.ptyProcess) {
    prewarmDataListener = prewarmSession.ptyProcess.onData(() => {
      if (!prewarmReady) {
        const elapsed = Date.now() - prewarmStartTime;
        log('info', 'Pre-warm first output detected, settling', { elapsedSec: (elapsed / 1000).toFixed(1), command: prewarmConfig.command });
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
  }

  // Hard timeout safety net (20s) — in case PTY produces no output at all
  const timeoutId = setTimeout(() => {
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
    if (sessionManager.sessions.has(PREWARM_SESSION_ID)) {
      log('warn', 'Pre-warm session expired without adoption, killing');
      sessionManager.delete(PREWARM_SESSION_ID);
      prewarmReady = true;
    }
  }, PREWARM_ORPHAN_MS);
});

// Graceful shutdown helper
function shutdown(signal) {
  log('info', `Received ${signal}, shutting down`);
  // M2: Kill all active sessions before exit to avoid orphaned PTY processes
  sessionManager.killAll();
  sessionManager.stopCleanup();
  wss.close();
  server.close();
  process.exit(0);
}

// Handle shutdown
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
