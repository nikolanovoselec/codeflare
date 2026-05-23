import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock KV and storage
const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
};

const mockStorage = {
  get: vi.fn(),
  put: vi.fn(),
  getAlarm: vi.fn(),
  setAlarm: vi.fn(),
};

// Mock logger
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  })),
}));

import { Timekeeper, resetUserRecordCache } from '../../timekeeper/index';
import { getUtcDateString, getUtcMonthString, getIsoWeekStart } from '../../lib/kv-keys';

// Dynamic dates so tests never go stale
const NOW = new Date();
const TODAY = getUtcDateString(NOW);
const THIS_MONTH = getUtcMonthString(NOW);
const THIS_YEAR = String(NOW.getUTCFullYear());
const THIS_WEEK_START = getIsoWeekStart(NOW);
const YESTERDAY = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() - 1)).toISOString();

function createTimekeeper(): Timekeeper {
  const ctx = { storage: mockStorage, waitUntil: vi.fn() } as any;
  const env = { KV: mockKV } as any;
  // Bypass blockConcurrencyWhile — mock returns immediately
  ctx.blockConcurrencyWhile = vi.fn(async (fn: () => Promise<void>) => fn());
  return new Timekeeper(ctx, env);
}

function pingRequest(body: Record<string, unknown>): Request {
  return new Request('http://timekeeper/ping', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUserRecordCache();
    mockStorage.get.mockResolvedValue(undefined);
    mockStorage.put.mockResolvedValue(undefined);
    mockStorage.getAlarm.mockResolvedValue(null);
    mockStorage.setAlarm.mockResolvedValue(undefined);
    mockKV.get.mockResolvedValue(null);
    mockKV.put.mockResolvedValue(undefined);
  });

  describe('POST /ping', () => {
    it('increments pendingSeconds by delta', async () => {
      // Mock a free-tier user so quota check doesn't trip on the default 'pending' tier
      mockKV.get.mockImplementation(async (key: string) => {
        if (key.startsWith('user:')) return JSON.stringify({ subscriptionTier: 'free' });
        return null;
      });
      const tk = createTimekeeper();
      const res = await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { quotaExceeded: boolean; totalMonthlySeconds: number };
      expect(body.quotaExceeded).toBe(false);
      expect(body.totalMonthlySeconds).toBe(60);
    });

    it('stores bucketName on first ping', async () => {
      const tk = createTimekeeper();
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));
      expect(mockStorage.put).toHaveBeenCalledWith('bucketName', 'cf-alice');
    });

    it('computes correct delta for continued session', async () => {
      const tk = createTimekeeper();
      // First ping: 60s
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));
      // Second ping: 120s (delta = 60)
      const res = await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 120,
        email: 'alice@example.com',
      }));
      const body = await res.json() as { totalMonthlySeconds: number };
      expect(body.totalMonthlySeconds).toBe(120);
    });

    it('handles session restart (totalSeconds < previous)', async () => {
      const tk = createTimekeeper();
      // First ping: 120s
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 120,
        email: 'alice@example.com',
      }));
      // Session restart: totalSeconds resets to 60
      const res = await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));
      const body = await res.json() as { totalMonthlySeconds: number };
      // 120 (from first) + 60 (fresh count from restart) = 180
      expect(body.totalMonthlySeconds).toBe(180);
    });

    it('arms alarm if none pending', async () => {
      mockStorage.getAlarm.mockResolvedValue(null);
      const tk = createTimekeeper();
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));
      expect(mockStorage.setAlarm).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-arm alarm if one is already pending', async () => {
      mockStorage.getAlarm.mockResolvedValue(Date.now() + 300_000);
      const tk = createTimekeeper();
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));
      expect(mockStorage.setAlarm).not.toHaveBeenCalled();
    });

    it('returns quotaExceeded=false for unlimited tier', async () => {
      // User with unlimited tier (monthlySeconds: null)
      mockKV.get.mockImplementation(async (key: string) => {
        if (key === 'tiers:config') return null; // use defaults
        if (key.startsWith('user:')) return JSON.stringify({ subscriptionTier: 'unlimited', role: 'user' });
        return null;
      });
      const tk = createTimekeeper();
      const res = await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 999999,
        email: 'alice@example.com',
      }));
      const body = await res.json() as { quotaExceeded: boolean };
      expect(body.quotaExceeded).toBe(false);
    });

    it('returns quotaExceeded=true when at quota', async () => {
      // Free tier: 14400s. Mock must handle both get(key) and get(key, 'json') calls.
      const usageRecord = {
        today: { date: TODAY, seconds: 0 },
        thisWeek: { weekStart: THIS_WEEK_START, seconds: 0 },
        thisMonth: { month: THIS_MONTH, seconds: 14300 },
        thisYear: { year: THIS_YEAR, seconds: 14300 },
        allTime: { seconds: 14300 },
        lastUpdatedAt: YESTERDAY,
      };
      mockKV.get.mockImplementation(async (key: string, type?: string) => {
        if (key === 'tiers:config') return null;
        if (key.startsWith('user:')) return JSON.stringify({ subscriptionTier: 'free', role: 'user' });
        if (key.startsWith('timekeeper:')) return type === 'json' ? usageRecord : JSON.stringify(usageRecord);
        return null;
      });
      const tk = createTimekeeper();
      const res = await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 200,
        email: 'alice@example.com',
      }));
      const body = await res.json() as { quotaExceeded: boolean };
      expect(body.quotaExceeded).toBe(true);
    });

    it('fails open when KV read fails', async () => {
      mockKV.get.mockRejectedValue(new Error('KV down'));
      const tk = createTimekeeper();
      const res = await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));
      const body = await res.json() as { quotaExceeded: boolean };
      expect(body.quotaExceeded).toBe(false);
    });

    it('validates request body', async () => {
      const tk = createTimekeeper();
      const res = await tk.fetch(new Request('http://timekeeper/ping', {
        method: 'POST',
        body: JSON.stringify({ invalid: true }),
        headers: { 'Content-Type': 'application/json' },
      }));
      expect(res.status).toBe(400);
    });

    it('persists pendingSeconds to DO storage', async () => {
      const tk = createTimekeeper();
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));
      expect(mockStorage.put).toHaveBeenCalledWith('pendingSeconds', 60);
    });
  });

  describe('GET /usage', () => {
    it('returns real-time usage (lastFlushed + pending)', async () => {
      mockKV.get.mockImplementation(async (key: string, type?: string) => {
        if (key.startsWith('timekeeper:') && type === 'json') {
          return {
            today: { date: TODAY, seconds: 100 },
            thisWeek: { weekStart: THIS_WEEK_START, seconds: 500 },
            thisMonth: { month: THIS_MONTH, seconds: 1000 },
            thisYear: { year: THIS_YEAR, seconds: 5000 },
            allTime: { seconds: 10000 },
            lastUpdatedAt: YESTERDAY,
          };
        }
        return null;
      });

      const tk = createTimekeeper();
      // Ping to set bucketName and pending
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));

      const res = await tk.fetch(new Request('http://timekeeper/usage'));
      expect(res.status).toBe(200);
      const body = await res.json() as { monthlySeconds: number; dailySeconds: number };
      // KV month = 1000 + pending 60 = 1060
      expect(body.monthlySeconds).toBe(1060);
      expect(body.dailySeconds).toBe(160);
    });

    it('handles no KV record (first request)', async () => {
      const tk = createTimekeeper();
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 30,
        email: 'alice@example.com',
      }));

      const res = await tk.fetch(new Request('http://timekeeper/usage'));
      const body = await res.json() as { monthlySeconds: number };
      expect(body.monthlySeconds).toBe(30);
    });
  });

  describe('alarm (flush)', () => {
    it('reads KV, adds pendingSeconds, writes back', async () => {
      const tk = createTimekeeper();
      // Ping to accumulate pending
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 120,
        email: 'alice@example.com',
      }));

      // Mock KV for alarm flush
      mockKV.get.mockImplementation(async (key: string, type?: string) => {
        if (key === 'timekeeper:cf-alice' && type === 'json') {
          return {
            today: { date: TODAY, seconds: 100 },
            thisWeek: { weekStart: THIS_WEEK_START, seconds: 500 },
            thisMonth: { month: THIS_MONTH, seconds: 1000 },
            thisYear: { year: THIS_YEAR, seconds: 5000 },
            allTime: { seconds: 10000 },
            lastUpdatedAt: YESTERDAY,
          };
        }
        return null;
      });

      await tk.alarm();

      // Should have written updated record to KV
      expect(mockKV.put).toHaveBeenCalledWith(
        'timekeeper:cf-alice',
        expect.any(String)
      );
      const written = JSON.parse(mockKV.put.mock.calls[0][1]);
      expect(written.today.seconds).toBe(220); // 100 + 120
      expect(written.thisMonth.seconds).toBe(1120); // 1000 + 120
      expect(written.allTime.seconds).toBe(10120); // 10000 + 120
    });

    it('handles null KV record (first flush)', async () => {
      const tk = createTimekeeper();
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));

      mockKV.get.mockResolvedValue(null);
      await tk.alarm();

      expect(mockKV.put).toHaveBeenCalled();
      const written = JSON.parse(mockKV.put.mock.calls[0][1]);
      expect(written.today.seconds).toBe(60);
      expect(written.allTime.seconds).toBe(60);
    });

    it('resets pendingSeconds after successful flush', async () => {
      const tk = createTimekeeper();
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));

      await tk.alarm();

      // pendingSeconds should be reset to 0
      expect(mockStorage.put).toHaveBeenCalledWith('pendingSeconds', 0);
    });

    it('does NOT re-arm if pendingSeconds = 0 after flush', async () => {
      const tk = createTimekeeper();
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice',
        sessionId: 'sess1',
        totalSeconds: 60,
        email: 'alice@example.com',
      }));

      mockStorage.setAlarm.mockClear();
      await tk.alarm();

      // Should not re-arm (no pending after flush)
      expect(mockStorage.setAlarm).not.toHaveBeenCalled();
    });
  });

  describe('crash resilience', () => {
    it('constructor restores pendingSeconds from DO storage', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'pendingSeconds') return 300;
        if (key === 'bucketName') return 'cf-alice';
        if (key === 'email') return 'alice@example.com';
        if (key === 'sessionTotals') return JSON.stringify({ sess1: 200 });
        if (key === 'lastFlushedMonthlyTotal') return 0;
        return undefined;
      });

      const tk = createTimekeeper();
      // Allow blockConcurrencyWhile async to complete (constructor fire-and-forget)
      await new Promise((r) => setTimeout(r, 0));
      // Fetch usage to verify pending was restored
      const res = await tk.fetch(new Request('http://timekeeper/usage'));
      const body = await res.json() as { monthlySeconds: number };
      expect(body.monthlySeconds).toBe(300);
    });
  });

  describe('404 for unknown routes', () => {
    it('returns 404 for GET /unknown', async () => {
      const tk = createTimekeeper();
      const res = await tk.fetch(new Request('http://timekeeper/unknown'));
      expect(res.status).toBe(404);
    });

    it('returns 404 for POST /unknown', async () => {
      const tk = createTimekeeper();
      const res = await tk.fetch(new Request('http://timekeeper/unknown', { method: 'POST' }));
      expect(res.status).toBe(404);
    });
  });

  describe('delta clamping (CF-020)', () => {
    it('clamps delta to 300 seconds per ping', async () => {
      const tk = createTimekeeper();
      // First ping establishes baseline
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice', sessionId: 'sess1', totalSeconds: 100, email: 'alice@example.com',
      }));
      // Second ping with huge jump — delta should be capped at 300
      const res = await tk.fetch(pingRequest({
        bucketName: 'cf-alice', sessionId: 'sess1', totalSeconds: 10000, email: 'alice@example.com',
      }));
      const body = await res.json() as { totalMonthlySeconds: number };
      // 100 (first) + 300 (clamped) = 400
      expect(body.totalMonthlySeconds).toBe(400);
    });

    it('clamps delta on session restart to 300', async () => {
      const tk = createTimekeeper();
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice', sessionId: 'sess1', totalSeconds: 500, email: 'alice@example.com',
      }));
      // Restart: totalSeconds < previous, but also huge
      const res = await tk.fetch(pingRequest({
        bucketName: 'cf-alice', sessionId: 'sess1', totalSeconds: 400, email: 'alice@example.com',
      }));
      const body = await res.json() as { totalMonthlySeconds: number };
      // 300 (clamped first) + 300 (clamped restart) = 600
      expect(body.totalMonthlySeconds).toBe(600);
    });
  });

  describe('alarm retry on KV failure (CF-020)', () => {
    it('re-arms alarm on KV write failure and preserves pendingSeconds', async () => {
      const tk = createTimekeeper();
      await tk.fetch(pingRequest({
        bucketName: 'cf-alice', sessionId: 'sess1', totalSeconds: 60, email: 'alice@example.com',
      }));

      // Mock KV put to throw on alarm flush
      mockKV.put.mockRejectedValueOnce(new Error('KV write failed'));
      mockStorage.setAlarm.mockClear();

      await tk.alarm();

      // Should re-arm alarm for retry (30s)
      expect(mockStorage.setAlarm).toHaveBeenCalledWith(expect.any(Number));
      // pendingSeconds should NOT be reset to 0 (preserved for retry)
      const lastPendingWrite = mockStorage.put.mock.calls
        .filter((c: unknown[]) => c[0] === 'pendingSeconds')
        .pop();
      expect(lastPendingWrite?.[1]).toBe(60); // still 60, not 0
    });
  });

  describe('trial quota enforcement (CF-020)', () => {
    it('returns quotaExceeded=true when trialing user exceeds trialQuotaHours', async () => {
      // Standard tier: trialQuotaHours=40 => 144000s
      mockKV.get.mockImplementation(async (key: string, type?: string) => {
        if (key === 'tiers:config') return null; // use defaults
        if (key.startsWith('user:')) return JSON.stringify({
          subscriptionTier: 'standard', billingStatus: 'trialing',
          stripeSubscriptionId: 'sub_123',
        });
        if (key.startsWith('timekeeper:')) {
          const record = {
            today: { date: TODAY, seconds: 0 },
            thisWeek: { weekStart: THIS_WEEK_START, seconds: 0 },
            thisMonth: { month: THIS_MONTH, seconds: 143900 },
            thisYear: { year: THIS_YEAR, seconds: 143900 },
            allTime: { seconds: 143900 },
            lastUpdatedAt: new Date().toISOString(),
          };
          return type === 'json' ? record : JSON.stringify(record);
        }
        return null;
      });
      const tk = createTimekeeper();
      const res = await tk.fetch(pingRequest({
        bucketName: 'cf-alice', sessionId: 'sess1', totalSeconds: 200, email: 'alice@example.com',
      }));
      const body = await res.json() as { quotaExceeded: boolean };
      expect(body.quotaExceeded).toBe(true);
    });
  });

  describe('User record cache', () => {
    it('caches user record across consecutive pings', async () => {
      const userRecord = JSON.stringify({ subscriptionTier: 'standard', billingStatus: 'active' });
      mockKV.get.mockImplementation(async (key: string) => {
        if (key.startsWith('user:')) return userRecord;
        return null;
      });

      const tk = createTimekeeper();
      // First ping — reads user record from KV
      await tk.fetch(pingRequest({ bucketName: 'cf-alice', sessionId: 's1', totalSeconds: 60, email: 'alice@example.com' }));
      const userReadsAfterFirst = mockKV.get.mock.calls.filter((c: string[]) => c[0].startsWith('user:')).length;
      expect(userReadsAfterFirst).toBe(1);

      // Second ping — should use cache, not KV
      mockKV.get.mockClear();
      mockKV.get.mockResolvedValue(null);
      await tk.fetch(pingRequest({ bucketName: 'cf-alice', sessionId: 's1', totalSeconds: 120, email: 'alice@example.com' }));
      const userReadsAfterSecond = mockKV.get.mock.calls.filter((c: string[]) => c[0].startsWith('user:')).length;
      expect(userReadsAfterSecond).toBe(0);
    });

    it('re-reads after cache expiry', async () => {
      vi.useFakeTimers();
      const userRecord = JSON.stringify({ subscriptionTier: 'free', billingStatus: 'active' });
      mockKV.get.mockImplementation(async (key: string) => {
        if (key.startsWith('user:')) return userRecord;
        return null;
      });

      const tk = createTimekeeper();
      await tk.fetch(pingRequest({ bucketName: 'cf-bob', sessionId: 's1', totalSeconds: 60, email: 'bob@example.com' }));

      // Advance past 60s TTL
      vi.advanceTimersByTime(61_000);
      mockKV.get.mockClear();
      mockKV.get.mockImplementation(async (key: string) => {
        if (key.startsWith('user:')) return userRecord;
        return null;
      });

      await tk.fetch(pingRequest({ bucketName: 'cf-bob', sessionId: 's1', totalSeconds: 120, email: 'bob@example.com' }));
      const userReads = mockKV.get.mock.calls.filter((c: string[]) => c[0].startsWith('user:')).length;
      expect(userReads).toBe(1);

      vi.useRealTimers();
    });

    it('resetUserRecordCache clears the cache', async () => {
      const userRecord = JSON.stringify({ subscriptionTier: 'standard' });
      mockKV.get.mockImplementation(async (key: string) => {
        if (key.startsWith('user:')) return userRecord;
        return null;
      });

      const tk = createTimekeeper();
      await tk.fetch(pingRequest({ bucketName: 'cf-claire', sessionId: 's1', totalSeconds: 60, email: 'claire@example.com' }));

      // Reset cache
      resetUserRecordCache();
      mockKV.get.mockClear();
      mockKV.get.mockImplementation(async (key: string) => {
        if (key.startsWith('user:')) return userRecord;
        return null;
      });

      await tk.fetch(pingRequest({ bucketName: 'cf-claire', sessionId: 's1', totalSeconds: 120, email: 'claire@example.com' }));
      const userReads = mockKV.get.mock.calls.filter((c: string[]) => c[0].startsWith('user:')).length;
      expect(userReads).toBe(1);
    });
  });
});
