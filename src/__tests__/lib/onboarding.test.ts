import { describe, expect, it } from 'vitest';
import { isOnboardingLandingPageActive, isSaasModeActive, isSessionOidcMode } from '../../lib/onboarding';

describe('isOnboardingLandingPageActive / REQ-SETUP-003 (three deploy modes: Default / Onboarding / SaaS)', () => {
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

describe('isSaasModeActive / REQ-SETUP-003 AC3', () => {
  it('REQ-SETUP-003 AC3: returns true when SAAS_MODE binding is the literal string "active"', () => {
    expect(isSaasModeActive('active')).toBe(true);
  });

  it('REQ-SETUP-003 AC3: returns true for SAAS_MODE=active case-insensitively', () => {
    expect(isSaasModeActive('ACTIVE')).toBe(true);
    expect(isSaasModeActive(' Active ')).toBe(true);
  });

  it('REQ-SETUP-003 AC1: returns false when SAAS_MODE is undefined - default mode is CF Access', () => {
    expect(isSaasModeActive(undefined)).toBe(false);
  });

  it('REQ-SETUP-003 AC3: returns false for any value other than "active"', () => {
    expect(isSaasModeActive('')).toBe(false);
    expect(isSaasModeActive('inactive')).toBe(false);
    expect(isSaasModeActive('true')).toBe(false);
    expect(isSaasModeActive('1')).toBe(false);
  });
});

describe('deployment mode helpers - REQ-SETUP-003 AC4 binding semantics', () => {
  it('REQ-SETUP-003 AC4: SAAS_MODE and ONBOARDING_LANDING_PAGE are independent - both inactive by default', () => {
    expect(isSaasModeActive(undefined)).toBe(false);
    expect(isOnboardingLandingPageActive(undefined)).toBe(false);
  });

  it('REQ-SETUP-003 AC4: SAAS_MODE active does not affect ONBOARDING_LANDING_PAGE detection', () => {
    expect(isSaasModeActive('active')).toBe(true);
    expect(isOnboardingLandingPageActive('inactive')).toBe(false);
  });

  it('REQ-SETUP-003 AC2: ONBOARDING_LANDING_PAGE=active activates onboarding mode independently of SAAS_MODE', () => {
    expect(isOnboardingLandingPageActive('active')).toBe(true);
    expect(isSaasModeActive(undefined)).toBe(false);
  });
});

describe('isSessionOidcMode / REQ-AUTH-021 (app-owned codeflare_session trust)', () => {
  it('is true when SaaS mode is active', () => {
    expect(isSessionOidcMode({ SAAS_MODE: 'active', ONBOARDING_LANDING_PAGE: 'inactive' })).toBe(true);
  });

  it('is true when onboarding mode is active (the bug this fixes: SaaS inactive)', () => {
    expect(isSessionOidcMode({ SAAS_MODE: 'inactive', ONBOARDING_LANDING_PAGE: 'active' })).toBe(true);
  });

  it('is false when both are inactive (CF Access / default mode owns auth)', () => {
    expect(isSessionOidcMode({ SAAS_MODE: 'inactive', ONBOARDING_LANDING_PAGE: 'inactive' })).toBe(false);
    expect(isSessionOidcMode({})).toBe(false);
  });
});

