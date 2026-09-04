import { getContainer } from '@cloudflare/containers';
import type { Env, Session } from '../types';
import { getSessionPrefix, listAllKvKeys, expandSessionMetadata, type SessionListMetadata } from './kv-keys';
import { SESSION_ID_PATTERN } from './constants';
import { getContainerId } from './container-helpers';

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
 * (REQ-STOR-015) and the Governed Mode migration drain (REQ-ENTERPRISE-020).
 */
/**
 * Resolve managed-mutation ownership from persisted Container SDK state rather
 * than eventually-consistent KV status/metadata. Every session record is checked
 * because either KV view can independently be stale. Unknown state fails closed.
 */
export async function hasOwningSessionContainer(
  env: Pick<Env, 'KV' | 'CONTAINER'>,
  bucketName: string,
): Promise<boolean> {
  let keys: Awaited<ReturnType<typeof listAllKvKeys>>;
  try {
    keys = await listAllKvKeys(env.KV, getSessionPrefix(bucketName));
  } catch {
    return true;
  }

  for (const key of keys) {
    const lastColon = key.name.lastIndexOf(':');
    const sessionId = lastColon >= 0 ? key.name.slice(lastColon + 1) : '';
    if (!SESSION_ID_PATTERN.test(sessionId)) return true;
    try {
      const state = await getContainer(env.CONTAINER, getContainerId(bucketName, sessionId)).getState();
      if (state.status !== 'stopped' && state.status !== 'stopped_with_code') return true;
    } catch {
      return true;
    }
  }
  return false;
}

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
