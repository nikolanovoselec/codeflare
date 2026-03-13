/**
 * Session class — represents a single PTY terminal instance.
 *
 * Manages the PTY lifecycle: spawn, attach/detach WebSocket clients,
 * resize, kill, and headless terminal state for reconnection.
 */

import pty from 'node-pty';
import type { IPty } from 'node-pty';
import { WebSocket } from 'ws';
import HeadlessPkg from '@xterm/headless';
const { Terminal: HeadlessTerminal } = HeadlessPkg;
import { SerializeAddon } from '@xterm/addon-serialize';

import type {
  SessionOptions,
  SessionJSON,
  TabConfigMap,
  Logger,
  WsEventLogger,
  ActivityTracker,
} from './types.js';

const PROCESS_NAME_POLL_MS = 2000;

/**
 * Strip terminal emulator response sequences from input before writing to PTY.
 *
 * When xterm.js responds to queries from PTY programs (DSR cursor position,
 * OSC background color, device attributes), the responses travel back through
 * WebSocket and can pollute stdin of programs reading user input — e.g.,
 * `gh secret set` reads an OSC 11 response instead of the pasted secret.
 *
 * These patterns are terminal responses, never user-typed input:
 * - CPR (Cursor Position Report): \e[<row>;<col>R  — response to DSR \e[6n
 * - OSC 10/11/12 responses: \e]1x;rgb:...ST       — response to \e]11;?\e\\
 * - DA1 (Device Attributes): \e[?<params>c         — response to \e[c
 */
function stripTerminalResponses(data: string): string {
  return data
    .replace(/\x1b\[\d+;\d+R/g, '')
    .replace(/\x1b\]1[012];[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[\?[\d;]*c/g, '');
}

// Forward reference — SessionManager is imported only as a type to avoid
// circular runtime dependencies.
interface SessionManagerLike {
  clients: Map<string, WebSocket>;
  sessions: Map<string, Session>;
}

/**
 * Session represents a PTY terminal instance.
 */
export class Session {
  id: string;
  name: string;
  manual: boolean;
  ptyProcess: IPty | null;
  clients: Set<WebSocket>;
  headlessTerminal: InstanceType<typeof HeadlessTerminal>;
  serializeAddon: InstanceType<typeof SerializeAddon>;
  createdAt: string;
  lastAccessedAt: string;
  disconnectedAt: string | null;
  keepAliveTimeout: ReturnType<typeof setTimeout> | null;
  lastProcessName: string | null;
  processNameInterval: ReturnType<typeof setInterval> | null;
  orphanTimeout: ReturnType<typeof setTimeout> | null;

  // Injected dependencies
  private readonly _tabConfigMap: TabConfigMap;
  private readonly _terminalCommand: string;
  private readonly _terminalArgs: string;
  private readonly _getWorkingDirectory: () => string;
  private readonly _log: Logger;
  private readonly _logWsEvent: WsEventLogger;
  private readonly _activityTracker: ActivityTracker | null;
  private readonly _ptyKeepaliveMs: number;

  constructor(id: string, name = 'Terminal', manual = false, options: SessionOptions = {}) {
    this.id = id;
    this.name = name;
    this.manual = manual;
    this.ptyProcess = null;
    this.clients = new Set();
    this.headlessTerminal = new HeadlessTerminal({ cols: 80, rows: 24, scrollback: 10000, allowProposedApi: true });
    this.serializeAddon = new SerializeAddon();
    this.headlessTerminal.loadAddon(this.serializeAddon);
    this.createdAt = new Date().toISOString();
    this.lastAccessedAt = this.createdAt;
    this.disconnectedAt = null;
    this.keepAliveTimeout = null;
    this.lastProcessName = null;
    this.processNameInterval = null;
    this.orphanTimeout = null;

    // Injected dependencies
    this._tabConfigMap = options.tabConfigMap ?? {};
    this._terminalCommand = options.terminalCommand ?? '/bin/bash';
    this._terminalArgs = options.terminalArgs ?? '-l';
    this._getWorkingDirectory = options.getWorkingDirectory ?? (() => '/tmp');
    this._log = options.log ?? (() => {});
    this._logWsEvent = options.logWsEvent ?? (() => {});
    this._activityTracker = options.activityTracker ?? null;
    this._ptyKeepaliveMs = options.ptyKeepaliveMs ?? 2700000;
  }

  /**
   * Get the terminal ID from the compound session ID (e.g., "abc123-2" -> "2")
   */
  get terminalId(): string {
    const parts = this.id.split('-');
    return parts[parts.length - 1];
  }

  /**
   * Resolve the display name for the foreground process.
   */
  resolveProcessName(): string | null {
    const rawName = this.ptyProcess ? this.ptyProcess.process : null;
    if (!rawName) return null;

    const configuredCmd = this._tabConfigMap[this.terminalId];
    if (configuredCmd) {
      const baseName = rawName.split('/').pop();
      if (['node', 'nodejs', 'bash', 'sh', 'zsh'].includes(baseName ?? '')) {
        return configuredCmd.split(/\s+/)[0];
      }
    }

    return rawName.split('/').pop() ?? rawName;
  }

  /**
   * Start the PTY process
   */
  start(cols = 80, rows = 24): void {
    if (this.ptyProcess) {
      return;
    }

    const [cmd, ...cmdArgs] = this._terminalCommand.split(' ');
    const extraArgs = this._terminalArgs ? this._terminalArgs.split(' ').filter(a => a) : [];
    const args = [...cmdArgs, ...extraArgs];

    this._log('info', 'Spawning PTY', { session: this.id.substring(0, 8), cmd, args });

    const cwd = this._getWorkingDirectory();
    const terminalId = this.id.includes('-') ? this.id.split('-').pop() : '1';

    const ptyEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      HOME: process.env.HOME ?? '/root',
      TERMINAL_ID: terminalId ?? '1',
      CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL: '1',
    };
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

    this.ptyProcess.onData((data: string) => {
      this.headlessTerminal.write(data);

      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this._log('info', 'PTY exited', { session: this.id, exitCode, signal, connectedClients: this.clients.size });
      this._logWsEvent(this.id, 'pty_exit', { exitCode, signal, connectedClients: this.clients.size });
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(`\r\n[Process exited with code ${exitCode}]\r\n`);
        }
      }
      this.ptyProcess = null;
      if (this.processNameInterval) {
        clearInterval(this.processNameInterval);
        this.processNameInterval = null;
      }
      this.lastProcessName = null;
    });

    this.lastProcessName = this.resolveProcessName();
    this.processNameInterval = setInterval(() => {
      if (!this.ptyProcess) {
        clearInterval(this.processNameInterval!);
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

    this._log('info', 'PTY started', { session: this.id.substring(0, 8), pid: this.ptyProcess.pid });
  }

  /**
   * Attach a WebSocket client to this session
   */
  attach(ws: WebSocket): void {
    this.clients.add(ws);
    this.lastAccessedAt = new Date().toISOString();
    if (this._activityTracker) {
      this._activityTracker.recordClientConnected();
    }

    if (this.keepAliveTimeout) {
      clearTimeout(this.keepAliveTimeout);
      this.keepAliveTimeout = null;
      this._log('info', 'Reconnected, cancelled keepalive timeout', { session: this.id.substring(0, 8) });
    }
    this.disconnectedAt = null;

    if (!this.ptyProcess) {
      this.start();
    }

    const state = this.serializeAddon.serialize();
    if (state) {
      ws.send(JSON.stringify({ type: 'restore', state }));
    }

    if (this.lastProcessName) {
      ws.send(JSON.stringify({ type: 'process-name', terminalId: this.id, processName: this.lastProcessName }));
    }

    this._log('info', 'Client attached', { session: this.id.substring(0, 8), totalClients: this.clients.size });
  }

  /**
   * Detach a WebSocket client from this session
   */
  detach(ws: WebSocket, sessionManager: SessionManagerLike | null = null): void {
    this.clients.delete(ws);
    this._log('info', 'Client detached', { session: this.id.substring(0, 8), totalClients: this.clients.size });

    if (this._activityTracker && sessionManager && sessionManager.clients.size === 0) {
      this._activityTracker.recordAllClientsDisconnected();
    }

    if (this.clients.size === 0 && this.ptyProcess) {
      this.disconnectedAt = new Date().toISOString();
      this._log('info', 'No clients remaining, PTY kept alive', { session: this.id.substring(0, 8), keepAliveSec: this._ptyKeepaliveMs / 1000 });

      this.keepAliveTimeout = setTimeout(() => {
        if (this.clients.size === 0 && this.ptyProcess) {
          this._log('info', 'Keepalive timeout expired, killing PTY', { session: this.id.substring(0, 8) });
          this.kill();
          if (sessionManager) {
            sessionManager.sessions.delete(this.id);
            this._log('info', 'Removed orphaned session', { session: this.id });
          }
        }
      }, this._ptyKeepaliveMs);
    }
  }

  /**
   * Write data to the PTY, stripping terminal emulator responses that
   * xterm.js sent back through WebSocket (CPR, OSC, DA sequences).
   */
  write(data: string): void {
    if (this.ptyProcess) {
      const filtered = stripTerminalResponses(data);
      if (filtered) {
        this.ptyProcess.write(filtered);
      }
    }
  }

  /**
   * Resize the PTY
   */
  resize(cols: number, rows: number): void {
    if (this.ptyProcess) {
      this.ptyProcess.resize(cols, rows);
    }
    this.headlessTerminal.resize(cols, rows);
  }

  /**
   * Kill the PTY process
   */
  kill(): void {
    if (this.keepAliveTimeout) {
      clearTimeout(this.keepAliveTimeout);
      this.keepAliveTimeout = null;
    }

    if (this.processNameInterval) {
      clearInterval(this.processNameInterval);
      this.processNameInterval = null;
    }
    this.lastProcessName = null;

    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }
    this.headlessTerminal.dispose();
    for (const client of this.clients) {
      client.close(1000, 'Session terminated');
    }
    this.clients.clear();
    this.disconnectedAt = null;
    this._log('info', 'Session killed', { session: this.id });
  }

  /**
   * Check if PTY process is still running
   */
  isPtyAlive(): boolean {
    return this.ptyProcess !== null;
  }

  /**
   * Get session info
   */
  toJSON(): SessionJSON {
    return {
      id: this.id,
      name: this.name,
      pid: this.ptyProcess?.pid ?? null,
      clients: this.clients.size,
      createdAt: this.createdAt,
      lastAccessedAt: this.lastAccessedAt,
      disconnectedAt: this.disconnectedAt,
      ptyAlive: this.isPtyAlive(),
    };
  }
}
