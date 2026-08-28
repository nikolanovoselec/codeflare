/**
 * Agent configuration helpers
 * Default tab configurations for each agent type
 */
import type { AgentType, TabConfig, TerminalMode } from '../types';
import { MAX_TABS } from './constants';

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

/** Generate mode-specific default outer terminal configuration. */
export function getDefaultTabConfig(agentType: AgentType, terminalMode: TerminalMode = 'classic'): TabConfig[] {
  const primary = AGENT_COMMANDS[agentType];
  const tabs: TabConfig[] = [{ id: '1', command: primary.command, label: primary.label }];
  if (terminalMode === 'herdr') return tabs;
  for (let id = 2; id <= MAX_TABS; id += 1) {
    tabs.push({ id: String(id), command: '', label: `Terminal ${id}` });
  }
  return tabs;
}
