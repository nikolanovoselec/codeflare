/**
 * SessionManager — manages all PTY sessions.
 *
 * Handles session creation, deletion, cleanup, pre-warm adoption,
 * and client aggregation across sessions.
 */

import { Session } from './session.js';

export const PREWARM_SESSION_ID = 'prewarm-1';

/**
 * SessionManager handles all PTY sessions.
 */
export class SessionManager {
  /**
   * @param {object} options - Configuration options passed to new Session instances
   * @param {number} options.maxSessions - Maximum number of active sessions
   * @param {number} options.ptyCleanupIntervalMs - Cleanup interval in ms
   * @param {function} options.log - Structured logger
   */
  constructor(options = {}) {
    this.sessions = new Map();
    this.cleanupInterval = null;
    this._options = options;
    this._maxSessions = options.maxSessions || 20;
    this._ptyCleanupIntervalMs = options.ptyCleanupIntervalMs || 60000;
    this._log = options.log || (() => {});
  }

  /**
   * Start periodic cleanup of dead sessions
   */
  startCleanup() {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      this.cleanupDeadSessions();
    }, this._ptyCleanupIntervalMs);

    this._log('info', 'Started cleanup interval', { intervalSec: this._ptyCleanupIntervalMs / 1000 });
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
      if (!session.isPtyAlive() && session.clients.size === 0) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.sessions.delete(id);
      this._log('info', 'Cleaned up dead session', { session: id });
    }

    if (toDelete.length > 0) {
      this._log('info', 'Dead sessions cleanup complete', { cleaned: toDelete.length, active: this.sessions.size });
    }
  }

  /**
   * Get or create a session
   */
  getOrCreate(id, name, manual = false) {
    let session = this.sessions.get(id);

    if (session) {
      if (session.isPtyAlive()) {
        this._log('info', 'Reattaching to existing session', { session: id, pid: session.ptyProcess?.pid });
      } else {
        this._log('info', 'Session exists but PTY is dead, will restart on attach', { session: id });
      }
    } else {
      // Check for pre-warmed session to adopt (tab 1 only)
      const terminalId = id.includes('-') ? id.split('-').pop() : '1';
      if (terminalId === '1') {
        const prewarmed = this.sessions.get(PREWARM_SESSION_ID);
        if (prewarmed && this.sessions.delete(PREWARM_SESSION_ID)) {
          prewarmed.id = id;
          if (prewarmed.orphanTimeout) {
            clearTimeout(prewarmed.orphanTimeout);
            prewarmed.orphanTimeout = null;
          }
          this.sessions.set(id, prewarmed);
          this._log('info', 'Adopted pre-warmed session', { session: id });
          return prewarmed;
        }
      }

      // Add session cap check (exclude prewarm sessions from count)
      const activeCount = Array.from(this.sessions.keys()).filter(k => !k.startsWith('prewarm-')).length;
      if (activeCount >= this._maxSessions) {
        return null;
      }
      // Create new session with injected options
      session = new Session(id, name, manual, this._options);
      this.sessions.set(id, session);
      this._log('info', 'Created new session', { session: id });
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
      this._log('info', 'Deleted session', { session: id });
      return true;
    }
    return false;
  }

  /**
   * Kill all active sessions. Used during shutdown.
   */
  killAll() {
    for (const [id, session] of this.sessions) {
      session.kill();
      this._log('info', 'Killed session during shutdown', { session: id });
    }
    this.sessions.clear();
  }

  /**
   * List all sessions
   */
  list() {
    return Array.from(this.sessions.values()).map((s) => s.toJSON());
  }

  /**
   * Get a Map of all connected WebSocket clients across all sessions.
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
