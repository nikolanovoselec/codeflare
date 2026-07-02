import { describe, it, expect } from 'vitest';
import {
  resolveSpawnedAgentId,
  reviewCompletionDeliveryStalled,
  reviewDeliveryGiveUp,
  reviewMonitorCompletionRejectReason,
  reviewMonitorCompletionRecordReady,
} from '../../../preseed/agents/pi/extensions/review-job-helpers';

/**
 * Tier-1 review/CI monitor reliability fixes. These pin the contract values, not prose —
 * gut any of the three helpers and a case here fails.
 */

// REQ-AGENT-073: Pi Review Monitor Delivery Reliability
describe('resolveSpawnedAgentId (R1: untyped subagents-service spawn return)', () => {
  it('returns a non-empty string id verbatim', () => {
    expect(resolveSpawnedAgentId('agent-123')).toBe('agent-123');
  });

  it('reads the id from the object return shapes the service may use', () => {
    expect(resolveSpawnedAgentId({ agentId: 'a1' })).toBe('a1');
    expect(resolveSpawnedAgentId({ id: 'b2' })).toBe('b2');
    expect(resolveSpawnedAgentId({ agent_id: 'c3' })).toBe('c3');
  });

  it('treats empty / missing / non-string ids as no-spawn (undefined), so a real spawn never reads as failure and a non-spawn never reads as success', () => {
    expect(resolveSpawnedAgentId('')).toBeUndefined();
    expect(resolveSpawnedAgentId('   ')).toBeUndefined();
    expect(resolveSpawnedAgentId({})).toBeUndefined();
    expect(resolveSpawnedAgentId({ id: 42 })).toBeUndefined();
    expect(resolveSpawnedAgentId(null)).toBeUndefined();
    expect(resolveSpawnedAgentId(undefined)).toBeUndefined();
    expect(resolveSpawnedAgentId(42)).toBeUndefined();
  });
});

describe('reviewCompletionDeliveryStalled (R2: bounded give-up on an undelivered completion)', () => {
  it('is never stalled while a valid completion is ready', () => {
    expect(reviewCompletionDeliveryStalled({ completionReady: true, deliveryAgeMs: 10 ** 9, maxAgeMs: 1000 })).toBe(false);
  });

  it('gives up once the age bound is reached with no completion', () => {
    expect(reviewCompletionDeliveryStalled({ completionReady: false, deliveryAgeMs: 1000, maxAgeMs: 1000 })).toBe(true);
    expect(reviewCompletionDeliveryStalled({ completionReady: false, deliveryAgeMs: 5000, maxAgeMs: 1000 })).toBe(true);
  });

  it('keeps waiting before the age bound (no premature give-up)', () => {
    expect(reviewCompletionDeliveryStalled({ completionReady: false, deliveryAgeMs: 999, maxAgeMs: 1000 })).toBe(false);
  });
});

describe('reviewDeliveryGiveUp (give-up clock anchored to monitor spawn, not review-window start)', () => {
  const now = 10_000_000;
  const m = 60_000;
  const laneBudgetMs = 20 * m;
  const monitorTtlMs = 35 * m;

  it('never gives up while a valid completion is ready, regardless of age', () => {
    expect(reviewDeliveryGiveUp({ completionReady: true, now, reviewStartedAt: now - 99 * m, monitorStartedAt: now - 99 * m, laneBudgetMs, monitorTtlMs })).toBe(false);
  });

  describe('with a live monitor claim — anchor is the monitor spawn time, bound is its polling TTL', () => {
    it('keeps waiting while the monitor is within its polling TTL', () => {
      expect(reviewDeliveryGiveUp({ completionReady: false, now, reviewStartedAt: now - 99 * m, monitorStartedAt: now - 34 * m, laneBudgetMs, monitorTtlMs })).toBe(false);
    });

    it('gives up once the monitor has exhausted its polling TTL', () => {
      expect(reviewDeliveryGiveUp({ completionReady: false, now, reviewStartedAt: now - 99 * m, monitorStartedAt: now - 35 * m, laneBudgetMs, monitorTtlMs })).toBe(true);
      expect(reviewDeliveryGiveUp({ completionReady: false, now, reviewStartedAt: now - 99 * m, monitorStartedAt: now - 40 * m, laneBudgetMs, monitorTtlMs })).toBe(true);
    });

    it('does not kill a healthy monitor spawned late in a long lane run (the window-start regression)', () => {
      // Lanes ran ~19m, monitor spawned 1m ago. The old code measured now-reviewStartedAt (20m) >= 20m
      // and wrongly gave up on a monitor that has 34m of budget left.
      expect(reviewDeliveryGiveUp({ completionReady: false, now, reviewStartedAt: now - 20 * m, monitorStartedAt: now - 1 * m, laneBudgetMs, monitorTtlMs })).toBe(false);
    });
  });

  describe('before any monitor claim exists — anchor is the window start discounted by the lane budget', () => {
    it('does not give up on the first finalize tick right after lanes complete', () => {
      expect(reviewDeliveryGiveUp({ completionReady: false, now, reviewStartedAt: now - 5 * m, monitorStartedAt: undefined, laneBudgetMs, monitorTtlMs })).toBe(false);
    });

    it('keeps waiting until the lane budget plus the monitor TTL elapse', () => {
      expect(reviewDeliveryGiveUp({ completionReady: false, now, reviewStartedAt: now - 54 * m, monitorStartedAt: undefined, laneBudgetMs, monitorTtlMs })).toBe(false);
    });

    it('gives up once a monitor that never claimed exceeds lane budget + TTL, so merge is never blocked forever', () => {
      expect(reviewDeliveryGiveUp({ completionReady: false, now, reviewStartedAt: now - 55 * m, monitorStartedAt: undefined, laneBudgetMs, monitorTtlMs })).toBe(true);
      expect(reviewDeliveryGiveUp({ completionReady: false, now, reviewStartedAt: now - 60 * m, monitorStartedAt: undefined, laneBudgetMs, monitorTtlMs })).toBe(true);
    });
  });
});

describe('reviewMonitorCompletionRejectReason (R3: diagnostic completion validation)', () => {
  const valid = {
    record: { repo: '/repo', head: 'abc', summaryPath: '/repo/s.md', completedAt: 2000, result: 'findings' },
    repo: '/repo',
    head: 'abc',
    summaryPath: '/repo/s.md',
    latestInputMtime: 1500,
  };

  it('accepts a valid record (no reason) and stays consistent with the boolean wrapper', () => {
    expect(reviewMonitorCompletionRejectReason(valid)).toBeUndefined();
    expect(reviewMonitorCompletionRecordReady(valid)).toBe(true);
  });

  it('names the specific field that failed instead of failing opaquely', () => {
    expect(reviewMonitorCompletionRejectReason({ ...valid, repo: '/other' })).toBe('repo_mismatch');
    expect(reviewMonitorCompletionRejectReason({ ...valid, head: 'def' })).toBe('head_mismatch');
    expect(reviewMonitorCompletionRejectReason({ ...valid, summaryPath: '/other/s.md' })).toBe('summary_path_mismatch');
    expect(reviewMonitorCompletionRejectReason({ ...valid, record: { ...valid.record, result: 'CLEAN' } })).toBe('invalid_result');
    expect(reviewMonitorCompletionRejectReason({ ...valid, record: { ...valid.record, completedAt: undefined } })).toBe('missing_completed_at');
  });

  it('rejects a stale completion written more than 1s before the latest input mtime', () => {
    const stale = { ...valid, record: { ...valid.record, completedAt: 1000 }, latestInputMtime: 5000 };
    expect(reviewMonitorCompletionRejectReason(stale)).toBe('stale_completed_at');
    expect(reviewMonitorCompletionRecordReady(stale)).toBe(false);
  });
});
