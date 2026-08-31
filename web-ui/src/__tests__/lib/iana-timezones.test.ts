import { describe, expect, it } from 'vitest';
import { IANA_TIMEZONES, ianaTimezoneOptions } from '../../lib/iana-timezones';

describe('IANA timezone options', () => {
  it('REQ-SETUP-020 AC1: provides stable canonical report-scheduling choices and preserves accepted stored values', () => {
    expect(IANA_TIMEZONES[0]).toBe('UTC');
    expect(IANA_TIMEZONES).toContain('Europe/Zurich');
    expect(IANA_TIMEZONES).toContain('America/New_York');
    expect(new Set(IANA_TIMEZONES).size).toBe(IANA_TIMEZONES.length);
    expect(ianaTimezoneOptions('Europe/Zurich')).toBe(IANA_TIMEZONES);
    expect(ianaTimezoneOptions('Etc/GMT+1')[0]).toBe('Etc/GMT+1');
    expect(ianaTimezoneOptions('Etc/GMT+1')).toContain('UTC');
  });
});
