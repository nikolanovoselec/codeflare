/**
 * Codeflare Terminal Server
 *
 * WebSocket server that manages multiple PTY sessions.
 * One container serves multiple sessions (terminal tabs).
 *
 * Endpoints:
 * - WS /terminal?session=<id> - Connect to terminal session
 * - GET /health - Health check
 * - GET /sessions - List active sessions
 * - POST /sessions - Create new session
 * - DELETE /sessions/:id - Delete session
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import pty from 'node-pty';
import { parse as parseUrl } from 'url';
import { parse as parseQuery } from 'querystring';
import fs from 'fs';
import { createActivityTracker } from './activity-tracker.js';
import { getPrewarmConfig } from './prewarm-config.js';

const PROCESS_NAME_POLL_MS = 2000;
const WS_KEEPALIVE_PING_MS = 30000;
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import HeadlessPkg from '@xterm/headless';
const { Terminal: HeadlessTerminal } = HeadlessPkg;
import SerializePkg from '@xterm/addon-serialize';
const { SerializeAddon } = SerializePkg;

const execFileAsync = promisify(execFile);

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

// Helper to get sync status from /tmp/sync-status.json
function getSyncStatus() {
  try {
    const data = fs.readFileSync('/tmp/sync-status.json', 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { status: 'pending', error: null, userPath: null };
  }
}

// Cached disk metrics to avoid shelling out on every health check
let cachedDiskMetrics = { value: '...', lastUpdated: 0 };
const DISK_CACHE_TTL = 30000; // 30 seconds

async function getDiskMetrics() {
  if (Date.now() - cachedDiskMetrics.lastUpdated < DISK_CACHE_TTL) {
    return cachedDiskMetrics.value;
  }
  try {
    const { stdout } = await execFileAsync('df', ['-h', '/home/user']);
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const fields = lines[1].split(/\s+/);
      cachedDiskMetrics = { value: `${fields[2]}/${fields[1]}`, lastUpdated: Date.now() };
    }
  } catch (e) { log('debug', 'Disk metrics fetch failed', { error: e.message }); }
  return cachedDiskMetrics.value;
}

// Helper to get system metrics (CPU, MEM, HDD)
async function getSystemMetrics() {
  const metrics = { cpu: '...', mem: '...', hdd: '...' };
  try {
    const loadAvg = os.loadavg()[0];
    const cpus = os.cpus().length;
    metrics.cpu = ((loadAvg / cpus) * 100).toFixed(0) + '%';
  } catch (e) { log('debug', 'CPU metrics fetch failed', { error: e.message }); }
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const usedGB = (usedMem / 1024 / 1024 / 1024).toFixed(1);
    const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(1);
    metrics.mem = usedGB + '/' + totalGB + 'G';
  } catch (e) { log('debug', 'Memory metrics fetch failed', { error: e.message }); }
  metrics.hdd = await getDiskMetrics();
  return metrics;
}

const PORT = process.env.TERMINAL_PORT || 8080;
// Spawn a login shell so .bashrc runs and auto-starts Claude
// The .bashrc has claude auto-start logic that only works in interactive login shells
const TERMINAL_COMMAND = process.env.TERMINAL_COMMAND || '/bin/bash';
const TERMINAL_ARGS = process.env.TERMINAL_ARGS || '-l';  // Login shell flag
const WORKSPACE_DEFAULT = process.env.WORKSPACE || '/home/user/workspace';

// PTY persistence settings
const PTY_KEEPALIVE_MS = parseInt(process.env.PTY_KEEPALIVE_MS || '2700000', 10); // 45 minutes
const PTY_CLEANUP_INTERVAL_MS = parseInt(process.env.PTY_CLEANUP_INTERVAL_MS || '60000', 10); // Check every minute

// Session limits
const MAX_SESSIONS = 20;

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

/**
 * Session represents a PTY terminal instance
 */
class Session {
  constructor(id, name = 'Terminal', manual = false) {
    this.id = id;
    this.name = name;
    this.manual = manual;
    this.ptyProcess = null;
    this.clients = new Set(); // WebSocket clients attached to this session
    this.headlessTerminal = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
    this.serializeAddon = new SerializeAddon();
    this.headlessTerminal.loadAddon(this.serializeAddon);
    this.createdAt = new Date().toISOString();
    this.lastAccessedAt = this.createdAt;
    this.disconnectedAt = null; // Timestamp when last client disconnected
    this.keepAliveTimeout = null; // Timer for PTY cleanup after disconnect
    this.lastProcessName = null; // Track PTY foreground process name
    this.processNameInterval = null; // Interval for polling process name changes
    this.lastDataTime = 0; // Timestamp of last PTY data output (for pre-warm quiescence detection)
    this.orphanTimeout = null; // Timer for killing pre-warmed sessions not adopted by a client
  }

  /**
   * Get the terminal ID from the compound session ID (e.g., "abc123-2" -> "2")
   */
  get terminalId() {
    const parts = this.id.split('-');
    return parts[parts.length - 1];
  }

  /**
   * Resolve the display name for the foreground process.
   * When ptyProcess.process returns a generic name like "node" (because
   * Node.js-based tools report "node" as the OS process), fall back to
   * the configured command from TAB_CONFIG.
   */
  resolveProcessName() {
    const rawName = this.ptyProcess ? this.ptyProcess.process : null;
    if (!rawName) return null;

    // If raw name is generic (shell or node runtime), prefer the configured command
    const configuredCmd = tabConfigMap[this.terminalId];
    if (configuredCmd) {
      const baseName = rawName.split('/').pop(); // "/bin/bash" -> "bash"
      if (['node', 'nodejs', 'bash', 'sh', 'zsh'].includes(baseName)) {
        return configuredCmd.split(/\s+/)[0];
      }
    }

    // Strip path prefix for display ("/bin/bash" -> "bash")
    return rawName.split('/').pop() || rawName;
  }

  /**
   * Start the PTY process
   */
  start(cols = 80, rows = 24) {
    if (this.ptyProcess) {
      return; // Already started
    }

    // Parse command (support both "cmd arg1 arg2" format and separate TERMINAL_ARGS)
    const [cmd, ...cmdArgs] = TERMINAL_COMMAND.split(' ');
    // Combine with TERMINAL_ARGS if set (for login shell -l flag)
    const extraArgs = TERMINAL_ARGS ? TERMINAL_ARGS.split(' ').filter(a => a) : [];
    const args = [...cmdArgs, ...extraArgs];

    log('info', 'Spawning PTY', { session: this.id.substring(0, 8), cmd, args });

    // Get working directory at spawn time (may change if R2 mounts later)
    const cwd = getWorkingDirectory();

    // Extract terminal ID from compound session ID (e.g., "abc123-2" -> "2")
    const terminalId = this.id.includes('-') ? this.id.split('-').pop() : '1';

    const ptyEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      HOME: process.env.HOME || '/root',
      TERMINAL_ID: terminalId,
    };
    // User-created tabs ("+") get MANUAL_TAB=1 so .bashrc skips autostart
    if (this.manual) {
      ptyEnv.MANUAL_TAB = '1';
    }

    this.ptyProcess = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: ptyEnv,
    });

    this.ptyProcess.onData((data) => {
      this.lastDataTime = Date.now();

      // Feed data into headless terminal for state tracking
      this.headlessTerminal.write(data);

      // Broadcast to all connected clients - send RAW data (xterm expects raw bytes)
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);  // Raw terminal data, NOT JSON wrapped
        }
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      log('info', 'PTY exited', { session: this.id, exitCode, signal, connectedClients: this.clients.size });
      logWsEvent(this.id, 'pty_exit', { exitCode, signal, connectedClients: this.clients.size });
      // Notify clients with exit message as terminal output
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(`\r\n[Process exited with code ${exitCode}]\r\n`);
        }
      }
      this.ptyProcess = null;
      // Clear process name tracking when PTY exits
      if (this.processNameInterval) {
        clearInterval(this.processNameInterval);
        this.processNameInterval = null;
      }
      this.lastProcessName = null;
    });

    // Track PTY foreground process name changes (poll every 2s)
    // Use resolveProcessName() to get the display name (handles "node" -> actual tool name)
    this.lastProcessName = this.resolveProcessName();
    this.processNameInterval = setInterval(() => {
      if (!this.ptyProcess) {
        clearInterval(this.processNameInterval);
        this.processNameInterval = null;
        return;
      }
      const processName = this.resolveProcessName();
      if (processName !== this.lastProcessName) {
        this.lastProcessName = processName;
        const msg = JSON.stringify({ type: 'process-name', terminalId: this.id, processName });
        for (const client of this.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
          }
        }
      }
    }, PROCESS_NAME_POLL_MS);

    log('info', 'PTY started', { session: this.id.substring(0, 8), pid: this.ptyProcess.pid });
  }

  /**
   * Attach a WebSocket client to this session
   */
  attach(ws) {
    this.clients.add(ws);
    this.lastAccessedAt = new Date().toISOString();
    activityTracker.recordClientConnected();

    // Cancel any pending keepalive timeout since we have a client again
    if (this.keepAliveTimeout) {
      clearTimeout(this.keepAliveTimeout);
      this.keepAliveTimeout = null;
      log('info', 'Reconnected, cancelled keepalive timeout', { session: this.id.substring(0, 8) });
    }
    this.disconnectedAt = null;

    // Start PTY if not already running
    if (!this.ptyProcess) {
      this.start();
    }

    // Send serialized terminal state for reconnection
    const state = this.serializeAddon.serialize();
    if (state) {
      ws.send(JSON.stringify({ type: 'restore', state }));
    }

    // Send current process name to new client so tab label is correct immediately
    if (this.lastProcessName) {
      ws.send(JSON.stringify({ type: 'process-name', terminalId: this.id, processName: this.lastProcessName }));
    }

    log('info', 'Client attached', { session: this.id.substring(0, 8), totalClients: this.clients.size });
  }

  /**
   * Detach a WebSocket client from this session
   * @param {SessionManager} sessionManager - Reference to session manager for cleanup
   */
  detach(ws, sessionManager = null) {
    this.clients.delete(ws);
    log('info', 'Client detached', { session: this.id.substring(0, 8), totalClients: this.clients.size });

    // Track global disconnect for idle detection
    if (sessionManager && sessionManager.clients.size === 0) {
      activityTracker.recordAllClientsDisconnected();
    }

    // If no more clients and PTY is still running, start keepalive timer
    if (this.clients.size === 0 && this.ptyProcess) {
      this.disconnectedAt = new Date().toISOString();
      log('info', 'No clients remaining, PTY kept alive', { session: this.id.substring(0, 8), keepAliveSec: PTY_KEEPALIVE_MS / 1000 });

      // Set timeout to kill PTY if no reconnection
      this.keepAliveTimeout = setTimeout(() => {
        if (this.clients.size === 0 && this.ptyProcess) {
          log('info', 'Keepalive timeout expired, killing PTY', { session: this.id.substring(0, 8) });
          this.kill();
          // Optionally remove from session manager
          if (sessionManager) {
            sessionManager.sessions.delete(this.id);
            log('info', 'Removed orphaned session', { session: this.id });
          }
        }
      }, PTY_KEEPALIVE_MS);
    }
  }

  /**
   * Write data to the PTY
   */
  write(data) {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  /**
   * Resize the PTY
   */
  resize(cols, rows) {
    if (this.ptyProcess) {
      this.ptyProcess.resize(cols, rows);
    }
    this.headlessTerminal.resize(cols, rows);
  }

  /**
   * Kill the PTY process
   */
  kill() {
    // Clear any keepalive timeout
    if (this.keepAliveTimeout) {
      clearTimeout(this.keepAliveTimeout);
      this.keepAliveTimeout = null;
    }

    // Clear process name tracking interval
    if (this.processNameInterval) {
      clearInterval(this.processNameInterval);
      this.processNameInterval = null;
    }
    this.lastProcessName = null;

    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }
    // Clean up headless terminal
    this.headlessTerminal.dispose();
    // Close all clients
    for (const client of this.clients) {
      client.close(1000, 'Session terminated');
    }
    this.clients.clear();
    this.disconnectedAt = null;
    log('info', 'Session killed', { session: this.id });
  }

  /**
   * Check if session is alive (has PTY or clients)
   */
  isAlive() {
    return this.ptyProcess !== null || this.clients.size > 0;
  }

  /**
   * Check if PTY process is still running
   */
  isPtyAlive() {
    return this.ptyProcess !== null;
  }

  /**
   * Get session info
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      pid: this.ptyProcess?.pid || null,
      clients: this.clients.size,
      createdAt: this.createdAt,
      lastAccessedAt: this.lastAccessedAt,
      disconnectedAt: this.disconnectedAt,
      ptyAlive: this.isPtyAlive(),
    };
  }
}

/**
 * SessionManager handles all PTY sessions
 */
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.cleanupInterval = null;
  }

  /**
   * Start periodic cleanup of dead sessions
   */
  startCleanup() {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      this.cleanupDeadSessions();
    }, PTY_CLEANUP_INTERVAL_MS);

    log('info', 'Started cleanup interval', { intervalSec: PTY_CLEANUP_INTERVAL_MS / 1000 });
  }

  /**
   * Stop periodic cleanup
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Clean up sessions that have no clients and no PTY
   */
  cleanupDeadSessions() {
    const toDelete = [];
    for (const [id, session] of this.sessions) {
      // Remove sessions that have no PTY and no clients
      if (!session.isPtyAlive() && session.clients.size === 0) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.sessions.delete(id);
      log('info', 'Cleaned up dead session', { session: id });
    }

    if (toDelete.length > 0) {
      log('info', 'Dead sessions cleanup complete', { cleaned: toDelete.length, active: this.sessions.size });
    }
  }

  /**
   * Get or create a session
   */
  getOrCreate(id, name, manual = false) {
    let session = this.sessions.get(id);

    if (session) {
      // Session exists - check if PTY is still alive
      if (session.isPtyAlive()) {
        log('info', 'Reattaching to existing session', { session: id, pid: session.ptyProcess?.pid });
      } else {
        log('info', 'Session exists but PTY is dead, will restart on attach', { session: id });
      }
    } else {
      // Check for pre-warmed session to adopt (tab 1 only)
      const terminalId = id.includes('-') ? id.split('-').pop() : '1';
      if (terminalId === '1') {
        const prewarmed = this.sessions.get('prewarm-1');
        if (prewarmed && this.sessions.delete('prewarm-1')) {
          prewarmed.id = id;
          if (prewarmed.orphanTimeout) {
            clearTimeout(prewarmed.orphanTimeout);
            prewarmed.orphanTimeout = null;
          }
          this.sessions.set(id, prewarmed);
          prewarmReady = true; // Stop readiness check interval
          log('info', 'Adopted pre-warmed session', { session: id });
          return prewarmed;
        }
      }

      // Add session cap check (exclude prewarm sessions from count)
      const activeCount = Array.from(this.sessions.keys()).filter(k => !k.startsWith('prewarm-')).length;
      if (activeCount >= MAX_SESSIONS) {
        return null; // Caller must handle null
      }
      // Create new session
      session = new Session(id, name, manual);
      this.sessions.set(id, session);
      log('info', 'Created new session', { session: id });
    }

    return session;
  }

  /**
   * Get a session by ID
   */
  get(id) {
    return this.sessions.get(id);
  }

  /**
   * Delete a session
   */
  delete(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      this.sessions.delete(id);
      log('info', 'Deleted session', { session: id });
      return true;
    }
    return false;
  }

  /**
   * List all sessions
   */
  list() {
    return Array.from(this.sessions.values()).map((s) => s.toJSON());
  }

  /**
   * Get a Map of all connected WebSocket clients across all sessions.
   * Used by activityTracker.getActivityInfo() to determine hasActiveConnections.
   */
  get clients() {
    const allClients = new Map();
    let idx = 0;
    for (const session of this.sessions.values()) {
      for (const ws of session.clients) {
        allClients.set(`${session.id}-${idx++}`, ws);
      }
    }
    return allClients;
  }

  /**
   * Get session count
   */
  get size() {
    return this.sessions.size;
  }
}

// Initialize session manager
const sessionManager = new SessionManager();

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const { pathname } = parseUrl(req.url);
  const method = req.method;

  // Validate container auth token (internal-only service, no CORS needed)
  const expectedToken = process.env.CONTAINER_AUTH_TOKEN;
  if (expectedToken) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // Health check with full metrics (consolidates separate health server)
  if (pathname === '/health' && method === 'GET') {
    const syncInfo = getSyncStatus();
    const sysMetrics = await getSystemMetrics();

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
      let log;
      if (stat.size > MAX_LOG_SIZE) {
        // Read only the last 100KB
        const buffer = Buffer.alloc(MAX_LOG_SIZE);
        const fd = fs.openSync('/tmp/sync.log', 'r');
        fs.readSync(fd, buffer, 0, MAX_LOG_SIZE, stat.size - MAX_LOG_SIZE);
        fs.closeSync(fd);
        log = '... (truncated)\n' + buffer.toString('utf8');
      } else {
        log = fs.readFileSync('/tmp/sync.log', 'utf8');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ log }));
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
  // RAW data goes directly to PTY, JSON only for control messages (resize, ping)
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

        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
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

// Agent-aware quiescence: TUI agents (OpenCode, Gemini, Codex) get 500ms instead of 2000ms
// because their busy startup spinners keep resetting the default 2s quiescence timer.
const parsedTabConfig = (() => {
  try { return JSON.parse(process.env.TAB_CONFIG || '[]'); } catch { return []; }
})();
const prewarmConfig = getPrewarmConfig(parsedTabConfig);
const PREWARM_QUIESCENCE_MS = prewarmConfig.quiescenceMs;
const PREWARM_READY_PATTERN = prewarmConfig.readyPattern;
const PREWARM_TIMEOUT_MS = 20000;     // Hard cap: consider ready after 20s regardless
const PREWARM_ORPHAN_MS = 120000;     // Kill pre-warmed session if not adopted within 2min

// Start server
server.listen(PORT, '0.0.0.0', () => {
  log('info', 'Terminal server listening', { port: PORT });
  log('info', 'Workspace config', { workspace: WORKSPACE_DEFAULT, workingDir: getWorkingDirectory(), keepAliveSec: PTY_KEEPALIVE_MS / 1000 });

  // Start periodic cleanup of dead sessions
  sessionManager.startCleanup();

  // Pre-warm tab 1 PTY so the first client connect is instant
  const prewarmSession = new Session('prewarm-1', 'Terminal');
  sessionManager.sessions.set('prewarm-1', prewarmSession);
  prewarmSession.start();
  prewarmStartTime = Date.now();
  log('info', 'Pre-warming tab 1 PTY', { quiescenceMs: PREWARM_QUIESCENCE_MS, hasReadyPattern: !!PREWARM_READY_PATTERN });

  // If a ready-pattern is configured, listen for it on PTY output
  let prewarmDataListener = null;
  if (PREWARM_READY_PATTERN && prewarmSession.ptyProcess) {
    prewarmDataListener = prewarmSession.ptyProcess.onData((data) => {
      if (!prewarmReady && PREWARM_READY_PATTERN.test(data)) {
        prewarmReady = true;
        const elapsed = Date.now() - prewarmStartTime;
        log('info', 'Pre-warm ready (pattern match)', { elapsedSec: (elapsed / 1000).toFixed(1) });
      }
    });
  }

  const readinessCheck = setInterval(() => {
    if (prewarmReady) {
      clearInterval(readinessCheck);
      if (prewarmDataListener) prewarmDataListener.dispose();
      return;
    }
    const elapsed = Date.now() - prewarmStartTime;
    const lastData = prewarmSession.lastDataTime || prewarmStartTime; // Fallback to start time if no output yet
    const silent = Date.now() - lastData;
    if (elapsed >= PREWARM_QUIESCENCE_MS && silent >= PREWARM_QUIESCENCE_MS) {
      prewarmReady = true;
      log('info', 'Pre-warm ready (quiescent)', { elapsedSec: (elapsed / 1000).toFixed(1) });
      clearInterval(readinessCheck);
      if (prewarmDataListener) prewarmDataListener.dispose();
      return;
    }
    if (elapsed >= PREWARM_TIMEOUT_MS) {
      prewarmReady = true;
      log('info', 'Pre-warm ready (timeout)', { elapsedSec: (elapsed / 1000).toFixed(1) });
      clearInterval(readinessCheck);
      if (prewarmDataListener) prewarmDataListener.dispose();
    }
  }, 500);

  prewarmSession.orphanTimeout = setTimeout(() => {
    if (sessionManager.sessions.has('prewarm-1')) {
      log('warn', 'Pre-warm session expired without adoption, killing');
      sessionManager.delete('prewarm-1');
      prewarmReady = true;
    }
  }, PREWARM_ORPHAN_MS);
});

// Handle shutdown
process.on('SIGTERM', () => {
  log('info', 'Received SIGTERM, shutting down');
  sessionManager.stopCleanup();
  wss.close();
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'Received SIGINT, shutting down');
  sessionManager.stopCleanup();
  wss.close();
  server.close();
  process.exit(0);
});
