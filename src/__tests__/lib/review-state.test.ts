import { describe, it, expect } from 'vitest';
import { computeReviewStateFrom, shouldReconcileOpenPr, reconcileBoundaryAction, reviewBaselineContinuation, resolveReviewRepo, type ComputeReviewStateInput, type OpenPrReconcileInput, type ReconcileBoundaryInput } from '../../../preseed/agents/pi/extensions/review-job-helpers';

/**
 * computeReviewStateFrom is the canonical review-state definition (review.md §17.2).
 * These tests pin the lane-status precedence (result > failed > running > pending),
 * the overall aggregation, and the acked/breaker semantics. Break the precedence or
 * the aggregation and a test fails — there is no implementation to gut while staying green.
 */
const base: ComputeReviewStateInput = {
  repo: '/repo',
  head: 'abc123',
  lanes: ['code-reviewer', 'spec-reviewer', 'doc-updater'],
  laneJobStatus: () => undefined,
  resultLaneExists: () => false,
  runningInMemory: () => false,
  ackHead: '',
  breakerHead: '',
  attempts: 0,
  autofixRequested: false,
};

describe('computeReviewStateFrom (REQ-AGENT-057 AC1)', () => {
  it('reports all lanes pending when nothing has happened', () => {
    const s = computeReviewStateFrom({ ...base });
    expect(s.overall).toBe('pending');
    expect(s.laneStatus['code-reviewer']).toBe('pending');
    expect(s.summaryReady).toBe(false);
    expect(s.acked).toBe(false);
  });

  it('treats result .md existence as completed even if the job record still says running', () => {
    const s = computeReviewStateFrom({
      ...base,
      laneJobStatus: (lane) => (lane === 'code-reviewer' ? 'running' : undefined),
      resultLaneExists: (lane) => lane === 'code-reviewer',
    });
    expect(s.laneStatus['code-reviewer']).toBe('completed');
  });

  it('reports running when a lane is running and none failed', () => {
    const s = computeReviewStateFrom({ ...base, runningInMemory: (lane) => lane === 'spec-reviewer' });
    expect(s.overall).toBe('running');
    expect(s.laneStatus['spec-reviewer']).toBe('running');
    expect(s.laneStatus['code-reviewer']).toBe('pending');
  });

  it('lets failed dominate the overall verdict over running and pending', () => {
    const s = computeReviewStateFrom({
      ...base,
      laneJobStatus: (lane) => (lane === 'code-reviewer' ? 'failed' : 'running'),
    });
    expect(s.overall).toBe('failed');
  });

  it('is complete + summaryReady only when every lane has a result', () => {
    const s = computeReviewStateFrom({ ...base, resultLaneExists: () => true });
    expect(s.overall).toBe('complete');
    expect(s.summaryReady).toBe(true);
  });

  it('acks only when ackHead equals a non-empty head', () => {
    expect(computeReviewStateFrom({ ...base, ackHead: 'abc123' }).acked).toBe(true);
    expect(computeReviewStateFrom({ ...base, ackHead: 'other' }).acked).toBe(false);
    expect(computeReviewStateFrom({ ...base, head: '', ackHead: '' }).acked).toBe(false);
  });

  it('opens the breaker only when breakerHead equals the head', () => {
    expect(computeReviewStateFrom({ ...base, breakerHead: 'abc123' }).breakerOpen).toBe(true);
    expect(computeReviewStateFrom({ ...base, breakerHead: 'other' }).breakerOpen).toBe(false);
  });

  it('reports none when no lanes are required for the head', () => {
    const s = computeReviewStateFrom({ ...base, lanes: [] });
    expect(s.overall).toBe('none');
    expect(s.summaryReady).toBe(false);
  });
});

/**
 * shouldReconcileOpenPr is the pure decision behind open-PR reconciliation (REQ-AGENT-058 AC1).
 * It encodes the narrow, bounded path REQ-036 AC7 permits: reconcile ONLY an OPEN, non-draft,
 * ENFORCED main/master PR whose resolved head is unacknowledged with no review window and no
 * open breaker. Every other case must NOT reconcile — these tests fail if any gate regresses
 * (which would either re-introduce passive PR-existence triggering, or silently miss boundaries).
 */
describe('shouldReconcileOpenPr (REQ-AGENT-058 AC1)', () => {
  // The one shape that SHOULD reconcile; each test flips exactly one field to prove the gate.
  const reconcilable: OpenPrReconcileInput = {
    prOpen: true,
    prDraft: false,
    enforced: true,
    head: 'abc123',
    acked: false,
    hasReviewJob: false,
    reviewActive: false,
    breakerOpen: false,
  };

  it('reconciles an open, non-draft, enforced PR with an unacked head and no window/breaker', () => {
    expect(shouldReconcileOpenPr(reconcilable).reconcile).toBe(true);
  });

  it('does NOT reconcile when there is no open PR', () => {
    expect(shouldReconcileOpenPr({ ...reconcilable, prOpen: false }).reconcile).toBe(false);
  });

  it('does NOT reconcile a draft PR', () => {
    expect(shouldReconcileOpenPr({ ...reconcilable, prDraft: true }).reconcile).toBe(false);
  });

  it('does NOT reconcile a non-enforced PR (base not main/master, or not an SDD project)', () => {
    expect(shouldReconcileOpenPr({ ...reconcilable, enforced: false }).reconcile).toBe(false);
  });

  it('does NOT reconcile when the enforced head cannot be resolved', () => {
    const d = shouldReconcileOpenPr({ ...reconcilable, head: '' });
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('no resolvable enforced head');
  });

  it('does NOT reconcile a head that is already acknowledged', () => {
    expect(shouldReconcileOpenPr({ ...reconcilable, acked: true }).reconcile).toBe(false);
  });

  it('does NOT reconcile when a review window already exists (job present or lanes active)', () => {
    expect(shouldReconcileOpenPr({ ...reconcilable, hasReviewJob: true }).reconcile).toBe(false);
    expect(shouldReconcileOpenPr({ ...reconcilable, reviewActive: true }).reconcile).toBe(false);
  });

  it('does NOT reconcile when the review breaker is open for the head', () => {
    const d = shouldReconcileOpenPr({ ...reconcilable, breakerOpen: true });
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('review breaker open for head');
  });
});

/**
 * reconcileBoundaryAction is the action gate for a missed-boundary PR head (REQ-AGENT-058
 * revised). The locked design: an in-session continuation (the missed head DESCENDS from a
 * previously-acked head, i.e. the onToolEnd auto-start was dropped by a compound `&&`/here-doc/
 * `gh pr edit`/reload) AUTO-STARTS the review just like the onToolEnd boundary path; a fresh
 * clone/checkout (no prior ack to descend from) is OFFERED once; a re-offer of an already-offered
 * clone head NOOPs; and a non-reconcilable head always NOOPs. These tests fail if the
 * autostart/offer/noop branching regresses — the reconciler's only behaviour on a missed
 * boundary is one of these three actions.
 */
describe('reconcileBoundaryAction (REQ-AGENT-058 revised: autostart in-session, offer-once on clone)', () => {
  it('AUTO-STARTS an in-session continuation (missed onToolEnd auto-start), even when not yet offered', () => {
    const input: ReconcileBoundaryInput = { reconcile: true, alreadyOffered: false, inSessionContinuation: true };
    expect(reconcileBoundaryAction(input)).toBe('autostart');
  });

  it('AUTO-STARTS an in-session continuation regardless of a prior offer on the same head', () => {
    const input: ReconcileBoundaryInput = { reconcile: true, alreadyOffered: true, inSessionContinuation: true };
    expect(reconcileBoundaryAction(input)).toBe('autostart');
  });

  it('offers a fresh-clone reconcilable head (no continuation) that has not been offered yet', () => {
    const input: ReconcileBoundaryInput = { reconcile: true, alreadyOffered: false, inSessionContinuation: false };
    expect(reconcileBoundaryAction(input)).toBe('offer');
  });

  it('noops on a re-offer of the same already-offered clone head (offered once, not twice)', () => {
    const input: ReconcileBoundaryInput = { reconcile: true, alreadyOffered: true, inSessionContinuation: false };
    expect(reconcileBoundaryAction(input)).toBe('noop');
  });

  it('noops when the head is not reconcilable, regardless of offered/continuation state', () => {
    expect(reconcileBoundaryAction({ reconcile: false, alreadyOffered: false, inSessionContinuation: false })).toBe('noop');
    expect(reconcileBoundaryAction({ reconcile: false, alreadyOffered: true, inSessionContinuation: false })).toBe('noop');
    expect(reconcileBoundaryAction({ reconcile: false, alreadyOffered: false, inSessionContinuation: true })).toBe('noop');
  });
});

/**
 * reviewBaselineContinuation feeds reconcileBoundaryAction's `inSessionContinuation` flag.
 * It decides continuation from an IN-MEMORY per-session baseline (the head this Pi session
 * first observed), NOT the on-disk ack. That distinction is the bug-A fix: keying off the
 * on-disk ack made every fresh `pi` launch whose head descended from a prior ack report
 * continuation → auto-start reviewers on launch (regression: "offering worked yesterday").
 * Continuation is true ONLY when the head ADVANCED beyond the baseline during this session.
 * These fail if a bare launch (baseline undefined or unchanged) is ever treated as
 * continuation, or if a genuine in-session advance stops being treated as one.
 */
describe('reviewBaselineContinuation (bug-A fix: offer on launch, autostart only on in-session advance)', () => {
  const descends = () => true;   // isAncestor stub: head descends from baseline
  const unrelated = () => false; // isAncestor stub: head does NOT descend from baseline

  it('returns false on the first reconcile of a session (baseline undefined → fresh launch offers)', () => {
    expect(reviewBaselineContinuation(undefined, 'headsha', descends)).toBe(false);
  });

  it('returns false when the head is unchanged since the session baseline (relaunch on same head offers)', () => {
    expect(reviewBaselineContinuation('samehead', 'samehead', descends)).toBe(false);
  });

  it('returns true when the head advanced beyond the baseline and descends from it (dropped in-session push)', () => {
    expect(reviewBaselineContinuation('basehead', 'newhead', descends)).toBe(true);
  });

  it('returns false when the new head does not descend from the baseline (unrelated branch, not a continuation)', () => {
    expect(reviewBaselineContinuation('basehead', 'newhead', unrelated)).toBe(false);
  });

  it('returns false for an empty head regardless of baseline', () => {
    expect(reviewBaselineContinuation('basehead', '', descends)).toBe(false);
  });
});

/**
 * resolveReviewRepo picks the repo a review handler acts on FROM ITS OWN candidate dirs, never the
 * shared graphify active-cwd sentinel (a cross-agent file that flaps to whichever agent acted
 * last). These fail if the precedence regresses, or if the resolver ever reaches outside its given
 * candidates — the regression that left a nested-repo review with no footer and no finalize because
 * the sentinel pointed at the outer repo Claude was in.
 */
describe('resolveReviewRepo (review-repo resolution detached from the graphify sentinel)', () => {
  const roots: Record<string, string> = {
    '/ws/ai-news-digest/src': '/ws/ai-news-digest',
    '/ws/ai-news-digest': '/ws/ai-news-digest',
    '/ws': '/ws',
    '/pi/proc': '/pi/proc-repo',
  };
  const gitRootOf = (dir: string): string | undefined => roots[dir];

  it('prefers an explicit command cwd over the session cwd (boundary `cd <repo> && git push`)', () => {
    expect(resolveReviewRepo({ commandCwd: '/ws/ai-news-digest', sessionCwd: '/ws' }, gitRootOf)).toBe('/ws/ai-news-digest');
  });

  it('falls back to the session cwd (walked up to its git root) when there is no command cwd', () => {
    expect(resolveReviewRepo({ sessionCwd: '/ws/ai-news-digest/src' }, gitRootOf)).toBe('/ws/ai-news-digest');
  });

  it('uses the remembered in-session review repo for the no-ctx reaper, before the process cwd', () => {
    expect(resolveReviewRepo({ sessionReviewRepo: '/ws/ai-news-digest', processCwd: '/pi/proc' }, gitRootOf)).toBe('/ws/ai-news-digest');
  });

  it('falls back to the process cwd only when nothing else resolves', () => {
    expect(resolveReviewRepo({ processCwd: '/pi/proc' }, gitRootOf)).toBe('/pi/proc-repo');
  });

  it('returns undefined when no candidate resolves and there is no remembered repo', () => {
    expect(resolveReviewRepo({ sessionCwd: '/tmp/not-a-repo' }, gitRootOf)).toBeUndefined();
  });

  it('only ever probes the candidate dirs it was given — never an external sentinel path', () => {
    const seen: string[] = [];
    const tracking = (dir: string): string | undefined => { seen.push(dir); return roots[dir]; };
    resolveReviewRepo({ commandCwd: '/ws/ai-news-digest', sessionCwd: '/ws', processCwd: '/pi/proc' }, tracking);
    expect(seen).toEqual(['/ws/ai-news-digest']); // short-circuits on the first resolving candidate
    expect(seen).not.toContain('/home/user/.cache/codeflare-hooks/graphify-active-cwd');
  });
});

/**
 * REQ-AGENT-058 AC4: a boundary-shaped command that does not start a review appends a
 * durable `boundary_candidate_ignored` audit event NAMING the gate reason, so a skipped
 * review is always reconstructable from disk (never-silent). reconcileOpenPrReview stamps
 * `decision.reason` from shouldReconcileOpenPr verbatim into that event, so the audit's
 * diagnostic value rests entirely on the decision surfacing a specific, non-empty reason
 * per gate. These fail if any gate regresses to a bare/duplicated reason — which would make
 * one ignored boundary indistinguishable from another in the event log.
 */
describe('REQ-AGENT-058 AC4: every suppressed reconcile gate names its own reason (boundary_candidate_ignored)', () => {
  const reconcilable: OpenPrReconcileInput = {
    prOpen: true,
    prDraft: false,
    enforced: true,
    head: 'abc123',
    acked: false,
    hasReviewJob: false,
    reviewActive: false,
    breakerOpen: false,
  };
  const gates: Array<[string, OpenPrReconcileInput]> = [
    ['no open PR', { ...reconcilable, prOpen: false }],
    ['draft', { ...reconcilable, prDraft: true }],
    ['not enforced', { ...reconcilable, enforced: false }],
    ['no head', { ...reconcilable, head: '' }],
    ['acked', { ...reconcilable, acked: true }],
    ['breaker open', { ...reconcilable, breakerOpen: true }],
    ['window exists', { ...reconcilable, hasReviewJob: true }],
  ];

  it('every suppressed gate yields reconcile=false with a non-empty reason to stamp', () => {
    for (const [, input] of gates) {
      const d = shouldReconcileOpenPr(input);
      expect(d.reconcile).toBe(false);
      expect(d.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('each gate names a DISTINCT reason so the audit event identifies which gate fired', () => {
    const reasons = gates.map(([, input]) => shouldReconcileOpenPr(input).reason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});
