/**
 * Tests for formatRelativeTime and formatSize (CF-023)
 *
 * Covers boundary values for all time bands and size bands.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime, formatSize } from '../../lib/format';

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function dateSecondsAgo(seconds: number): Date {
    return new Date(Date.now() - seconds * 1000);
  }

  it('returns "--" for undefined input', () => {
    expect(formatRelativeTime(undefined)).toBe('--');
  });

  // --- "just now" band: < 10 seconds ---

  it('returns "just now" for 0 seconds ago', () => {
    expect(formatRelativeTime(new Date())).toBe('just now');
  });

  it('returns "just now" for 9 seconds ago', () => {
    expect(formatRelativeTime(dateSecondsAgo(9))).toBe('just now');
  });

  // --- seconds band: 10s-59s ---

  it('returns "10s ago" at the 10-second boundary', () => {
    expect(formatRelativeTime(dateSecondsAgo(10))).toBe('10s ago');
  });

  it('returns "59s ago" at the 59-second boundary', () => {
    expect(formatRelativeTime(dateSecondsAgo(59))).toBe('59s ago');
  });

  // --- minutes band: 1m-59m ---

  it('returns "1m ago" at 60 seconds', () => {
    expect(formatRelativeTime(dateSecondsAgo(60))).toBe('1m ago');
  });

  it('returns "59m ago" at 59 minutes', () => {
    expect(formatRelativeTime(dateSecondsAgo(59 * 60))).toBe('59m ago');
  });

  // --- hours band: 1h-23h ---

  it('returns "1h ago" at 60 minutes', () => {
    expect(formatRelativeTime(dateSecondsAgo(60 * 60))).toBe('1h ago');
  });

  it('returns "23h ago" at 23 hours', () => {
    expect(formatRelativeTime(dateSecondsAgo(23 * 60 * 60))).toBe('23h ago');
  });

  // --- days band: 1d-6d ---

  it('returns "1d ago" at 24 hours', () => {
    expect(formatRelativeTime(dateSecondsAgo(24 * 60 * 60))).toBe('1d ago');
  });

  it('returns "6d ago" at 6 days', () => {
    expect(formatRelativeTime(dateSecondsAgo(6 * 24 * 60 * 60))).toBe('6d ago');
  });

  // --- weeks band: 1w-4w ---

  it('returns "1w ago" at 7 days', () => {
    expect(formatRelativeTime(dateSecondsAgo(7 * 24 * 60 * 60))).toBe('1w ago');
  });

  it('returns "4w ago" at 29 days', () => {
    expect(formatRelativeTime(dateSecondsAgo(29 * 24 * 60 * 60))).toBe('4w ago');
  });

  // --- month format: >= 30 days, same year ---

  it('returns "Mon DD" format at 30 days (same year)', () => {
    vi.useFakeTimers();
    // Set current time to July 15, 2025
    vi.setSystemTime(new Date(2025, 6, 15));

    const thirtyDaysAgo = new Date(2025, 5, 15); // June 15, 2025
    expect(formatRelativeTime(thirtyDaysAgo)).toBe('Jun 15');

    vi.useRealTimers();
  });

  // --- year format: different year ---

  it('returns "Mon DD, YYYY" format for dates in a different year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 6, 15));

    const lastYear = new Date(2024, 0, 15); // Jan 15, 2024
    expect(formatRelativeTime(lastYear)).toBe('Jan 15, 2024');

    vi.useRealTimers();
  });
});

describe('formatSize', () => {
  // --- Bytes band: < 1024 ---

  it('returns bytes for 0', () => {
    expect(formatSize(0)).toBe('0 B');
  });

  it('returns bytes for 1', () => {
    expect(formatSize(1)).toBe('1 B');
  });

  it('returns bytes for 1023', () => {
    expect(formatSize(1023)).toBe('1023 B');
  });

  // --- KB band: 1024 - 1048575 ---

  it('returns KB at 1024 bytes', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
  });

  it('returns KB for 1536 bytes (1.5 KB)', () => {
    expect(formatSize(1536)).toBe('1.5 KB');
  });

  it('returns KB at boundary (1023.9 KB)', () => {
    expect(formatSize(1024 * 1024 - 1)).toBe('1024.0 KB');
  });

  // --- MB band: 1MB - 1023MB ---

  it('returns MB at 1 MB', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
  });

  it('returns MB for 5.5 MB', () => {
    expect(formatSize(5.5 * 1024 * 1024)).toBe('5.5 MB');
  });

  it('returns MB at boundary (1023.9 MB)', () => {
    expect(formatSize(1024 * 1024 * 1024 - 1)).toBe('1024.0 MB');
  });

  // --- GB band: >= 1GB ---

  it('returns GB at 1 GB', () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('returns GB for 2.5 GB', () => {
    expect(formatSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });

  it('returns GB for 100 GB', () => {
    expect(formatSize(100 * 1024 * 1024 * 1024)).toBe('100.0 GB');
  });

  // --- TB band: >= 1TB ---

  it('returns TB at 1 TB', () => {
    const oneTB = 1024 * 1024 * 1024 * 1024;
    expect(formatSize(oneTB)).toBe('1.0 TB');
  });

  it('returns TB for 2.5 TB', () => {
    const val = 2.5 * 1024 * 1024 * 1024 * 1024;
    expect(formatSize(val)).toBe('2.5 TB');
  });
});
