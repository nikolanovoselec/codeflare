import type { D1Session } from './session-repository';

export type ShutdownPhase = 'queued' | 'retry-save' | 'saving' | 'save-failed' | 'consolidating'
  | 'finishing' | 'finishing-pending' | 'finishing-uncertain' | 'killing' | 'killing-uncertain'
  | 'memory-not-merged' | 'uncertain' | 'merged';

export interface SessionShutdown {
  intent: string;
  phase: ShutdownPhase;
  delete: boolean;
  snapshotId?: string;
  deadline?: number;
  revision?: string;
  teardownClaimed?: true;
  /** A retry opens a new runtime generation, but merges the original saved bytes. */
  sourceGeneration?: number;
  resumed?: true;
  finalEventsAttempted?: true;
}

export function terminalFenced(job?: SessionShutdown): boolean {
  return !!job && job.phase !== 'queued' && job.phase !== 'memory-not-merged' && job.phase !== 'merged' && job.phase !== 'uncertain';
}

export function shutdownProjection(session: D1Session) {
  const job = session.shutdown;
  if (!job || job.phase === 'merged' || (job.phase === 'uncertain' && job.resumed && session.lifecycleState !== 'stopped')) {
    return { status: session.lifecycleState };
  }
  const shutdownPhase = job.phase === 'save-failed' ? undefined
    : job.phase === 'retry-save' ? 'saving' : job.phase === 'uncertain' ? 'memory-not-merged'
    : job.phase.startsWith('finishing') || job.phase.startsWith('killing') ? 'finishing' : job.phase;
  const retryingMemory = job.sourceGeneration !== undefined && job.phase !== 'memory-not-merged' && job.phase !== 'uncertain';
  return {
    status: session.lifecycleState !== 'stopped' && terminalFenced(job) ? 'stopping' as const : session.lifecycleState,
    shutdownPhase,
    pendingDelete: job.delete,
    ...(retryingMemory ? { retryingMemory: true as const } : {}),
  };
}

export const snapshotPattern = /^[a-f0-9]{64}$/;
