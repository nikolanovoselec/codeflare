import type { Env } from '../../types';
import type { D1Session } from '../../lib/session-repository';
import { D1SessionRepository } from '../../lib/session-repository';

/** A stopping generation cannot be finalized until its exact Activity fence is durable. */
export async function fencePendingBoundaryStart(env: Env, repository: D1SessionRepository, session: D1Session): Promise<void> {
  const activityId = session.boundaryActivityId;
  if (!activityId) return;
  if (!env.OPERATOR_ACTIVITY) throw new Error('Boundary activity cancellation unavailable');
  const activity = env.OPERATOR_ACTIVITY.getByName(activityId);
  const binding = await activity.getBoundaryStartBinding(activityId);
  if (!binding || binding.session.bucket !== session.ownerKey
    || binding.session.sessionId !== session.sessionId
    || binding.session.generation !== session.lifecycleGeneration) {
    throw new Error('Boundary activity binding unavailable');
  }
  if (!(await activity.cancelBoundaryStart(binding)).ok) throw new Error('Boundary activity cancellation unavailable');
  if (!await repository.acknowledgeBoundaryCancellation(session.ownerKey, session.sessionId,
    session.lifecycleGeneration, activityId)) throw new Error('Boundary activity cancellation acknowledgement unavailable');
}
