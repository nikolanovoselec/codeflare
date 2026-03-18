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

import { Timekeeper } from '../../timekeeper/index';

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

describe('Timekeeper DO', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.get.mockResolvedValue(undefined);
    mockStorage.put.mockResolvedValue(undefined);
    mockStorage.getAlarm.mockResolvedValue(null);
    mockStorage.setAlarm.mockResolvedValue(undefined);
    mockKV.get.mockResolvedValue(null);
    mockKV.put.mockResolvedValue(undefined);
  });

  describe('POST /ping', () => {
    it('increments pendingSeconds by delta', async () => {
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
      // Free tier: 7200s
      mockKV.get.mockImplementation(async (key: string) => {
        if (key === 'tiers:config') return null;
        if (key.startsWith('user:')) return JSON.stringify({ subscriptionTier: 'free', role: 'user' });
        if (key.startsWith('timekeeper:')) return JSON.stringify({
          today: { date: '2026-03-18', seconds: 0 },
          thisWeek: { weekStart: '2026-03-16', seconds: 0 },
          thisMonth: { month: '2026-03', seconds: 7100 },
          thisYear: { year: '2026', seconds: 7100 },
          allTime: { seconds: 7100 },
          lastUpdatedAt: '2026-03-18T00:00:00Z',
        });
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
            today: { date: '2026-03-18', seconds: 100 },
            thisWeek: { weekStart: '2026-03-16', seconds: 500 },
            thisMonth: { month: '2026-03', seconds: 1000 },
            thisYear: { year: '2026', seconds: 5000 },
            allTime: { seconds: 10000 },
            lastUpdatedAt: '2026-03-18T00:00:00Z',
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
            today: { date: '2026-03-18', seconds: 100 },
            thisWeek: { weekStart: '2026-03-16', seconds: 500 },
            thisMonth: { month: '2026-03', seconds: 1000 },
            thisYear: { year: '2026', seconds: 5000 },
            allTime: { seconds: 10000 },
            lastUpdatedAt: '2026-03-18T00:00:00Z',
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
        return undefined;
      });

      const tk = createTimekeeper();
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
});
