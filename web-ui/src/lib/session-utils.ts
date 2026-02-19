import type { AgentType } from '../types';

const AGENT_LABELS: Record<AgentType, string> = {
  'claude-unleashed': 'Claude Unleashed',
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  'gemini': 'Gemini',
  'opencode': 'OpenCode',
  'bash': 'Bash',
};

/**
 * Generate a session name like "Claude Unleashed #1", "Bash #2".
 * N = lowest available number among existing sessions matching that agent's pattern.
 */
export function generateSessionName(
  agentType: AgentType | undefined,
  existingSessions: Array<{ name: string }>
): string {
  const label = agentType ? AGENT_LABELS[agentType] : 'Session';
  const prefix = `${label} #`;

  // Collect all numbers already taken for this label
  const usedNumbers = new Set<number>();
  for (const session of existingSessions) {
    if (session.name.startsWith(prefix)) {
      const suffix = session.name.slice(prefix.length);
      const num = parseInt(suffix, 10);
      if (!isNaN(num) && num > 0 && String(num) === suffix) {
        usedNumbers.add(num);
      }
    }
  }

  // Find the lowest available number starting from 1
  let n = 1;
  while (usedNumbers.has(n)) {
    n++;
  }

  return `${prefix}${n}`;
}
