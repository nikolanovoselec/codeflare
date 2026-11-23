import type { Env } from '../types';
import { getContainerId } from '../lib/container-helpers';
import { D1SessionRepository } from '../lib/session-repository';
import { shutdownProjection, snapshotPattern, type SessionShutdown, type ShutdownPhase } from '../lib/session-shutdown';
import type { SessionStopRequest } from './container-lifecycle';
import { reconcileHermesPublication } from './hermes-shutdown-readback';

export type ShutdownRequest = SessionStopRequest & { delete: boolean; retry?: true };
export type ShutdownAcceptance = { accepted: false } | { accepted: true; projection: ReturnType<typeof shutdownProjection> };
interface ShutdownSession {
  saveAndMergeHermes(input: SessionStopRequest, intent: string, saveRetryAt: number): Promise<void>;
  finishHermesShutdown(input: SessionStopRequest, intent: string): Promise<void>;
  retrySavedHermes(input: SessionStopRequest, intent: string): Promise<void>;
}

// Recovery may report an interrupted save after the Host budget. Elapsed
// time is not a save acknowledgement and does not authorize another sync.
export const SAVE_RECOVERY_WINDOW_MS = 130_000;
export const MERGE_READBACK_WINDOW_MS = 5_000;

export async function acceptShutdown(repository: D1SessionRepository, input: ShutdownRequest): Promise<ShutdownAcceptance> {
  for (;;) {
    const row = await repository.getSession(input.bucket, input.sessionId);
    if (!row || row.lifecycleGeneration !== input.generation) return { accepted: false };
    const job = row.shutdown;
    if (input.retry) {
      if (row.lifecycleState !== 'stopped' || !job?.snapshotId || !snapshotPattern.test(job.snapshotId)) return { accepted: false };
      if (job.phase === 'queued' && job.sourceGeneration !== undefined) return { accepted: true, projection: shutdownProjection(row) };
      if (job.phase !== 'memory-not-merged') return { accepted: false };
      const next: SessionShutdown = { ...job, phase: 'queued', sourceGeneration: job.sourceGeneration ?? row.lifecycleGeneration,
        deadline: undefined, teardownClaimed: undefined };
      if (await repository.updateShutdown(row, next)) return { accepted: true, projection: shutdownProjection({ ...row, shutdown: next }) };
      continue;
    }
    if (row.lifecycleState === 'stopped' || job?.phase.startsWith('killing') || job?.phase === 'uncertain') return { accepted: false };
    const retrySave = job?.phase === 'save-failed' && job.deadline === undefined;
    if (job?.phase === 'save-failed' && !retrySave && !(input.delete && !job.delete)) return { accepted: false };
    if (retrySave && row.lifecycleState !== 'running') return { accepted: false };
    const next: SessionShutdown = !job ? { intent: crypto.randomUUID(), delete: input.delete, phase: 'queued' }
      : { ...job, delete: job.delete || input.delete, ...(retrySave ? { phase: 'retry-save' } : {}) };
    if (!job && (row.lifecycleState !== 'running' || row.terminationIntentId)) return { accepted: false };
    if (JSON.stringify(next) === JSON.stringify(job) || await repository.updateShutdown(row, next)) {
      return { accepted: true, projection: shutdownProjection({ ...row, shutdown: next }) };
    }
  }
}

/** Only write a result using the still-current intent and phase. A concurrent
 * Delete can promote the intent without making an in-flight save/merge stale. */
export async function transitionShutdown(repository: D1SessionRepository, input: SessionStopRequest, intent: string,
  phase: ShutdownPhase, change: (job: SessionShutdown) => SessionShutdown | undefined): Promise<boolean> {
  for (;;) {
    const row = await repository.getSession(input.bucket, input.sessionId);
    if (!row || row.lifecycleGeneration !== input.generation || row.shutdown?.intent !== intent || row.shutdown.phase !== phase) return false;
    if (await repository.updateShutdown(row, change(row.shutdown))) return true;
  }
}

export async function advanceShutdownQueue(env: Env, bucket: string): Promise<void> {
  const repository = new D1SessionRepository(env.USAGE_DB);
  for (;;) {
    const row = await repository.shutdownHead(bucket);
    if (!row?.shutdown) return;
    const job = row.shutdown;
    const input = { bucket, sessionId: row.sessionId, generation: row.lifecycleGeneration };
    const session = env.CONTAINER.getByName(getContainerId(bucket, row.sessionId)) as unknown as ShutdownSession;
    const transition = (change: (current: SessionShutdown) => SessionShutdown | undefined) =>
      transitionShutdown(repository, input, job.intent, job.phase, change);
    if (job.phase === 'uncertain') {
      const signal = AbortSignal.timeout(MERGE_READBACK_WINDOW_MS);
      const revision = await raceAbort(signal, () => reconcileHermesPublication(env, row, signal)).catch(() => undefined);
      if (!revision) return;
      // A resumed runtime keeps its own store; late proof settles publication only.
      await transition(current => current.resumed ? undefined : { ...current, phase: 'finishing', revision });
      continue;
    }
    if (row.lifecycleState === 'stopped') {
      if (job.phase === 'queued' && job.sourceGeneration !== undefined) {
        await session.retrySavedHermes(input, job.intent);
        continue;
      }
      if (job.phase === 'finishing') {
        if (job.delete && job.teardownClaimed) await repository.deleteAfterShutdown(row);
        else await transition(current => current.revision ? { ...current, phase: 'merged' } : undefined);
      } else if (job.phase === 'consolidating' || job.phase.endsWith('-uncertain')) {
        await transition(current => ({ ...current, phase: 'uncertain', sourceGeneration: current.sourceGeneration ?? row.lifecycleGeneration }));
      } else if (job.phase === 'killing' && job.revision) {
        await transition(current => ({ ...current, phase: 'merged' }));
      } else if (job.phase === 'finishing-pending') {
        await transition(current => ({ ...current, phase: 'memory-not-merged' }));
      } else {
        // Exit outside the graceful path or an acknowledged Kill. No inferred save or Delete.
        await transition(() => undefined);
      }
      continue;
    }
    switch (job.phase) {
      case 'queued':
      case 'retry-save':
        if (row.lifecycleState !== 'running' || row.terminationIntentId) return;
        {
          const saveRetryAt = Date.now() + SAVE_RECOVERY_WINDOW_MS;
          if (!await repository.updateShutdown(row, { ...job, phase: 'saving', deadline: saveRetryAt })) break;
          await session.saveAndMergeHermes(input, job.intent, saveRetryAt);
        }
        break;
      case 'saving':
        // Only the invocation that performed the transition may dispatch the save.
        // A replacement coordinator must not silently retry a possibly accepted request.
        if (Date.now() < (job.deadline ?? 0)) return;
        await transition(current => ({ ...current, phase: 'save-failed' }));
        break;
      case 'consolidating':
        if (Date.now() < (job.deadline ?? 0) + MERGE_READBACK_WINDOW_MS) return;
        await transition(current => ({ ...current, phase: 'finishing-uncertain' }));
        break;
      case 'finishing':
      case 'finishing-pending':
      case 'finishing-uncertain':
        await session.finishHermesShutdown(input, job.intent);
        break;
      default:
        return;
    }
  }
}

/** Bound the caller even if a private port ignores transport cancellation. */
export async function raceAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([run(), interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}
