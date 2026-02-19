function createActivityTracker() {
  const tracker = {
    // Initialize to Date.now() so fresh containers auto-expire after 30min if nobody connects
    lastAllDisconnectedAt: Date.now(),

    // Called on every WS attach (idempotent — just clears the disconnect timer)
    recordClientConnected() {
      tracker.lastAllDisconnectedAt = null;
    },

    // Called when the GLOBAL client count drops to 0
    recordAllClientsDisconnected() {
      tracker.lastAllDisconnectedAt = Date.now();
    },

    getActivityInfo(sessionManager) {
      const connectedClients = sessionManager ? sessionManager.clients.size : 0;
      const hasActiveConnections = connectedClients > 0;
      const sessions = sessionManager?.sessions
        ? Array.from(sessionManager.sessions.values())
        : [];
      const activeSessions = sessions.filter(s => s.ptyProcess != null).length;

      // Duration since last disconnection (null if currently connected)
      let disconnectedForMs = null;
      if (!hasActiveConnections && tracker.lastAllDisconnectedAt !== null) {
        disconnectedForMs = Date.now() - tracker.lastAllDisconnectedAt;
      }

      return {
        hasActiveConnections,
        connectedClients,
        activeSessions,
        disconnectedForMs,
      };
    },
  };
  return tracker;
}

export { createActivityTracker };
