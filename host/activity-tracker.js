const AGENT_DIRS = [
  `${process.env.HOME}/.claude/projects/`,
  `${process.env.HOME}/.codex/sessions/`,
  `${process.env.HOME}/.gemini/tmp/`,
  `${process.env.HOME}/.local/share/opencode/`,
];

function createActivityTracker() {
  const now = Date.now();
  const tracker = {
    lastUserInputTimestamp: now,
    lastAgentFileActivityTimestamp: now,
    recordUserInput() {
      tracker.lastUserInputTimestamp = Date.now();
    },
    updateAgentFileActivity() {
      tracker.lastAgentFileActivityTimestamp = Date.now();
    },
    getActivityInfo(sessionManager) {
      const now = Date.now();
      const connectedClients = sessionManager ? sessionManager.clients.size : 0;
      const sessions = sessionManager?.sessions ? Array.from(sessionManager.sessions.values()) : [];
      const activeSessions = sessions.filter(s => s.ptyProcess != null).length;
      return {
        hasActiveConnections: connectedClients > 0,
        connectedClients,
        activeSessions,
        lastUserInputMs: now - tracker.lastUserInputTimestamp,
        lastAgentFileActivityMs: now - tracker.lastAgentFileActivityTimestamp,
        lastUserInputAt: new Date(tracker.lastUserInputTimestamp).toISOString(),
        lastAgentFileActivityAt: new Date(tracker.lastAgentFileActivityTimestamp).toISOString(),
      };
    },
  };
  return tracker;
}

export { createActivityTracker, AGENT_DIRS };
