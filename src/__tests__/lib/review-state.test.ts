import { describe, it, expect } from 'vitest';
import { computeReviewStateFrom, type ComputeReviewStateInput } from '../../../preseed/agents/pi/extensions/review-job-helpers';

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
