import { describe, expect, it } from 'vitest';
import { isOnboardingLandingPageActive } from '../../lib/onboarding';

describe('isOnboardingLandingPageActive', () => {
  it('returns true only for active (case-insensitive)', () => {
    expect(isOnboardingLandingPageActive('active')).toBe(true);
    expect(isOnboardingLandingPageActive('ACTIVE')).toBe(true);
    expect(isOnboardingLandingPageActive(' Active ')).toBe(true);
  });

  it('returns false for undefined or non-active values', () => {
    expect(isOnboardingLandingPageActive(undefined)).toBe(false);
    expect(isOnboardingLandingPageActive('')).toBe(false);
    expect(isOnboardingLandingPageActive('inactive')).toBe(false);
    expect(isOnboardingLandingPageActive('true')).toBe(false);
  });
});

