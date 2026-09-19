import { describe, expect, it } from 'vitest';
import {
  openUnreachableIncident,
  recoverUnreachableIncident,
  claimExpiredTermination,
  canSignalTermination,
  confirmProcessExit,
} from '../../lib/session-runtime-policy';

const running = {
  lifecycleState: 'running' as const,
  lifecycleGeneration: 7,
  responseRevision: 12,
  observationSequence: 4,
  unreachableIncidentId: null,
  unreachableFirstObservedAt: null,
  unreachableDeadlineMs: null,
  terminationIntentId: null,
  terminationGeneration: null,
};

describe('REQ-SESSION-021/022/024: bounded UNREACHABLE policy', () => {
  it('opens one deterministic incident with an absolute 120-second deadline', () => {
    const opened = openUnreachableIncident(running, {
      generation: 7,
      incidentId: 'incident-7-a',
      observedAtMs: 1_000_000,
    });
    expect(opened).toMatchObject({
      lifecycleState: 'unreachable',
      unreachableIncidentId: 'incident-7-a',
      unreachableFirstObservedAt: 1_000_000,
      unreachableDeadlineMs: 1_120_000,
      responseRevision: 13,
    });

    expect(openUnreachableIncident(opened, {
      generation: 7,
      incidentId: 'incident-7-b',
      observedAtMs: 1_060_000,
    })).toEqual(opened);
  });

  it('reconstruction preserves the assigned generation, incident, and deadline', () => {
    const opened = openUnreachableIncident(running, {
      generation: 7,
      incidentId: 'incident-7-a',
      observedAtMs: 1_000_000,
    });
    const reconstructed = openUnreachableIncident(opened, {
      generation: 7,
      incidentId: 'incident-7-a',
      observedAtMs: 1_100_000,
    });
    expect(reconstructed.unreachableDeadlineMs).toBe(1_120_000);
    expect(reconstructed.lifecycleGeneration).toBe(7);
  });

  it('recovers only the matching current-generation incident', () => {
    const opened = openUnreachableIncident(running, {
      generation: 7,
      incidentId: 'incident-7-a',
      observedAtMs: 1_000_000,
    });
    expect(recoverUnreachableIncident(opened, { generation: 6, incidentId: 'incident-7-a' })).toEqual(opened);
    expect(recoverUnreachableIncident(opened, { generation: 7, incidentId: 'wrong' })).toEqual(opened);
    expect(recoverUnreachableIncident(opened, { generation: 7, incidentId: 'incident-7-a' })).toMatchObject({
      lifecycleState: 'running',
      unreachableIncidentId: null,
      unreachableDeadlineMs: null,
      responseRevision: 14,
    });
  });

  it('deadline is eligibility: it claims stopping once but does not itself report stopped', () => {
    const opened = openUnreachableIncident(running, {
      generation: 7,
      incidentId: 'incident-7-a',
      observedAtMs: 1_000_000,
    });
    expect(claimExpiredTermination(opened, { nowMs: 1_119_999, intentId: 'term-a' })).toEqual(opened);
    const claimed = claimExpiredTermination(opened, { nowMs: 1_120_000, intentId: 'term-a' });
    expect(claimed).toMatchObject({
      lifecycleState: 'stopping',
      terminationIntentId: 'term-a',
      terminationGeneration: 7,
    });
    expect(claimExpiredTermination(claimed, { nowMs: 1_130_000, intentId: 'term-b' })).toEqual(claimed);
  });

  it('rechecks generation before every duplicate-safe signal attempt', () => {
    const opened = openUnreachableIncident(running, {
      generation: 7,
      incidentId: 'incident-7-a',
      observedAtMs: 1_000_000,
    });
    const claimed = claimExpiredTermination(opened, { nowMs: 1_120_000, intentId: 'term-a' });
    expect(canSignalTermination(claimed, { generation: 7, intentId: 'term-a' })).toBe(true);
    expect(canSignalTermination(claimed, { generation: 8, intentId: 'term-a' })).toBe(false);
    expect(canSignalTermination({ ...claimed, lifecycleGeneration: 8 }, { generation: 7, intentId: 'term-a' })).toBe(false);
  });

  it('signal acceptance is not exit; confirmed matching exit alone reports stopped', () => {
    const opened = openUnreachableIncident(running, {
      generation: 7,
      incidentId: 'incident-7-a',
      observedAtMs: 1_000_000,
    });
    const claimed = claimExpiredTermination(opened, { nowMs: 1_120_000, intentId: 'term-a' });
    expect(claimed.lifecycleState).toBe('stopping');
    expect(confirmProcessExit(claimed, { generation: 8, intentId: 'term-a' })).toEqual(claimed);
    expect(confirmProcessExit(claimed, { generation: 7, intentId: 'term-a' })).toMatchObject({
      lifecycleState: 'stopped',
      terminationIntentId: null,
      unreachableIncidentId: null,
    });
  });
});
