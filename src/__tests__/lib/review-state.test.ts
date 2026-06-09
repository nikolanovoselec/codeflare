import { describe, it, expect } from 'vitest';
import { computeReviewStateFrom, shouldReconcileOpenPr, reconcileBoundaryAction, type ComputeReviewStateInput, type OpenPrReconcileInput, type ReconcileBoundaryInput } from '../../../preseed/agents/pi/extensions/review-job-helpers';

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
 * reconcileBoundaryAction is the offers-once decision for a missed-boundary PR head
 * (REQ-AGENT-058 revised). It must OFFER a reconcilable head exactly once and NOOP on a
 * re-offer of the same (already-offered) head, and NOOP whenever the head is not
 * reconcilable. These tests fail if the offer/noop branching regresses — there is no
 * implementation to gut while staying green (the reconciler's only behaviour on a missed
 * boundary is to offer or not).
 */
describe('reconcileBoundaryAction (REQ-AGENT-058 revised: offer-once, never auto-spawn)', () => {
  it('offers when the head is reconcilable and has not been offered yet', () => {
    const input: ReconcileBoundaryInput = { reconcile: true, alreadyOffered: false };
    expect(reconcileBoundaryAction(input)).toBe('offer');
  });

  it('noops on a re-offer of the same already-offered head (offered once, not twice)', () => {
    const input: ReconcileBoundaryInput = { reconcile: true, alreadyOffered: true };
    expect(reconcileBoundaryAction(input)).toBe('noop');
  });

  it('noops when the head is not reconcilable, regardless of offered state', () => {
    expect(reconcileBoundaryAction({ reconcile: false, alreadyOffered: false })).toBe('noop');
    expect(reconcileBoundaryAction({ reconcile: false, alreadyOffered: true })).toBe('noop');
  });
});
