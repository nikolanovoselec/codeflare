import { describe, it, expect } from 'vitest';
import { evaluateActivity, type ActivityState } from '../../lib/activity-policy';

// Constants mirrored from activity-policy.ts (module-private, not exported)
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const INPUT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const GRACE_PERIOD_MS = 5 * 60 * 1000;

const NOW = 1_000_000_000;
const CONTAINER_START = NOW - 10 * 60 * 1000; // started 10 min ago (outside grace)
const CONTAINER_START_RECENT = NOW - 2 * 60 * 1000; // started 2 min ago (inside grace)

function makeActivity(overrides: Partial<ActivityState> = {}): ActivityState {
  return {
    hasActiveConnections: true,
    connectedClients: 1,
    lastHeartbeatAt: NOW - 60_000, // 1 min ago (recent)
    lastInputAt: NOW - 60_000,     // 1 min ago (recent)
    ...overrides,
  };
}

describe('evaluateActivity', () => {
  // ── Path 1: no active connections ─────────────────────────────────

  describe('no-active-connections', () => {
    it('does not renew when no WebSocket clients are connected', () => {
      const result = evaluateActivity(
        makeActivity({ hasActiveConnections: false, connectedClients: 0 }),
        CONTAINER_START,
        NOW,
      );
      expect(result.renew).toBe(false);
      expect(result.reason).toBe('no-active-connections');
    });
  });

  // ── Path 2+3: new host with heartbeat ─────────────────────────────

  describe('new host with heartbeat (lastHeartbeatAt is number)', () => {
    it('renews when both heartbeat and input are recent', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: NOW - 60_000,  // 1 min ago
          lastInputAt: NOW - 5 * 60_000,  // 5 min ago
        }),
        CONTAINER_START,
        NOW,
      );
      expect(result.renew).toBe(true);
      expect(result.reason).toBe('heartbeat-and-input-recent');
      expect(result.heartbeatAgeMs).toBe(60_000);
      expect(result.inputRecent).toBe(true);
    });

    it('does not renew when heartbeat is stale (tab hidden)', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: NOW - HEARTBEAT_STALE_MS - 1, // just over 5 min
          lastInputAt: NOW - 60_000, // input recent
        }),
        CONTAINER_START,
        NOW,
      );
      expect(result.renew).toBe(false);
      expect(result.reason).toBe('heartbeat-or-input-stale');
    });

    it('does not renew when input is stale (user AFK)', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: NOW - 60_000, // heartbeat recent
          lastInputAt: NOW - INPUT_IDLE_TIMEOUT_MS - 1, // just over 30 min
        }),
        CONTAINER_START,
        NOW,
      );
      expect(result.renew).toBe(false);
      expect(result.reason).toBe('heartbeat-or-input-stale');
    });

    it('does not renew when both are stale', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: NOW - HEARTBEAT_STALE_MS - 1,
          lastInputAt: NOW - INPUT_IDLE_TIMEOUT_MS - 1,
        }),
        CONTAINER_START,
        NOW,
      );
      expect(result.renew).toBe(false);
      expect(result.reason).toBe('heartbeat-or-input-stale');
    });

    it('renews at exact boundary (heartbeat exactly at TTL)', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: NOW - HEARTBEAT_STALE_MS, // exactly 5 min
          lastInputAt: NOW - 60_000,
        }),
        CONTAINER_START,
        NOW,
      );
      expect(result.renew).toBe(true);
      expect(result.reason).toBe('heartbeat-and-input-recent');
    });

    it('renews at exact boundary (input exactly at TTL)', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: NOW - 60_000,
          lastInputAt: NOW - INPUT_IDLE_TIMEOUT_MS, // exactly 30 min
        }),
        CONTAINER_START,
        NOW,
      );
      expect(result.renew).toBe(true);
      expect(result.reason).toBe('heartbeat-and-input-recent');
    });
  });

  // ── Path 4: new host, no heartbeat ever ───────────────────────────

  describe('new host, no heartbeat received (lastHeartbeatAt === null)', () => {
    it('does not renew even with active connections and recent input', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: null,
          lastInputAt: NOW - 60_000,
        }),
        CONTAINER_START,
        NOW,
      );
      expect(result.renew).toBe(false);
      expect(result.reason).toBe('no-heartbeat-received');
    });
  });

  // ── Path 5+6: legacy host (undefined heartbeat) ──────────────────

  describe('legacy host (lastHeartbeatAt === undefined)', () => {
    it('renews when input is recent', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: undefined,
          lastInputAt: NOW - 5 * 60_000,
        }),
        CONTAINER_START,
        NOW,
      );
      expect(result.renew).toBe(true);
      expect(result.reason).toBe('legacy-input-recent');
      expect(result.heartbeatAgeMs).toBeNull();
    });

    it('does not renew when input is stale', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: undefined,
          lastInputAt: NOW - INPUT_IDLE_TIMEOUT_MS - 1,
        }),
        CONTAINER_START,
        NOW,
      );
      expect(result.renew).toBe(false);
      expect(result.reason).toBe('legacy-input-stale');
    });
  });

  // ── Grace period behavior ─────────────────────────────────────────

  describe('grace period', () => {
    it('renews with null input during grace period (user hasnt typed yet)', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: NOW - 60_000,
          lastInputAt: null,
        }),
        CONTAINER_START_RECENT, // 2 min ago, inside 5 min grace
        NOW,
      );
      expect(result.renew).toBe(true);
      expect(result.reason).toBe('heartbeat-and-input-recent');
      expect(result.inGracePeriod).toBe(true);
      expect(result.inputRecent).toBe(true);
    });

    it('does not renew with null input after grace period expires', () => {
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: NOW - 60_000,
          lastInputAt: null,
        }),
        CONTAINER_START, // 10 min ago, outside grace
        NOW,
      );
      expect(result.renew).toBe(false);
      expect(result.reason).toBe('heartbeat-or-input-stale');
      expect(result.inGracePeriod).toBe(false);
      expect(result.inputRecent).toBe(false);
    });

    it('grace period boundary: exactly at GRACE_PERIOD_MS is still in grace', () => {
      const startedExactlyAtGrace = NOW - GRACE_PERIOD_MS;
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: NOW - 60_000,
          lastInputAt: null,
        }),
        startedExactlyAtGrace,
        NOW,
      );
      expect(result.inGracePeriod).toBe(true);
      expect(result.renew).toBe(true);
    });

    it('grace period boundary: 1ms past is outside grace', () => {
      const startedJustPastGrace = NOW - GRACE_PERIOD_MS - 1;
      const result = evaluateActivity(
        makeActivity({
          lastHeartbeatAt: NOW - 60_000,
          lastInputAt: null,
        }),
        startedJustPastGrace,
        NOW,
      );
      expect(result.inGracePeriod).toBe(false);
      expect(result.renew).toBe(false);
    });
  });

  // ── Diagnostic fields ─────────────────────────────────────────────

  describe('diagnostic fields', () => {
    it('reports correct inputIdleMs', () => {
      const result = evaluateActivity(
        makeActivity({ lastInputAt: NOW - 12345 }),
        CONTAINER_START,
        NOW,
      );
      expect(result.inputIdleMs).toBe(12345);
    });

    it('reports null inputIdleMs when no input', () => {
      const result = evaluateActivity(
        makeActivity({ lastInputAt: null }),
        CONTAINER_START_RECENT,
        NOW,
      );
      expect(result.inputIdleMs).toBeNull();
    });

    it('reports correct heartbeatAgeMs', () => {
      const result = evaluateActivity(
        makeActivity({ lastHeartbeatAt: NOW - 99999 }),
        CONTAINER_START,
        NOW,
      );
      expect(result.heartbeatAgeMs).toBe(99999);
    });
  });
});
