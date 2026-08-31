import { describe, expect, it } from 'vitest';
import { IANA_TIMEZONES } from '../../lib/iana-timezones';

describe('IANA timezone options', () => {
  it('provides stable canonical report-scheduling choices without runtime Intl APIs', () => {
    expect(IANA_TIMEZONES[0]).toBe('UTC');
    expect(IANA_TIMEZONES).toContain('Europe/Zurich');
    expect(IANA_TIMEZONES).toContain('America/New_York');
    expect(new Set(IANA_TIMEZONES).size).toBe(IANA_TIMEZONES.length);
  });
});
