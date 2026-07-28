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
 *
 * This file is the composition root (CF-014): it owns process lifecycle,
 * environment config, the mutable readiness flags, and the pre-warm
 * sequence. The HTTP branches live in request-router.ts, the /terminal WS
 * protocol in terminal-ws.ts, and the vault/vscode WS bridges + upgrade
 * routing in upgrade-dispatcher.ts — each importable in unit tests without
 * booting a listening server.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import { createActivityTracker } from './activity-tracker.js';
import { getPrewarmConfig } from './prewarm-config.js';
import { createRequestHandler, type ProxyTarget } from './request-router.js';
import { attachTerminalConnectionHandler } from './terminal-ws.js';
import { createUpgradeDispatcher } from './upgrade-dispatcher.js';
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
const PTY_KEEPALIVE_MS = parseInt(process.env.PTY_KEEPALIVE_MS ?? '14400000', 10); // 240 minutes (4h; == max sleepAfter, see AD47)
const PTY_CLEANUP_INTERVAL_MS = parseInt(process.env.PTY_CLEANUP_INTERVAL_MS ?? '60000', 10); // Check every minute

// Named constants for magic numbers
const WS_MAX_PAYLOAD = 64 * 1024;        // 64KB WebSocket max payload
const MAX_CONTROL_MSG_LENGTH = 200;       // Max length for JSON control message detection

// SilverBullet supervisor binds on 127.0.0.1:3030 inside the container
// (see entrypoint.sh:start_silverbullet_supervisor). The vault HTTP + WS
// branches proxy to it. Localhost-only by design — the auth boundary is
// the Worker proxy at /api/vault/:sid/.
const SILVERBULLET: ProxyTarget = {
  host: process.env.SILVERBULLET_HOST ?? '127.0.0.1',
  port: parseInt(process.env.SILVERBULLET_PORT ?? '3030', 10),
};

// The code-server supervisor binds on 127.0.0.1:13337 inside the container
// (see entrypoint.sh:start_openvscode_supervisor; private legacy name retained).
// The /api/vscode HTTP + WS branches strip only the exact current-session prefix
// before proxying. Localhost-only by design — the auth boundary is the Worker
// proxy and container bearer chain at /api/vscode/:sid/.
const OPENVSCODE: ProxyTarget = {
  host: process.env.OPENVSCODE_HOST ?? '127.0.0.1',
  port: parseInt(process.env.OPENVSCODE_PORT ?? '13337', 10),
};

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
 * explicit object (CF-014). Handlers read and mutate these fields through
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

// Pre-warm state (module-level so the /health endpoint can read prewarmReady)
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

// Create HTTP server; all plain-HTTP branches live in request-router.ts.
const server = http.createServer(createRequestHandler({
  sessionManager,
  wsEventLog: state.wsEventLog,
  activityTracker: state.activityTracker,
  log,
  serverStartTime: SERVER_START_TIME,
  readiness: () => ({ prewarmReady, initFlagObserved, terminalServiceReady }),
  silverbullet: SILVERBULLET,
  openvscode: OPENVSCODE,
}));

// Create WebSocket server.
//
// We deliberately use `noServer: true` (not the `{server, path}` form): when
// the `ws` library is given a `server` it attaches its own internal
// 'upgrade' listener that unconditionally calls handleUpgrade for every
// upgrade and `abortHandshake(socket, 400)` on path mismatch — which
// would destroy `/vault/*` upgrades before the vault WSS could claim
// them. Routing both /terminal and /vault from a single
// `server.on('upgrade')` (the upgrade dispatcher) gives each WSS exclusive
// control over its own paths.
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

attachTerminalConnectionHandler(wss, {
  sessionManager,
  log,
  logWsEvent,
  readiness: () => ({ initFlagObserved, terminalServiceReady }),
  keepalivePingMs: WS_KEEPALIVE_PING_MS,
  maxControlMsgLength: MAX_CONTROL_MSG_LENGTH,
});

const upgradeDispatcher = createUpgradeDispatcher({
  terminalWss: wss,
  activityTracker: state.activityTracker,
  log,
  silverbullet: SILVERBULLET,
  openvscode: OPENVSCODE,
  wsMaxPayload: WS_MAX_PAYLOAD,
});

server.on('upgrade', (req, socket, head) => upgradeDispatcher.handleUpgrade(req, socket, head));

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
  upgradeDispatcher.close();
  server.close();
  process.exit(0);
}

// Handle shutdown
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
