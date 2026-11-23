import type { Session } from '../types';

export function isPiWebSession(session: Pick<Session, 'agentType' | 'workspace' | 'tabConfig'> | null | undefined): boolean {
  if (session?.agentType !== 'pi' || session.workspace === 'vscode') return false;
  // Missing config uses the selected agent; an explicit primary must be native Pi.
  if (!session.tabConfig) return true;
  const primary = session.tabConfig.filter(tab => tab.id === '1');
  return primary.length === 1 && primary[0].command === 'pi';
}
