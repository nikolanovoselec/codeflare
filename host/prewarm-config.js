/**
 * Pre-warm readiness configuration.
 *
 * Readiness is detected by first PTY output — as soon as the agent produces
 * any terminal output, the pre-warm is considered ready. This works reliably
 * regardless of whether the agent is logged in, needs auth, or shows update
 * prompts. The 20s hard timeout in server.js is the safety net.
 *
 * Previously, agent-specific regex patterns were used to detect readiness
 * (e.g., /╭/ for Claude Unleashed, /Ask anything/ for OpenCode). This failed
 * when agents weren't logged in, as the startup output was completely different.
 */

/**
 * Given a parsed TAB_CONFIG array, return readiness parameters for the
 * pre-warm PTY (which always spawns tab 1).
 *
 * @param {Array<{id: string, command: string, label: string}>|undefined} tabConfig
 * @returns {{ command: string|null }}
 */
export function getPrewarmConfig(tabConfig) {
  if (!tabConfig || !Array.isArray(tabConfig) || tabConfig.length === 0) {
    return { command: null };
  }

  const tab1 = tabConfig.find((t) => t && t.id === '1');
  if (!tab1 || typeof tab1.command !== 'string' || !tab1.command) {
    return { command: null };
  }

  return { command: tab1.command.split(/\s+/)[0] };
}
