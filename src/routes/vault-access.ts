/**
 * Vault session-ownership guard (CF-024a extraction from vault.ts).
 *
 * Part of the vault auth chain: after authenticate -> origin -> tier, a
 * KV lookup confirms the authenticated user owns the requested session.
 * Behaviour (status codes, error codes) is identical to the previous
 * inline form in vault.ts.
 */
import type { Env, Session } from '../types';
import { getSessionKey } from '../lib/kv-keys';

/**
 * Session-ownership guard. A KV miss under the authenticated bucket
 * means the user does not own the session (different bucket, or it
 * never existed) -> 404. A stopped session -> 503. Returns the live
 * session + its KV key on success.
 */
export async function assertSessionOwnership(
  env: Env,
  bucketName: string,
  sessionId: string,
  jsonHeaders: Record<string, string>,
): Promise<{ session: Session; sessionKey: string } | { errorResponse: Response }> {
  // Session ownership: KV get on the session key for this bucket.
  // If KV does not have it under this bucket, the user does not own
  // the session (different bucket, or session never existed).
  const sessionKey = getSessionKey(bucketName, sessionId);
  const session = await env.KV.get<Session>(sessionKey, 'json');
  if (!session) {
    return {
      errorResponse: new Response(JSON.stringify({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }),
        { status: 404, headers: jsonHeaders }),
    };
  }
  if (session.status === 'stopped') {
    return {
      errorResponse: new Response(JSON.stringify({ error: 'Container stopped', code: 'CONTAINER_STOPPED' }),
        { status: 503, headers: jsonHeaders }),
    };
  }
  return { session, sessionKey };
}
