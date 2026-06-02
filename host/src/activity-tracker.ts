/**
 * Activity tracker for smart hibernation.
 *
 * Tracks WebSocket client connection/disconnection events and user input
 * timestamps. The container DO polls /activity every 60s; its idle policy is
 * keyed off lastInputAt (PTY keystrokes only) in collectMetrics and stops the
 * container at the configured idle timeout - see src/container/index.ts.
 *
 * NOTE: there is NO 30-minute (or any) disconnect-based auto-expire.
 * `disconnectedForMs` / `lastAllDisconnectedAt` are still computed here but are
 * NOT consumed by any stop decision - a vestige of an earlier hibernation
 * design (the /activity endpoint the DO reads does not even expose them).
 */

import type { ActivityTracker, ActivityInfo, ActivitySessionManager } from './types.js';

export function createActivityTracker(): ActivityTracker {
  const tracker: ActivityTracker = {
    // Vestigial: seeds disconnectedForMs, which no idle-stop consumes anymore
    // (the DO stops on lastInputAt, not on disconnect). Kept only for the
    // /activity payload shape; see the header note. NOT a 30-minute timer.
    lastAllDisconnectedAt: Date.now(),

    // Called on every WS attach (idempotent — just clears the disconnect timer)
    recordClientConnected(): void {
      tracker.lastAllDisconnectedAt = null;
    },

    // Called when the GLOBAL client count drops to 0
    recordAllClientsDisconnected(): void {
      tracker.lastAllDisconnectedAt = Date.now();
    },

    // Called on every real user input (keypresses, clicks — not terminal protocol chatter)
    recordInput(): void {
      lastInputAt = Date.now();
    },

    recordHeartbeat(): void {
      lastHeartbeatAt = Date.now();
    },

    getActivityInfo(sessionManager: ActivitySessionManager | null | undefined): ActivityInfo {
      const connectedClients = sessionManager ? sessionManager.clients.size : 0;
      const hasActiveConnections = connectedClients > 0;
      const sessions = sessionManager?.sessions
        ? Array.from(sessionManager.sessions.values())
        : [];
      const activeSessions = sessions.filter(s => s.ptyProcess != null).length;

      // Duration since last disconnection (null if currently connected)
      let disconnectedForMs: number | null = null;
      if (!hasActiveConnections && tracker.lastAllDisconnectedAt !== null) {
        disconnectedForMs = Date.now() - tracker.lastAllDisconnectedAt;
      }

      return {
        hasActiveConnections,
        connectedClients,
        activeSessions,
        disconnectedForMs,
        lastInputAt,
        lastHeartbeatAt,
      };
    },
  };

  let lastInputAt: number | null = null;
  let lastHeartbeatAt: number | null = null;

  return tracker;
}
