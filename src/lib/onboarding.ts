/**
 * Feature flag helper for the optional public onboarding landing page.
 * Only the literal value "active" enables onboarding mode.
 */
export function isOnboardingLandingPageActive(value?: string): boolean {
  return value?.trim().toLowerCase() === 'active';
}

export function isSaasModeActive(value?: string): boolean {
  return value?.trim().toLowerCase() === 'active';
}

/**
 * Modes in which the app issues and trusts its OWN GitHub-OIDC session cookie
 * (codeflare_session), rather than delegating auth to Cloudflare Access:
 * SaaS mode and onboarding mode. Enterprise / default deployments use CF Access
 * instead, so they are NOT included here.
 *
 * REQ-AUTH-020: the onboarding GitHub callback issues codeflare_session, so the
 * access layer and the session-refresh path must trust it in onboarding mode too
 * (not only SaaS) or an approved user can never reach /app in onboarding.
 */
export function isSessionOidcMode(env: {
  SAAS_MODE?: string;
  ONBOARDING_LANDING_PAGE?: string;
}): boolean {
  return isSaasModeActive(env.SAAS_MODE) || isOnboardingLandingPageActive(env.ONBOARDING_LANDING_PAGE);
}

