import type { Env, Session } from '../types';
import { getSessionPrefix, listAllKvKeys, expandSessionMetadata, type SessionListMetadata } from './kv-keys';
import { SESSION_ID_PATTERN } from './constants';

/**
 * Strip userId and lastStatusCheck from a session for API responses.
 * Prevents leaking internal user identifiers and housekeeping fields to the client.
 */
export function toApiSession(session: Session) {
  const { userId: _userId, lastStatusCheck: _lastStatusCheck, ...apiSession } = session;
  return apiSession;
}

/**
 * Enumerate the bucket's `running` session IDs from KV (the authoritative status store,
 * REQ-STOR-014). Uses the list-metadata fast path, falling back to a full KV.get for
 * pre-migration keys; every id is validated against SESSION_ID_PATTERN so a malformed key
 * can never flow downstream into getContainerId(). Shared by the sync fan-out
 * (REQ-STOR-015) and the Governed Mode migration drain (REQ-ENTERPRISE-018).
 */
export async function listRunningSessionIds(
  env: Pick<Env, 'KV'>,
  bucketName: string,
): Promise<string[]> {
  const keys = await listAllKvKeys(env.KV, getSessionPrefix(bucketName));
  const runningSessionIds: string[] = [];
  const fallbackKeys: Array<{ name: string }> = [];
  for (const key of keys) {
    const meta = key.metadata as SessionListMetadata | null;
    if (meta && meta.s) {
      if (expandSessionMetadata(meta).status === 'running') {
        const lastColon = key.name.lastIndexOf(':');
        const sid = lastColon >= 0 ? key.name.slice(lastColon + 1) : '';
        if (sid && SESSION_ID_PATTERN.test(sid)) runningSessionIds.push(sid);
      }
    } else {
      fallbackKeys.push(key);
    }
  }
  if (fallbackKeys.length > 0) {
    const fallbackSessions = await Promise.all(
      fallbackKeys.map((key) => env.KV.get<Session>(key.name, 'json')),
    );
    for (const session of fallbackSessions) {
      if (session && session.status === 'running' && SESSION_ID_PATTERN.test(session.id)) {
        runningSessionIds.push(session.id);
      }
    }
  }
  return runningSessionIds;
}
