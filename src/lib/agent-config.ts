/**
 * Agent configuration helpers
 * Default tab configurations for each agent type
 */
import type { AgentType, TabConfig } from '../types';
import { MAX_TABS } from './constants';

/**
 * Primary command for each agent type (tab 1)
 */
const AGENT_COMMANDS: Record<AgentType, { command: string; label: string }> = {
  'claude-unleashed': { command: 'cu', label: 'Terminal 1' },
  'claude-code': { command: 'claude', label: 'Terminal 1' },
  'codex': { command: 'codex', label: 'Terminal 1' },
  'gemini': { command: 'gemini', label: 'Terminal 1' },
  'opencode': { command: 'opencode', label: 'Terminal 1' },
  'bash': { command: '', label: 'Terminal 1' },
};

/**
 * Generate the default TabConfig[] for a given agent type.
 * Tab 1 runs the agent command; tabs 2-6 are plain bash.
 */
export function getDefaultTabConfig(agentType: AgentType): TabConfig[] {
  const primary = AGENT_COMMANDS[agentType];
  const tabs: TabConfig[] = [
    { id: '1', command: primary.command, label: primary.label },
  ];

  for (let i = 2; i <= MAX_TABS; i++) {
    tabs.push({ id: String(i), command: '', label: `Terminal ${i}` });
  }

  return tabs;
}
