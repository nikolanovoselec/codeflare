/**
 * Central integration config: every URL the landing page exchanges with the
 * Codeflare Worker or the SPA lives here. Components and controllers import
 * these constants — no endpoint or app-route string literals elsewhere.
 *
 * REQ-LANDING-002 (contact endpoint contract): the paths below must match
 * the Worker routes mounted under /public (src/routes/public/index.ts).
 */

/** Worker API endpoints consumed by the landing page. */
export const ENDPOINTS = {
  /** POST — demo-request form submission (Turnstile-protected). */
  contact: '/public/contact',
  /** GET — public config: Turnstile site key for the contact widget. */
  contactConfig: '/public/contact-config',
} as const;

/** Links into the Codeflare app (served by the same Worker). */
export const APP_LINKS = {
  /**
   * Sign-in entry point: the SPA /login route, which renders the provider
   * chooser (GitHub, Google, OIDC, one-time-pin) and starts the OAuth flow.
   * NOT /app/ — that path bounces an unauthenticated visitor back to the
   * marketing landing (SPA guard redirects to /), so it never reaches login.
   */
  signIn: '/login',
  /** Privacy policy page (static, served from the landing build). */
  privacy: '/landing/privacy/',
} as const;
