import { describe, expect, it } from 'vitest';
import { latestClosedMonth, nextReportDelivery, normalizeReportSettings } from '../../lib/usage-reports';

describe('usage report settings and schedule (REQ-SUB-027)', () => {
  it('keeps disabled reports closed and credential-free', () => {
    expect(normalizeReportSettings({ enabled: false })).toEqual({ enabled: false });
  });

  it('normalizes unique recipients and validates canonical IANA timezone and whole hour', () => {
    expect(normalizeReportSettings({
      enabled: true,
      recipients: [' Admin@Example.com ', 'admin@example.com', 'ops@example.com'],
      day: 15,
      hour: 9,
      timezone: 'Europe/Zurich',
    })).toEqual({
      enabled: true,
      recipients: ['admin@example.com', 'ops@example.com'],
      day: 15,
      hour: 9,
      timezone: 'Europe/Zurich',
    });
    expect(() => normalizeReportSettings({ enabled: true, recipients: ['a@example.com'], day: 1, hour: 9.5, timezone: 'Europe/Zurich' })).toThrow();
    expect(() => normalizeReportSettings({ enabled: true, recipients: ['a@example.com'], day: 1, hour: 9, timezone: 'CET' })).toThrow();
    expect(() => normalizeReportSettings({ enabled: true, recipients: ['a@example.com'], day: 1, hour: 9, timezone: 'Bad/Zone' })).toThrow();
    expect(() => normalizeReportSettings({ enabled: true, recipients: [], day: 1, hour: 9, timezone: 'UTC' })).toThrow();
    expect(() => normalizeReportSettings({ enabled: true, recipients: ['invalid'], day: 1, hour: 9, timezone: 'UTC' })).toThrow();
    expect(() => normalizeReportSettings({ enabled: true, recipients: Array.from({ length: 26 }, (_, index) => `user${index}@example.com`), day: 1, hour: 9, timezone: 'UTC' })).toThrow();
  });

  it('uses the last valid day when a requested 31st is absent', () => {
    expect(nextReportDelivery({ day: 31, hour: 9, timezone: 'Europe/Zurich' }, new Date('2027-02-01T00:00:00.000Z')).toISOString())
      .toBe('2027-02-28T08:00:00.000Z');
  });

  it('tracks Europe/Zurich CET and CEST offsets', () => {
    expect(nextReportDelivery({ day: 15, hour: 9, timezone: 'Europe/Zurich' }, new Date('2027-01-01T00:00:00.000Z')).toISOString())
      .toBe('2027-01-15T08:00:00.000Z');
    expect(nextReportDelivery({ day: 15, hour: 9, timezone: 'Europe/Zurich' }, new Date('2027-07-01T00:00:00.000Z')).toISOString())
      .toBe('2027-07-15T07:00:00.000Z');
  });

  it('resolves a missing spring-forward hour to the first later local instant', () => {
    expect(nextReportDelivery({ day: 28, hour: 2, timezone: 'Europe/Zurich' }, new Date('2027-03-01T00:00:00.000Z')).toISOString())
      .toBe('2027-03-28T01:00:00.000Z');
  });

  it('chooses one instant for the repeated fall-back hour', () => {
    expect(nextReportDelivery({ day: 31, hour: 2, timezone: 'Europe/Zurich' }, new Date('2027-10-01T00:00:00.000Z')).toISOString())
      .toBe('2027-10-31T00:00:00.000Z');
  });

  it('selects the latest closed UTC month', () => {
    expect(latestClosedMonth(new Date('2027-01-01T00:00:00.000Z'))).toBe('2026-12');
    expect(latestClosedMonth(new Date('2027-08-15T12:00:00.000Z'))).toBe('2027-07');
  });
});
