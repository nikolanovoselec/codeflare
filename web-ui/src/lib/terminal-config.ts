import {
  mdiRobotOutline,
  mdiConsole,
  mdiCodeBraces,
  mdiRocketLaunchOutline,
  mdiViewCompactOutline,
  mdiRobotIndustrial,
  mdiGithub,
  mdiPi,
} from '@mdi/js';

export const MULTIVIEW_ICON = mdiViewCompactOutline;

/** Map configured session agents to their display icons. Inner process state belongs to Herdr. */
export const AGENT_ICON_MAP: Record<string, string> = {
  'claude-code': mdiRobotOutline,
  'codex': mdiCodeBraces,
  'antigravity': mdiRocketLaunchOutline,
  'opencode': mdiRobotIndustrial,
  'copilot': mdiGithub,
  'pi': mdiPi,
  'bash': mdiConsole,
};
