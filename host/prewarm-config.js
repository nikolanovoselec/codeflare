/**
 * Agent-aware pre-warm readiness configuration.
 *
 * Determines the quiescence threshold and optional ready-pattern regex
 * for the PTY pre-warm loop based on what command tab 1 will run.
 *
 * TUI agents (OpenCode, Gemini, Codex) produce continuous spinner/progress
 * output during startup that resets the quiescence timer.  Using a shorter
 * quiescence (500 ms) lets the pre-warm resolve as soon as their startup
 * burst settles, instead of waiting for the 20 s hard timeout.
 */

const DEFAULT_QUIESCENCE_MS = 2000;
const FAST_QUIESCENCE_MS = 500;

// Commands that are TUI agents with busy startup output.
// These get a shorter quiescence window.
const TUI_AGENT_COMMANDS = new Set(['opencode', 'codex', 'gemini', 'claude', 'cu', 'claude-unleashed', 'copilot']);

// Commands that use the default (shell-like) quiescence.
const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh']);

// Ready-pattern regexes for specific agents.
// When matched against PTY output, the pre-warm resolves immediately.
// Each pattern targets a string that only appears once the TUI is fully rendered.
const READY_PATTERNS = {
  opencode: /Ask anything/,                 // Bubble Tea TUI input placeholder when ready
  cu: /╭/,                                  // Claude Code Ink TUI renders ╭ as welcome box border
  'claude-unleashed': /╭/,                  // Same TUI as cu (wrapper around Claude Code)
  gemini: /Type your message/,              // Ink InputPrompt placeholder when ready for input
  copilot: /Describe a task|Copilot uses/,  // Ink welcome box text (wide or narrow terminal)
  codex: /Codex can make mistakes/,         // Rust TUI footer disclaimer when interface is ready
};

/**
 * Whether the quiescence fallback should be used for readiness detection.
 * When a readyPattern is configured, quiescence is disabled — only the
 * pattern match or hard timeout should declare readiness.  This prevents
 * startup silence (e.g. Node.js compile time) from prematurely firing "ready".
 *
 * @param {RegExp|null} readyPattern
 * @returns {boolean}
 */
export function shouldUseQuiescence(readyPattern) {
  return !readyPattern;
}

/**
 * Given a parsed TAB_CONFIG array, return readiness parameters for the
 * pre-warm PTY (which always spawns tab 1).
 *
 * @param {Array<{id: string, command: string, label: string}>|undefined} tabConfig
 * @returns {{ quiescenceMs: number, readyPattern: RegExp|null }}
 */
export function getPrewarmConfig(tabConfig) {
  if (!tabConfig || !Array.isArray(tabConfig) || tabConfig.length === 0) {
    return { quiescenceMs: DEFAULT_QUIESCENCE_MS, readyPattern: null };
  }

  const tab1 = tabConfig.find((t) => t.id === '1');
  if (!tab1 || !tab1.command) {
    return { quiescenceMs: DEFAULT_QUIESCENCE_MS, readyPattern: null };
  }

  // Normalize: take first token of command (e.g. "cu --silent" -> "cu")
  const cmd = tab1.command.split(/\s+/)[0];

  if (SHELL_COMMANDS.has(cmd)) {
    return { quiescenceMs: DEFAULT_QUIESCENCE_MS, readyPattern: null };
  }

  if (TUI_AGENT_COMMANDS.has(cmd)) {
    const pattern = READY_PATTERNS[cmd] || null;
    return { quiescenceMs: FAST_QUIESCENCE_MS, readyPattern: pattern };
  }

  // Unknown command — use default
  return { quiescenceMs: DEFAULT_QUIESCENCE_MS, readyPattern: null };
}
