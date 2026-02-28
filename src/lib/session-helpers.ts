import type { Session } from '../types';

/**
 * Strip userId and lastStatusCheck from a session for API responses.
 * Prevents leaking internal user identifiers and housekeeping fields to the client.
 */
export function toApiSession(session: Session) {
  const { userId: _userId, lastStatusCheck: _lastStatusCheck, ...apiSession } = session;
  return apiSession;
}
