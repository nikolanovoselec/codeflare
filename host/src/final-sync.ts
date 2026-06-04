/**
 * Completion detection for the awaited final sync (REQ-SESSION-011 AC2/AC3).
 *
 * The host endpoint POST /internal/final-sync triggers a fresh bisync (SIGUSR1
 * to the sync daemon) and must block until THAT run finishes, ignoring any
 * bisync already in flight when the trigger arrived. It distinguishes the two
 * purely by the sync-status record's monotonic `ts`, in two phases:
 *
 *   Phase 1 - wait for OUR run to start: accept a `syncing` whose ts is
 *   strictly after the trigger. The daemon stamps `syncing` with ts = now
 *   IMMEDIATELY before it scans the filesystem and runs bisync (entrypoint.sh),
 *   so a `syncing` after the trigger guarantees the scan that follows reads
 *   post-trigger filesystem state - i.e. it captures the user's last edits,
 *   which are already on disk before destroy()/stop triggers the drain.
 *
 *   Phase 2 - wait for that run's terminal transition: a `success`/`failed`
 *   stamped strictly newer than the observed `syncing`.
 *
 * The load-bearing invariant is that we accept a terminal status ONLY after
 * observing our run's `syncing`, never a bare `success`. An in-flight run's
 * `success` can also carry a ts after the trigger (it finished after the
 * trigger), but its scan predated the trigger, so accepting it could miss the
 * last edits. Gating on `syncing` (which precedes the scan) is what makes the
 * latch safe.
 *
 * The cost of that safety is a rare benign miss: if a triggered run writes
 * `syncing` then `success` within a single poll interval, the endpoint never
 * samples the `syncing` slot (last-write-wins file), so it times out and the
 * Durable Object falls through to stop best-effort - the data still synced.
 *
 * Pure and synchronous so it is unit-testable without spawning the daemon; the
 * endpoint owns the file read, the SIGUSR1, the poll interval and the timeout.
 */

export interface SyncStatusRecord {
  status?: string;
  ts?: number;
}

export type FinalSyncResult = 'pending' | 'success' | 'failed';

export interface FinalSyncEval {
  /** Carry forward into the next poll. -1 until OUR run's `syncing` is seen. */
  runStartedTs: number;
  result: FinalSyncResult;
}

export function evaluateFinalSync(
  s: SyncStatusRecord,
  triggerTs: number,
  runStartedTs: number,
): FinalSyncEval {
  const ts = typeof s.ts === 'number' ? s.ts : 0;
  if (runStartedTs < 0) {
    // Phase 1: ignore an in-flight run (its syncing ts predates the trigger)
    // and any bare terminal status (no qualifying syncing observed yet). The
    // comparison is STRICT (> not >=): an in-flight run that stamped `syncing`
    // in the same epoch-ms as the trigger, or whose pre-trigger stamp lands at
    // >= trigger under an intra-host clock step-back (NTP / VM pause-resume),
    // must not be mistaken for our run. Our own run's `syncing` is stamped only
    // after the daemon wakes on the signal and runs its cleanup, so it lands
    // strictly after the trigger in practice; the pathological same-ms own-run
    // case degrades to the benign timeout->best-effort-stop path, not loss.
    if (s.status === 'syncing' && ts > triggerTs) {
      return { runStartedTs: ts, result: 'pending' };
    }
    return { runStartedTs: -1, result: 'pending' };
  }
  // Phase 2: our run started; accept only its terminal transition (newer ts).
  if (ts > runStartedTs) {
    if (s.status === 'success') return { runStartedTs, result: 'success' };
    if (s.status === 'failed') return { runStartedTs, result: 'failed' };
  }
  return { runStartedTs, result: 'pending' };
}
