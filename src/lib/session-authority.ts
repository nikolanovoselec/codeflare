import { NotFoundError } from './error-types';

type WorkloadLifecycleState = 'starting' | 'running' | 'unreachable' | 'stopping';
export interface AuthoritySession {
  ownerKey: string;
  sessionId: string;
  lifecycleState: 'stopped' | WorkloadLifecycleState;
}
export interface SessionAuthority {
  getSession(ownerKey: string, sessionId: string): Promise<AuthoritySession | null>;
  listSessions(ownerKey: string): Promise<AuthoritySession[]>;
  deleteOwnerSessions(ownerKey: string): Promise<number>;
}

const WORKLOAD_STATES = new Set<string>(['starting', 'running', 'unreachable', 'stopping']);

export async function authorizeSession(
  authority: SessionAuthority,
  ownerKey: string,
  sessionId: string,
  _consumer: 'terminal' | 'vscode' | 'vault' | 'access',
): Promise<AuthoritySession> {
  const session = await authority.getSession(ownerKey, sessionId);
  if (!session) throw new NotFoundError('Session not found');
  return session;
}

export async function listWorkloadSessionIds(authority: SessionAuthority, ownerKey: string): Promise<string[]> {
  return (await authority.listSessions(ownerKey))
    .filter((session) => WORKLOAD_STATES.has(session.lifecycleState))
    .map((session) => session.sessionId);
}

export async function countWorkloadOwningSessions(authority: SessionAuthority, ownerKey: string, excludedSessionId?: string): Promise<number> {
  return (await authority.listSessions(ownerKey))
    .filter((session) => session.sessionId !== excludedSessionId && WORKLOAD_STATES.has(session.lifecycleState)).length;
}

export async function hasOwningSession(authority: SessionAuthority, ownerKey: string): Promise<boolean> {
  return (await authority.listSessions(ownerKey)).some((session) => WORKLOAD_STATES.has(session.lifecycleState));
}

export function deleteOwnerSessions(authority: SessionAuthority, ownerKey: string): Promise<number> {
  return authority.deleteOwnerSessions(ownerKey);
}
