/**
 * Agent configuration helpers
 * Default tab configurations for each agent type
 */
import type { AgentType, TabConfig } from '../types';

/**
 * Primary command for each agent type, consumed by the Herdr launcher.
 */
const AGENT_COMMANDS: Record<AgentType, { command: string; label: string }> = {
  'claude-code': { command: 'claude --dangerously-skip-permissions', label: 'Terminal 1' },
  'codex': { command: 'codex', label: 'Terminal 1' },
  'copilot': { command: 'copilot --yolo', label: 'Terminal 1' },
  'antigravity': { command: 'agy --dangerously-skip-permissions', label: 'Terminal 1' },
  'opencode': { command: 'opencode', label: 'Terminal 1' },
  'pi': { command: 'pi', label: 'Terminal 1' },
  'bash': { command: '', label: 'Terminal 1' },
};

/**
 * Generate the sole outer terminal configuration for a given agent type.
 */
export function getDefaultTabConfig(agentType: AgentType): TabConfig[] {
  const primary = AGENT_COMMANDS[agentType];
  return [{ id: '1', command: primary.command, label: primary.label }];
}
