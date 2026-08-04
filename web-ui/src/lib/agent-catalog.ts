/**
 * The agent catalog: the one place that names every selectable agent for UI
 * surfaces (CreateSession dialog, clone picker, Setup wizard). A standalone
 * data module with no store/component imports, so consumers can read the
 * catalog without pulling the session-store graph into their module tree.
 */
import {
  mdiRobotOutline,
  mdiCodeBraces,
  mdiRocketLaunchOutline,
  mdiConsole,
  mdiRobotIndustrial,
  mdiGithub,
  mdiPi,
} from '@mdi/js';
import type { AgentType } from '../types';

interface AgentOption {
  type: AgentType;
  label: string;
  icon: string;
  description: string;
  badge?: string;
}

// Coding agents are listed alphabetically by label; Bash (plain terminal, no
// agent) stays last as the non-agent fallback. The default selection is pinned
// elsewhere (lastAgentType preference / caller default), independent of order.
export const AGENT_OPTIONS: AgentOption[] = [
  { type: 'antigravity', label: 'Antigravity', icon: mdiRocketLaunchOutline, description: "Google's terminal coding agent", badge: 'beta' },
  { type: 'claude-code', label: 'Claude Code', icon: mdiRobotOutline, description: 'Full Claude Code experience' },
  { type: 'codex', label: 'Codex', icon: mdiCodeBraces, description: 'OpenAI Codex agent' },
  { type: 'copilot', label: 'GitHub Copilot', icon: mdiGithub, description: "GitHub's AI coding agent" },
  { type: 'opencode', label: 'OpenCode', icon: mdiRobotIndustrial, description: 'Multi-model agent', badge: 'beta' },
  { type: 'pi', label: 'Pi', icon: mdiPi, description: 'Minimal, extensible coding harness' },
  { type: 'bash', label: 'Bash', icon: mdiConsole, description: 'Plain terminal session' },
];

// Enterprise mode restricts the agent set to the wizard-activated agents
// delivered by GET /api/user (REQ-ENTERPRISE-003). ENTERPRISE_AGENT_TYPES is the
// legacy-response fallback used when that response omits allowedAgents; it
// mirrors ENTERPRISE_AGENTS in src/lib/agent-allowlist.ts. Before hydration,
// sessionStore.allowedAgents remains null and creation choices stay hidden.
export const ENTERPRISE_AGENT_TYPES: AgentType[] = ['copilot', 'pi', 'bash'];
