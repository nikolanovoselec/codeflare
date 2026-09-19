import { describe, expect, it, vi } from 'vitest';
import { createLifecycleTransitionLogger } from '../../lib/session-lifecycle-observability';

describe('REQ-SESSION-025: bounded recovery observability', () => {
  it('correlates each material transition with generation and incident identity', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const events = createLifecycleTransitionLogger(logger);
    const context = { sessionId: 'session01', generation: 8, incidentId: 'incident-8-a' };

    events.incidentOpened(context, { reason: 'host_transport_loss', deadlineMs: 120_000 });
    events.reconstructionStarted(context);
    events.recoverySucceeded(context);
    events.terminationClaimed(context, { reason: 'recovery_expiry' });
    events.signalAccepted(context);
    events.finalSyncCompleted(context, { outcome: 'failed' });
    events.exitConfirmed(context, { reason: 'platform_unknown' });

    const calls = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls];
    expect(calls).toHaveLength(7);
    for (const [, fields] of calls) {
      expect(fields).toMatchObject({ sessionId: 'session01', lifecycleGeneration: 8, incidentId: 'incident-8-a' });
    }
  });

  it('keeps evidence-based reasons distinct and preserves unknown attribution', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const events = createLifecycleTransitionLogger(logger);
    const context = { sessionId: 'session01', generation: 8, incidentId: 'incident-8-a' };
    for (const reason of ['user_stop', 'idle_stop', 'quota_stop', 'recovery_expiry', 'd1_outage', 'host_transport_loss', 'platform_unknown'] as const) {
      events.terminationClaimed(context, { reason });
    }
    expect(logger.info.mock.calls.map(([, fields]) => fields.reason)).toEqual([
      'user_stop', 'idle_stop', 'quota_stop', 'recovery_expiry', 'd1_outage', 'host_transport_loss', 'platform_unknown',
    ]);
  });

  it('redacts secrets, transcript content, terminal content, and per-file paths', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const events = createLifecycleTransitionLogger(logger);
    events.signalFailed(
      { sessionId: 'session01', generation: 8, incidentId: 'incident-8-a' },
      new Error('Bearer secret-token failed for /home/user/workspace/private.txt'),
    );
    const serialized = JSON.stringify(logger.error.mock.calls);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('private.txt');
    expect(serialized).toContain('signal_failed');
  });

  it('does not expose APIs for normal ticks, individual socket retries, or unchanged state', () => {
    const events = createLifecycleTransitionLogger({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    expect(events).not.toHaveProperty('metricsTick');
    expect(events).not.toHaveProperty('webSocketRetry');
    expect(events).not.toHaveProperty('stateUnchanged');
  });
});
