import type { Env, Session } from '../types';
import { getSessionPrefix, getSessionStatusCorrectionPrefix, listAllKvKeys, expandSessionMetadata, type SessionListMetadata, type SessionStatusCorrectionMetadata } from './kv-keys';
import { SESSION_ID_PATTERN } from './constants';

/**
 * Strip private fields and legacy inline runtime snapshots from general session
 * responses. Batch status is the sole current readiness/metrics projection.
 */
export function toApiSession(session: Session) {
  const {
    userId: _userId,
    lastStatusCheck: _lastStatusCheck,
    metrics: _legacyMetrics,
    editorReady: _legacyEditorReady,
    editorReadyError: _legacyEditorReadyError,
    ...apiSession
  } = session;
  return apiSession;
}

/**
 * Enumerate the bucket's `running` session IDs from KV (the authoritative status store,
 * REQ-STOR-014). Uses the list-metadata fast path, falling back to a full KV.get for
 * pre-migration keys; every id is validated against SESSION_ID_PATTERN so a malformed key
 * can never flow downstream into getContainerId(). Shared by the sync fan-out
 * (REQ-STOR-015) and the Governed Mode migration drain (REQ-ENTERPRISE-020).
 */
export async function listRunningSessionIds(
  env: Pick<Env, 'KV'>,
  bucketName: string,
): Promise<string[]> {
  const [keys, correctionKeys] = await Promise.all([
    listAllKvKeys(env.KV, getSessionPrefix(bucketName)),
    listAllKvKeys(env.KV, getSessionStatusCorrectionPrefix(bucketName)),
  ]);
  const correctedRunningIds = new Set(correctionKeys
    .filter((key) => (key.metadata as SessionStatusCorrectionMetadata | null)?.r === 1)
    .map((key) => key.name.split(':').pop()!));
  const runningSessionIds: string[] = [];
  const fallbackKeys: Array<{ name: string }> = [];
  for (const key of keys) {
    const meta = key.metadata as SessionListMetadata | null;
    if (meta && meta.s) {
      const lastColon = key.name.lastIndexOf(':');
      const sid = lastColon >= 0 ? key.name.slice(lastColon + 1) : '';
      if ((expandSessionMetadata(meta).status === 'running' || correctedRunningIds.has(sid))
        && sid && SESSION_ID_PATTERN.test(sid)) runningSessionIds.push(sid);
    } else {
      fallbackKeys.push(key);
    }
  }
  if (fallbackKeys.length > 0) {
    const fallbackSessions = await Promise.all(
      fallbackKeys.map((key) => env.KV.get<Session>(key.name, 'json')),
    );
    for (const session of fallbackSessions) {
      if (session && (session.status === 'running' || correctedRunningIds.has(session.id)) && SESSION_ID_PATTERN.test(session.id)) {
        runningSessionIds.push(session.id);
      }
    }
  }
  return runningSessionIds;
}
