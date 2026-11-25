import { resolveTerminalMode, type AgentType, type Session, type UserPreferences } from '../types';

/** Whether to offer a new mode choice; existing surfaces remain observable. */
export function canChoosePiSurface(
  preferences: Pick<UserPreferences, 'herdrEnabled' | 'defaultWorkspace'>,
  allowedAgents: readonly AgentType[] | null,
): boolean {
  return !preferences.herdrEnabled && preferences.defaultWorkspace !== 'vscode'
    && (allowedAgents?.includes('pi') ?? true);
}

export function isPiWebSession(session: Pick<Session, 'agentType' | 'workspace' | 'tabConfig' | 'terminalMode'> | null | undefined): boolean {
  if (session?.agentType !== 'pi' || session.workspace === 'vscode' || resolveTerminalMode(session.terminalMode) !== 'classic') return false;
  // Missing config uses the selected agent; an explicit primary must be native Pi.
  if (!session.tabConfig) return true;
  const primary = session.tabConfig.filter(tab => tab.id === '1');
  return primary.length === 1 && primary[0].command === 'pi';
}
