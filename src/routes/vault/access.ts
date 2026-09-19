import type { Env } from '../../types';
import { D1SessionRepository, type D1Session } from '../../lib/session-repository';

/** Owner-scoped D1 guard for vault and Browser IDE access. */
export async function assertSessionOwnership(
  env: Env,
  bucketName: string,
  sessionId: string,
  jsonHeaders: Record<string, string>,
): Promise<{ session: D1Session } | { errorResponse: Response }> {
  const session = await new D1SessionRepository(env.USAGE_DB).getSession(bucketName, sessionId);
  if (!session) {
    return { errorResponse: new Response(JSON.stringify({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }), { status: 404, headers: jsonHeaders }) };
  }
  if (session.lifecycleState === 'stopped' || session.lifecycleState === 'stopping') {
    return { errorResponse: new Response(JSON.stringify({ error: 'Container stopped', code: 'CONTAINER_STOPPED' }), { status: 503, headers: jsonHeaders }) };
  }
  return { session };
}
