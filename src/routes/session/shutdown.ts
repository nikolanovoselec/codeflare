import { getContainer } from '@cloudflare/containers';
import type { Env } from '../../types';
import { getContainerId } from '../../lib/container-helpers';
import { getBucketStorageOwner } from '../../lib/r2-migration';
import { isEnterpriseMode } from '../../lib/subscription';
import { mergeNeedsRetry } from '../../lib/session-shutdown';
import type { D1Session } from '../../lib/session-repository';
import type { SessionStopRequest } from '../../container/container-lifecycle';

/** Ordinary lifecycle stays on the existing route unless this generation
 * actually opened an Enterprise direct Hermes store. */
export async function maybeQueueShutdown(env: Env, session: D1Session, remove: boolean): Promise<Response | null> {
  if (!isEnterpriseMode(env)) return null;
  const { ownerKey: bucket, sessionId, lifecycleGeneration: generation, shutdown } = session;
  if (shutdown?.phase === 'uncertain') {
    await getBucketStorageOwner(env, bucket).wakeHermesShutdownQueue(bucket);
    return Response.json({ error: 'Previous memory publication is not yet confirmed' }, { status: 409 });
  }
  if (session.lifecycleState === 'stopped' || shutdown?.phase.startsWith('killing')) {
    if (shutdown && (shutdown.phase !== 'merged' || mergeNeedsRetry(shutdown))) return Response.json({ error: 'Session shutdown has not settled' }, { status: 409 });
    return null;
  }
  const addressed = getContainer(env.CONTAINER, getContainerId(bucket, sessionId)) as unknown as {
    canQueueHermesShutdown(input: SessionStopRequest): Promise<boolean>;
  };
  const input = { bucket, sessionId, generation };
  if (!shutdown && (session.lifecycleState !== 'running' || !await addressed.canQueueHermesShutdown(input))) return null;
  const result = await getBucketStorageOwner(env, bucket).enqueueHermesShutdown({ ...input, delete: remove });
  if (!result.accepted) return Response.json({ error: 'Session shutdown authority changed' }, { status: 409 });
  return Response.json({ success: true, id: sessionId, ...result.projection }, { status: 202 });
}
