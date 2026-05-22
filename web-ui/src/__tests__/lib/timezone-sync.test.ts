// REQ-SESSION-016 AC5: the frontend captures the browser's IANA timezone
// via Intl.DateTimeFormat().resolvedOptions().timeZone on Dashboard
// mount and persists it via updatePreferences. Future sessions started
// from that browser propagate the same zone into the container so the
// capture pipeline's `TZ="$RESOLVED" date '+%...'` step produces a
// wall-clock filename.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncBrowserTimezone, getBrowserTimezone } from '../../lib/timezone-sync';

describe('getBrowserTimezone (REQ-SESSION-016 AC5)', () => {
  it('returns a non-empty IANA string in a real browser environment', () => {
    // In the vitest jsdom/happy-dom environment, Intl.DateTimeFormat
    // resolves to the host's timezone (typically UTC in CI, local in dev).
    const tz = getBrowserTimezone();
    expect(typeof tz).toBe('string');
    // Must match canonical IANA form (Region/City) or the literal UTC.
    // Tightened from "any non-empty string" per code-reviewer M-tdd-1.
    expect(tz ?? '').toMatch(/^([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_]+)?|UTC|GMT)$/);
  });

  it('returns null if Intl.DateTimeFormat throws (defensive)', () => {
    const original = globalThis.Intl;
    (globalThis as unknown as { Intl: { DateTimeFormat: () => never } }).Intl = {
      DateTimeFormat: () => {
        throw new Error('boom');
      },
    };
    try {
      expect(getBrowserTimezone()).toBeNull();
    } finally {
      globalThis.Intl = original;
    }
  });
});

describe('syncBrowserTimezone (REQ-SESSION-016 AC5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls updatePreferences with the resolved timezone when it differs from current', async () => {
    const updatePrefs = vi.fn(async (_prefs: { userTimezone?: string }) => undefined);
    await syncBrowserTimezone({
      currentTimezone: undefined,
      browserTimezone: 'Europe/Zurich',
      updatePreferences: updatePrefs,
    });
    expect(updatePrefs).toHaveBeenCalledWith({ userTimezone: 'Europe/Zurich' });
  });

  it('is a no-op when current and browser timezone match', async () => {
    const updatePrefs = vi.fn(async () => undefined);
    await syncBrowserTimezone({
      currentTimezone: 'Europe/Zurich',
      browserTimezone: 'Europe/Zurich',
      updatePreferences: updatePrefs,
    });
    expect(updatePrefs).not.toHaveBeenCalled();
  });

  it('is a no-op when browser timezone is null (cannot detect)', async () => {
    const updatePrefs = vi.fn(async () => undefined);
    await syncBrowserTimezone({
      currentTimezone: 'Europe/Zurich',
      browserTimezone: null,
      updatePreferences: updatePrefs,
    });
    expect(updatePrefs).not.toHaveBeenCalled();
  });

  it('swallows updatePreferences rejections (does not block dashboard mount)', async () => {
    const updatePrefs = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(syncBrowserTimezone({
      currentTimezone: undefined,
      browserTimezone: 'Europe/Zurich',
      updatePreferences: updatePrefs,
    })).resolves.toBeUndefined();
  });
});
