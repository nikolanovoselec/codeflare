import type { Session } from '../types';

/**
 * Strip userId from a session for API responses.
 * Prevents leaking internal user identifiers to the client.
 */
export function toApiSession(session: Session) {
  const { userId: _userId, lastStatusCheck: _lastStatusCheck, ...apiSession } = session;
  return apiSession;
}
