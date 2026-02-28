/**
 * Session class — represents a single PTY terminal instance.
 *
 * Manages the PTY lifecycle: spawn, attach/detach WebSocket clients,
 * resize, kill, and headless terminal state for reconnection.
 */

import pty from 'node-pty';
import { WebSocket } from 'ws';
import HeadlessPkg from '@xterm/headless';
const { Terminal: HeadlessTerminal } = HeadlessPkg;
import SerializePkg from '@xterm/addon-serialize';
const { SerializeAddon } = SerializePkg;

const PROCESS_NAME_POLL_MS = 2000;

/**
 * Session represents a PTY terminal instance.
 */
export class Session {
  /**
   * @param {string} id - Session ID
   * @param {string} name - Display name
   * @param {boolean} manual - Whether this is a manually-created tab
   * @param {object} options - Configuration options
   * @param {object} options.tabConfigMap - Map of terminal ID to configured command
   * @param {string} options.terminalCommand - Command to spawn
   * @param {string} options.terminalArgs - Arguments for the command
   * @param {function} options.getWorkingDirectory - Function to resolve working directory
   * @param {function} options.log - Structured logger
   * @param {function} options.logWsEvent - WebSocket event logger
   * @param {object} options.activityTracker - Activity tracker instance
   * @param {number} options.ptyKeepaliveMs - PTY keepalive timeout in ms
   */
  constructor(id, name = 'Terminal', manual = false, options = {}) {
    this.id = id;
    this.name = name;
    this.manual = manual;
    this.ptyProcess = null;
    this.clients = new Set();
    this.headlessTerminal = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
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
    this._tabConfigMap = options.tabConfigMap || {};
    this._terminalCommand = options.terminalCommand || '/bin/bash';
    this._terminalArgs = options.terminalArgs || '-l';
    this._getWorkingDirectory = options.getWorkingDirectory || (() => '/tmp');
    this._log = options.log || (() => {});
    this._logWsEvent = options.logWsEvent || (() => {});
    this._activityTracker = options.activityTracker || null;
    this._ptyKeepaliveMs = options.ptyKeepaliveMs || 2700000;
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
   */
  resolveProcessName() {
    const rawName = this.ptyProcess ? this.ptyProcess.process : null;
    if (!rawName) return null;

    const configuredCmd = this._tabConfigMap[this.terminalId];
    if (configuredCmd) {
      const baseName = rawName.split('/').pop();
      if (['node', 'nodejs', 'bash', 'sh', 'zsh'].includes(baseName)) {
        return configuredCmd.split(/\s+/)[0];
      }
    }

    return rawName.split('/').pop() || rawName;
  }

  /**
   * Start the PTY process
   */
  start(cols = 80, rows = 24) {
    if (this.ptyProcess) {
      return;
    }

    const [cmd, ...cmdArgs] = this._terminalCommand.split(' ');
    const extraArgs = this._terminalArgs ? this._terminalArgs.split(' ').filter(a => a) : [];
    const args = [...cmdArgs, ...extraArgs];

    this._log('info', 'Spawning PTY', { session: this.id.substring(0, 8), cmd, args });

    const cwd = this._getWorkingDirectory();
    const terminalId = this.id.includes('-') ? this.id.split('-').pop() : '1';

    const ptyEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      HOME: process.env.HOME || '/root',
      TERMINAL_ID: terminalId,
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

    this.ptyProcess.onData((data) => {
      this.headlessTerminal.write(data);

      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
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

    this._log('info', 'PTY started', { session: this.id.substring(0, 8), pid: this.ptyProcess.pid });
  }

  /**
   * Attach a WebSocket client to this session
   */
  attach(ws) {
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
   * @param {WebSocket} ws
   * @param {SessionManager} sessionManager - Reference to session manager for cleanup
   */
  detach(ws, sessionManager = null) {
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
