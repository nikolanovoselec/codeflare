/**
 * HTTP request router for the container host server (CF-014 companion).
 *
 * Owns every plain-HTTP branch the server exposes (health, activity,
 * sessions CRUD, sync triggers, git clone, vault + vscode proxies); server.ts
 * owns process lifecycle, readiness flags, and WebSocket wiring. Handlers
 * receive their collaborators through {@link RequestRouterDeps} so the router
 * is importable in unit tests without booting a listening server.
 */
import http from 'node:http';
import { parse as parseUrl } from 'node:url';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { checkContainerAuth } from './auth-check.js';
import { getSyncStatus, getSystemMetrics } from './metrics.js';
import { evaluateFinalSync } from './final-sync.js';
import { AGENT_EVENT_LIMITS, type AgentEventDrainResult, type AgentEventKind } from './agent-events.js';
import type { HealthResponse } from './types.js';
import { resolveGitClone, resolveWorkspaceRoot, buildCloneArgs } from './git-clone.js';
import { stripVaultPrefix } from './vault-proxy.js';
import {
  isVscodePath,
  OPENVSCODE_WORKBENCH_MAX_BYTES,
  projectVscodeWorkbenchWorkspace,
  rewriteVscodeLocation,
  vscodeUpstreamPath,
  vscodeUpstreamRequestTarget,
  requestOpenvscodeStart,
  vscodeModeAllowed,
  vscodeWarmingResponse,
  vscodeDisabledResponse,
} from './vscode-proxy.js';
import type { SessionManager } from './session-manager.js';
import type { ActivityTracker, Logger, WsEvent } from './types.js';
import { SYNC_DAEMON_PID_FILE, SYNC_LOG_FILE, SYNC_STATUS_FILE } from './runtime-paths.js';

/**
 * When the current Browser IDE warming episode started, so the warming page can
 * show elapsed time and eventually give up. Module-level because one container
 * serves exactly one session; cleared on the first successful upstream response.
 */
let vscodeWarmingSince: number | undefined;

const GIT_CLONE_TIMEOUT_MS = 120_000;
export const FINAL_SYNC_INTERNAL_TIMEOUT_MS = 125_000;
const FINAL_SYNC_POLL_MS = 500;
const AGENT_EVENT_DRAIN_BODY_MAX_BYTES = 4 * 1024;
const AGENT_EVENT_INGRESS_BODY_MAX_BYTES = 256;
const AGENT_EVENT_KINDS = new Set<AgentEventKind>(['input-required', 'task-completed', 'task-failed']);
const AGENT_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface AgentEventDrainRequest {
  readonly ackEventIds: readonly string[];
  readonly final?: true;
}

export interface AgentEventDrainer {
  drainAgentEvents(request: AgentEventDrainRequest): AgentEventDrainResult;
}

/** A localhost upstream the host proxies to (SilverBullet / code-server). */
export interface ProxyTarget {
  host: string;
  port: number;
}

/** Live readiness flags owned by server.ts's prewarm lifecycle. */
export interface ReadinessFlags {
  prewarmReady: boolean;
  initFlagObserved: boolean;
  terminalServiceReady: boolean;
  editorReady: boolean;
  editorReadyTimedOut: boolean;
}

export interface RequestRouterDeps {
  sessionManager: SessionManager;
  wsEventLog: WsEvent[];
  activityTracker: ActivityTracker;
  log: Logger;
  serverStartTime: number;
  /** Read the CURRENT readiness flags (they flip as server.ts warms up). */
  readiness(): ReadinessFlags;
  silverbullet: ProxyTarget;
  openvscode: ProxyTarget;
  /** Production composition and focused router tests can provide the queue owner directly. */
  drainAgentEvents?: AgentEventDrainer['drainAgentEvents'];
  enqueueAgentEvent?: (kind: AgentEventKind) => boolean;
  /** Injectable final-sync I/O keeps endpoint tests deterministic; production uses host I/O below. */
  finalSync?: {
    now(): number;
    readStatus(): { status?: string; ts?: number };
    signalDaemon(): void;
    poll(delayMs: number): Promise<void>;
  };
}

// Hop-by-hop headers and any auth we injected for the container boundary
// must NOT be forwarded to the in-container app.
function filterProxyHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding'
      || lk === 'upgrade' || lk === 'proxy-authenticate' || lk === 'proxy-authorization'
      || lk === 'te' || lk === 'trailer' || lk === 'authorization' || lk === 'host') continue;
    if (v !== undefined) out[k] = v as string | string[];
  }
  return out;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * code-server enforces Origin against its externally visible host. The Worker
 * replaces all client forwarding metadata after auth; this hop accepts only
 * those canonical values, removes every spoofable forwarding/hop header, and
 * presents the canonical external Host while preserving the allowlisted caller
 * Origin for code-server's independent comparison.
 */
function vscodeProxyHeaders(
  headers: http.IncomingHttpHeaders,
  target: ProxyTarget,
): http.OutgoingHttpHeaders {
  const connectionTokens = new Set(
    (singleHeader(headers.connection) ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (connectionTokens.has(lower)
      || lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding'
      || lower === 'upgrade' || lower === 'proxy-authenticate' || lower === 'proxy-authorization'
      || lower === 'te' || lower === 'trailer' || lower === 'authorization' || lower === 'host'
      || lower === 'forwarded' || lower.startsWith('x-forwarded-') || lower === 'origin') continue;
    if (value !== undefined) out[name] = value as string | string[];
  }

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
      // The internal fallback keeps direct authenticated host probes usable;
      // production Worker requests always carry validated canonical values.
    }
  }

  out.Host = canonicalHost;
  out['X-Forwarded-Host'] = canonicalHost;
  out['X-Forwarded-Proto'] = canonicalProto;
  const suppliedOrigin = singleHeader(headers.origin);
  if (suppliedOrigin) out.Origin = suppliedOrigin;
  return out;
}

function rewriteVscodeResponseHeaders(
  headers: http.IncomingHttpHeaders,
  sessionId: string,
): http.OutgoingHttpHeaders {
  const prefix = `/api/vscode/${sessionId}`;
  const location = singleHeader(headers.location);
  const serviceWorkerAllowed = singleHeader(headers['service-worker-allowed']);
  const rewriteCookie = (cookie: string): string => cookie.replace(
    /(;\s*path=)(\/[^;]*)/i,
    (_, attr: string, value: string) => `${attr}${prefix}${value}`,
  );
  return {
    ...headers,
    ...(location?.startsWith('/') && !location.startsWith('//')
      ? { location: rewriteVscodeLocation(location, sessionId) }
      : {}),
    ...(headers['set-cookie']
      ? { 'set-cookie': headers['set-cookie'].map(rewriteCookie) }
      : {}),
    ...(serviceWorkerAllowed?.startsWith('/')
      ? { 'service-worker-allowed': `${prefix}${serviceWorkerAllowed}` }
      : {}),
  };
}

export function createRequestHandler(deps: RequestRouterDeps): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const { sessionManager, log } = deps;

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const { pathname } = parseUrl(req.url ?? '');
    const method = req.method;

    // REQ-SEC-022: container auth-token check. Logic extracted to
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
      const { prewarmReady, initFlagObserved, terminalServiceReady, editorReady, editorReadyTimedOut } = deps.readiness();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'healthy',
          sessions: sessionManager.size,
          uptime: Math.floor((Date.now() - deps.serverStartTime) / 1000),
          syncStatus: syncInfo.status,
          syncError: syncInfo.error,
          userPath: syncInfo.userPath,
          prewarmReady,
          initFlagObserved,
          terminalServiceReady,
          editorReady,
          editorReadyTimedOut,
          cpu: sysMetrics.cpu,
          mem: sysMetrics.mem,
          hdd: sysMetrics.hdd,
          timestamp: new Date().toISOString(),
        } satisfies HealthResponse)
      );
      return;
    }

    // WebSocket event log for debugging disconnects
    if (pathname === '/ws-events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: deps.wsEventLog }));
      return;
    }

    // Activity endpoint for smart hibernation (WS connection-based)
    if (pathname === '/activity' && method === 'GET') {
      deps.activityTracker.recordHeartbeat();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(deps.activityTracker.getActivityInfo(sessionManager)));
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

    if (pathname === '/internal/agent-events/enqueue' && method === 'POST') {
      const remoteAddress = req.socket.remoteAddress;
      if (remoteAddress && remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Loopback required' }));
        return;
      }
      if ((req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'application/json required' }));
        return;
      }

      let body = '';
      let bodySize = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        bodySize += chunk.length;
        if (bodySize > AGENT_EVENT_INGRESS_BODY_MAX_BYTES) {
          tooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          return;
        }
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        if (tooLarge) return;
        try {
          const duplicateKind = (body.match(/"kind"\s*:/g) ?? []).length !== 1;
          const duplicateTerminal = (body.match(/"terminalId"\s*:/g) ?? []).length !== 1;
          const parsed = JSON.parse(body) as Record<string, unknown>;
          const keys = Object.keys(parsed);
          const kind = parsed.kind;
          if (
            duplicateKind
            || duplicateTerminal
            || keys.length !== 2
            || !keys.includes('kind')
            || !keys.includes('terminalId')
            || typeof kind !== 'string'
            || !AGENT_EVENT_KINDS.has(kind as AgentEventKind)
            || parsed.terminalId !== '1'
          ) {
            throw new Error('invalid');
          }
          if (!deps.enqueueAgentEvent) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Primary terminal unavailable' }));
            return;
          }
          if (!deps.enqueueAgentEvent(kind as AgentEventKind)) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Primary terminal unavailable' }));
            return;
          }
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid agent event' }));
        }
      });
      return;
    }

    if (pathname === '/internal/agent-events/drain' && method === 'POST') {
      let body = '';
      let bodySize = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        bodySize += chunk.length;
        if (bodySize > AGENT_EVENT_DRAIN_BODY_MAX_BYTES) {
          tooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (tooLarge) return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid agent event drain request' }));
          return;
        }

        const candidate = parsed as Record<string, unknown>;
        const keys = Object.keys(candidate);
        const ackEventIds = candidate.ackEventIds;
        const valid = keys.every((key) => key === 'ackEventIds' || key === 'final')
          && Array.isArray(ackEventIds)
          && ackEventIds.length <= AGENT_EVENT_LIMITS.drainMax
          && ackEventIds.every((eventId) => typeof eventId === 'string'
            && AGENT_EVENT_ID_PATTERN.test(eventId))
          && new Set(ackEventIds).size === ackEventIds.length
          && (candidate.final === undefined || candidate.final === true);
        if (!valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid agent event drain request' }));
          return;
        }

        const managerDrainer = sessionManager as SessionManager & Partial<AgentEventDrainer>;
        const drainAgentEvents = deps.drainAgentEvents
          ?? managerDrainer.drainAgentEvents?.bind(sessionManager);
        if (!drainAgentEvents) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent event drain unavailable' }));
          return;
        }

        const request: AgentEventDrainRequest = candidate.final === true
          ? { ackEventIds: [...ackEventIds], final: true }
          : { ackEventIds: [...ackEventIds] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(drainAgentEvents(request)));
      });
      return;
    }

    // Manual bisync trigger (REQ-STOR-015 AC1). Sends SIGUSR1 to the
    // bisync daemon, which interrupts its sleep and runs an immediate
    // bisync cycle. Idempotent: signals during a running bisync coalesce
    // to exactly one rerun (see entrypoint.sh trap).
    //
    // Hibernation note: daemon PID lives under protected process-lifetime state.
    // at every call, never cached. If the container is sleeping or the
    // daemon has not yet written its PID file, the call returns 503; the
    // Worker fan-out treats 503 as "session not active, skip" rather
    // than propagating a user-visible error.
    if (pathname === '/internal/bisync-trigger' && method === 'POST') {
      try {
        const pidStr = fs.readFileSync(SYNC_DAEMON_PID_FILE, 'utf8').trim();
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

    // REQ-GITHUB-004: live clone into a running container's workspace. Mirrors the
    // new-session entrypoint clone, but for an already-running session reached via
    // POST /api/github/clone -> DO -> here. Already behind the REQ-SEC-022 auth
    // gate above. The repo/ref validation + dir computation are the pure
    // resolveGitClone() helper (git-clone.ts) so this handler owns only fs/spawn
    // I/O. git runs as an argv (never a shell string) and auth flows through the
    // container's existing credential helper ($GH_TOKEN / enterprise interceptor).
    if (pathname === '/internal/git-clone' && method === 'POST') {
      const MAX_BODY_SIZE = 8 * 1024;
      let body = '';
      let bodySize = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY_SIZE) {
          tooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (tooLarge) return;
        let parsed: { repo?: unknown; ref?: unknown };
        try {
          parsed = JSON.parse(body || '{}') as { repo?: unknown; ref?: unknown };
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_BODY' }));
          return;
        }
        const resolution = resolveGitClone(parsed.repo, parsed.ref, resolveWorkspaceRoot(process.env));
        if (!resolution.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: resolution.error, code: 'INVALID_REQUEST' }));
          return;
        }
        // Collision refuse: never overwrite an existing path.
        if (fs.existsSync(resolution.dir)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Clone target already exists', code: 'CLONE_TARGET_EXISTS', path: resolution.dir }));
          return;
        }
        const args = buildCloneArgs(resolution.repo, resolution.ref, resolution.dir, process.env.GITHUB_HOST || 'github.com');
        const child = spawn('git', args);
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Clone timed out', code: 'CLONE_TIMEOUT' }));
        }, GIT_CLONE_TIMEOUT_MS);
        child.on('error', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Clone failed to start', code: 'CLONE_FAILED' }));
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'cloned', path: resolution.dir }));
          } else {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Clone failed', code: 'CLONE_FAILED' }));
          }
        });
      });
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
      const finalSync = deps.finalSync ?? {
        now: () => Date.now(),
        readStatus: (): { status?: string; ts?: number } => {
          try { return JSON.parse(fs.readFileSync(SYNC_STATUS_FILE, 'utf8')); }
          catch { return {}; }
        },
        signalDaemon: () => {
          const pid = Number(fs.readFileSync(SYNC_DAEMON_PID_FILE, 'utf8').trim());
          if (!Number.isFinite(pid) || pid <= 0) throw new Error('invalid daemon PID');
          process.kill(pid, 'SIGUSR1');
        },
        poll: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
      };
      const triggerTs = finalSync.now();
      try {
        finalSync.signalDaemon();
      } catch {
        // No daemon: container is mid-init or already tearing down. Nothing to
        // drain; let the caller proceed to stop.
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ synced: false, reason: 'daemon-not-running' }));
        return;
      }
      // MUST stay strictly ABOVE the DO's drain budget (FINAL_SYNC_BUDGET_MS =
      // 120_000 in src/container/container-metrics.ts). The DO calls this endpoint
      // with AbortSignal.timeout(120s) and that abort is the authoritative
      // ceiling. If this host loop gives up FIRST it returns 504 while rclone is
      // still flushing, the DO records 'incomplete', and the session deletes with
      // the last edits unsynced. The previous value (115_000, < 120s) inverted
      // exactly that: every final bisync landing in the 115-120s band was lost -
      // the root cause behind ~10 failed "raise the budget" fixes. Keep host > DO.
      const timeoutMs = FINAL_SYNC_INTERNAL_TIMEOUT_MS;
      const pollMs = FINAL_SYNC_POLL_MS;
      // Two-phase completion detection lives in the pure evaluateFinalSync state
      // machine (final-sync.ts) so the syncing->success/failed discrimination is
      // unit-testable without spawning the daemon; this loop owns only the I/O.
      let runStartedTs = -1;
      while (finalSync.now() - triggerTs < timeoutMs) {
        const ev = evaluateFinalSync(finalSync.readStatus(), triggerTs, runStartedTs);
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
        await finalSync.poll(pollMs);
      }
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ synced: false, reason: 'timeout' }));
      return;
    }

    // Sync log endpoint
    if (pathname === '/sync-log' && method === 'GET') {
      try {
        const MAX_LOG_SIZE = 100 * 1024; // 100KB
        const stat = fs.statSync(SYNC_LOG_FILE);
        let logContent: string;
        if (stat.size > MAX_LOG_SIZE) {
          // Read only the last 100KB
          const buffer = Buffer.alloc(MAX_LOG_SIZE);
          const fd = fs.openSync(SYNC_LOG_FILE, 'r');
          fs.readSync(fd, buffer, 0, MAX_LOG_SIZE, stat.size - MAX_LOG_SIZE);
          fs.closeSync(fd);
          logContent = '... (truncated)\n' + buffer.toString('utf8');
        } else {
          logContent = fs.readFileSync(SYNC_LOG_FILE, 'utf8');
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
      let upstreamPath = stripVaultPrefix(pathname);
      // SilverBullet 2.8.0 serves the service worker only at the root path
      // (/service_worker.js, with Content-Type text/javascript). Requests
      // routed under /.client/service_worker.js fall through to the
      // catch-all SPA handler and come back as text/html, which the
      // browser then rejects with "ServiceWorker: bad MIME type" and the
      // user sees the registration error from screenshot 1. The base-href
      // rewrite in src/routes/vault/index.ts already makes SB client.js compute
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
      const upstreamReq = http.request({
        host: deps.silverbullet.host,
        port: deps.silverbullet.port,
        method,
        path: upstreamPath + search,
        headers: filterProxyHeaders(req.headers),
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

    // Browser IDE HTTP proxy -> code-server at OPENVSCODE_HOST:OPENVSCODE_PORT.
    // The public session path remains visible in the browser; this trusted hop
    // strips only the exact current-session prefix and canonicalizes the proxy
    // identity code-server uses for Origin enforcement.
    if (isVscodePath(pathname)) {
      // Advanced-mode only (REQ-IDE-003): a non-advanced session never arms the
      // supervisor, so return a clear NON-refreshing page instead of triggering a
      // lazy start that will never complete and looping on the warming page.
      if (!vscodeModeAllowed(process.env.SESSION_MODE)) {
        const disabled = vscodeDisabledResponse();
        res.writeHead(disabled.status, { 'Content-Type': disabled.contentType });
        res.end(disabled.body);
        return;
      }
      const sessionId = process.env.SESSION_ID;
      const upstreamPath = vscodeUpstreamPath(pathname, sessionId);
      if (upstreamPath === null || !sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid Browser IDE session path', code: 'INVALID_VSCODE_PATH' }));
        return;
      }
      const upstreamTarget = vscodeUpstreamRequestTarget(req.url, upstreamPath);
      if (upstreamTarget === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Browser IDE workspace selectors are not allowed', code: 'VSCODE_WORKSPACE_SELECTOR_FORBIDDEN' }));
        return;
      }
      requestOpenvscodeStart();
      const projectRootWorkbench = method === 'GET' && upstreamPath === '/';
      const upstreamHeaders = vscodeProxyHeaders(req.headers, deps.openvscode);
      const browserAuthority = typeof upstreamHeaders.Host === 'string' ? upstreamHeaders.Host : '';
      if (projectRootWorkbench) delete upstreamHeaders['accept-encoding'];
      const upstreamReq = http.request({
        host: deps.openvscode.host,
        port: deps.openvscode.port,
        method,
        path: upstreamTarget,
        headers: upstreamHeaders,
      }, (upstreamRes) => {
        // Reached the server, so this warming episode is over. Clearing it means
        // a later cold start (supervisor restart) gets its own full clock rather
        // than inheriting an expired one and giving up immediately.
        vscodeWarmingSince = undefined;
        const responseHeaders = rewriteVscodeResponseHeaders(upstreamRes.headers, sessionId);
        if (!projectRootWorkbench || upstreamRes.statusCode !== 200) {
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          upstreamRes.pipe(res);
          return;
        }

        let settled = false;
        let size = 0;
        const chunks: Buffer[] = [];
        const failProjection = (): void => {
          if (settled) return;
          settled = true;
          log('warn', 'Vscode workbench configuration projection failed');
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Browser IDE workbench configuration unavailable',
            code: 'VSCODE_WORKBENCH_CONFIGURATION_INVALID',
          }));
        };
        const contentType = singleHeader(upstreamRes.headers['content-type']);
        if (!contentType?.toLowerCase().startsWith('text/html') || upstreamRes.headers['content-encoding']) {
          upstreamRes.resume();
          failProjection();
          return;
        }
        upstreamRes.on('data', (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > OPENVSCODE_WORKBENCH_MAX_BYTES) {
            upstreamRes.destroy();
            failProjection();
            return;
          }
          chunks.push(chunk);
        });
        upstreamRes.on('error', failProjection);
        upstreamRes.on('end', () => {
          if (settled) return;
          const projected = projectVscodeWorkbenchWorkspace(
            Buffer.concat(chunks).toString('utf8'),
            browserAuthority,
          );
          if (projected === null) {
            failProjection();
            return;
          }
          settled = true;
          const body = Buffer.from(projected, 'utf8');
          delete responseHeaders['content-encoding'];
          delete responseHeaders['transfer-encoding'];
          delete responseHeaders.etag;
          responseHeaders['content-length'] = body.length;
          res.writeHead(200, responseHeaders);
          res.end(body);
        });
      });
      upstreamReq.on('error', (err) => {
        log('warn', 'Vscode proxy upstream error', { error: err.message, path: upstreamPath });
        if (!res.headersSent) {
          vscodeWarmingSince ??= Date.now();
          const warming = vscodeWarmingResponse(Date.now() - vscodeWarmingSince);
          res.writeHead(warming.status, { 'Content-Type': warming.contentType });
          res.end(warming.body);
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
  };
}
