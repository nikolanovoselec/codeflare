import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Implements REQ-SUB-018

describe('session-usage dismissed quota level', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('returns null when no dismissal is stored', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    const mod = await import('../../stores/session-usage');
    expect(mod.getDismissedQuotaLevel()).toBe(null);
  });

  it('persists 80 dismissal to localStorage under month-scoped key and reads it back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    const mod = await import('../../stores/session-usage');

    mod.setDismissedQuotaLevel('80');

    expect(localStorage.getItem('cf_dismissed_quota_2026-04')).toBe('80');
    expect(mod.getDismissedQuotaLevel()).toBe('80');
  });

  it('persists 95 dismissal independently of 80', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    const mod = await import('../../stores/session-usage');

    mod.setDismissedQuotaLevel('95');

    expect(localStorage.getItem('cf_dismissed_quota_2026-04')).toBe('95');
    expect(mod.getDismissedQuotaLevel()).toBe('95');
  });

  it('ignores dismissal from a previous UTC month', async () => {
    // Seed April dismissal before module load
    localStorage.setItem('cf_dismissed_quota_2026-04', '80');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T00:00:00Z')); // now it's May
    const mod = await import('../../stores/session-usage');

    expect(mod.getDismissedQuotaLevel()).toBe(null);
  });

  it('does not throw when localStorage is unavailable', async () => {
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    Storage.prototype.setItem = () => { throw new Error('blocked'); };

    const mod = await import('../../stores/session-usage');
    expect(() => mod.getDismissedQuotaLevel()).not.toThrow();
    expect(() => mod.setDismissedQuotaLevel('80')).not.toThrow();

    Storage.prototype.getItem = originalGet;
    Storage.prototype.setItem = originalSet;
  });
});
