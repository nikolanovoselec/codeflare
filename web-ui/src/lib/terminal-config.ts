import {
  mdiRobotOutline,
  mdiChartLine,
  mdiFolderOutline,
  mdiConsole,
  mdiCodeBraces,
  mdiDiamond,
  mdiSourceBranch,
  mdiFire,
} from '@mdi/js';

// Tab configuration: generic defaults, overridden by live process detection
export const TERMINAL_TAB_CONFIG: Record<string, { name: string; icon: string }> = {
  '1': { name: 'Terminal 1', icon: mdiConsole },
  '2': { name: 'Terminal 2', icon: mdiConsole },
  '3': { name: 'Terminal 3', icon: mdiConsole },
  '4': { name: 'Terminal 4', icon: mdiConsole },
  '5': { name: 'Terminal 5', icon: mdiConsole },
  '6': { name: 'Terminal 6', icon: mdiConsole },
};

// Map process names (from server) to MDI icon paths
const PROCESS_ICON_MAP: Record<string, string> = {
  'claude': mdiFire,
  'cu': mdiFire,
  'claude-code': mdiRobotOutline,
  'codex': mdiCodeBraces,
  'gemini': mdiDiamond,
  'htop': mdiChartLine,
  'yazi': mdiFolderOutline,
  'lazygit': mdiSourceBranch,
  'bash': mdiConsole,
  'sh': mdiConsole,
  'zsh': mdiConsole,
};

/** Get icon path for a live process name */
export function getTabIcon(processName: string): string {
  return PROCESS_ICON_MAP[processName] || mdiConsole;
}

/** Map agent types to their display icons */
export const AGENT_ICON_MAP: Record<string, string> = {
  'claude-unleashed': mdiFire,
  'claude-code': mdiRobotOutline,
  'codex': mdiCodeBraces,
  'gemini': mdiDiamond,
  'bash': mdiConsole,
};
