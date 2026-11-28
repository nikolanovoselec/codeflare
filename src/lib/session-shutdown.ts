import type { D1Session } from './session-repository';

export type ShutdownPhase = 'queued' | 'retry-save' | 'saving' | 'save-failed' | 'consolidating'
  | 'finishing' | 'finishing-pending' | 'finishing-uncertain' | 'killing' | 'killing-uncertain'
  | 'memory-not-merged' | 'uncertain' | 'merged';

export interface SessionShutdown {
  intent: string;
  phase: ShutdownPhase;
  delete: boolean;
  /** First accepted Stop came from the idle timer; joining actions do not replace it. */
  idle?: true;
  snapshotId?: string;
  snapshotUnavailable?: true;
  deadline?: number;
  mergeVerified?: true;
  /** Confirmed result of an earlier deployed revision-based merge. */
  revision?: string;
  teardownClaimed?: true;
  /** Authenticated proof that this generation never opened its Hermes store. */
  hermesDisabledAtStartup?: true;
  /** A retry opens a new runtime generation, but merges the original saved bytes. */
  sourceGeneration?: number;
  resumed?: true;
  finalEventsAttempted?: true;
}

export function queuedStopTrigger(job: SessionShutdown | undefined, intent?: string): 'idle' | 'user' | undefined {
  if (!job || job.intent !== intent || job.sourceGeneration !== undefined || !job.phase.startsWith('finishing')) return;
  return job.idle ? 'idle' : 'user';
}

export function terminalFenced(job?: SessionShutdown): boolean {
  return !!job && job.phase !== 'queued' && job.phase !== 'memory-not-merged' && job.phase !== 'merged' && job.phase !== 'uncertain';
}

export function mergeNeedsRetry(job?: SessionShutdown): boolean {
  return job?.phase === 'memory-not-merged' || (job?.phase === 'merged' && job.revision !== undefined);
}

export function shutdownProjection(session: D1Session) {
  const job = session.shutdown;
  if (!job || (job.phase === 'merged' && !mergeNeedsRetry(job)) || (job.phase === 'uncertain' && job.resumed && session.lifecycleState !== 'stopped')) {
    return { status: session.lifecycleState };
  }
  const shutdownPhase = job.phase === 'save-failed' ? undefined
    : job.phase === 'retry-save' ? 'saving' : job.phase === 'uncertain' || mergeNeedsRetry(job) ? 'memory-not-merged'
    : job.phase.startsWith('finishing') || job.phase.startsWith('killing') ? 'finishing' : job.phase;
  const snapshotUnavailable = job.snapshotUnavailable || (session.lifecycleState === 'stopped'
    && mergeNeedsRetry(job) && !snapshotPattern.test(job.snapshotId ?? ''));
  const retryingMemory = job.sourceGeneration !== undefined && !mergeNeedsRetry(job) && job.phase !== 'uncertain';
  return {
    status: session.lifecycleState !== 'stopped' && terminalFenced(job) ? 'stopping' as const : session.lifecycleState,
    shutdownPhase,
    pendingDelete: job.delete,
    ...(snapshotUnavailable ? { snapshotUnavailable: true as const } : {}),
    ...(retryingMemory ? { retryingMemory: true as const } : {}),
  };
}

export const snapshotPattern = /^[a-f0-9]{64}$/;
