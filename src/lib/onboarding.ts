/**
 * Feature flag helper for the optional public onboarding landing page.
 * Only the literal value "active" enables onboarding mode.
 */
export function isOnboardingLandingPageActive(value?: string): boolean {
  return value?.trim().toLowerCase() === 'active';
}

