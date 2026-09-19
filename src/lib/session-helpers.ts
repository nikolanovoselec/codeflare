import type { Env, Session } from '../types';
import { D1SessionRepository } from './session-repository';

/** Strip internal ownership and housekeeping fields from API responses. */
export function toApiSession(session: Session) {
  const { userId: _userId, lastStatusCheck: _lastStatusCheck, ...apiSession } = session;
  return apiSession;
}

const ownsWorkload = (state: string) => state === 'starting' || state === 'running' || state === 'unreachable' || state === 'stopping';

/** Managed mutation fails closed when D1 authority is unavailable. */
export async function hasOwningSessionContainer(
  env: Pick<Env, 'USAGE_DB'>,
  bucketName: string,
): Promise<boolean> {
  const sessions = await new D1SessionRepository(env.USAGE_DB).listSessions(bucketName);
  return sessions.some((session) => ownsWorkload(session.lifecycleState));
}

/** Sessions that own a workload participate in sync fanout and governed drains. */
export async function listRunningSessionIds(
  env: Pick<Env, 'USAGE_DB'>,
  bucketName: string,
): Promise<string[]> {
  return (await new D1SessionRepository(env.USAGE_DB).listSessions(bucketName))
    .filter((session) => ownsWorkload(session.lifecycleState))
    .map((session) => session.sessionId);
}
