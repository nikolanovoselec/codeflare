/**
 * Activity tracker for smart hibernation.
 *
 * Tracks WebSocket client connection/disconnection events and user input
 * timestamps to determine container idle time for hibernation decisions.
 *
 * The container DO polls /activity every 60s and renews sleepAfter only
 * when lastInputAt has changed (new user input detected).
 */

import type { ActivityTracker, ActivityInfo, ActivitySessionManager } from './types.js';

export function createActivityTracker(): ActivityTracker {
  const tracker: ActivityTracker = {
    // Initialize to Date.now() so fresh containers auto-expire after 30min if nobody connects
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
