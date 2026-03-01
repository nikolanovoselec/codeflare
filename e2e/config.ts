/**
 * Shared E2E test configuration.
 *
 * E2E_BASE_URL must point to the deployed worker (custom domain with CF Access).
 */
function getBaseUrl(): string {
  const baseUrl = process.env.E2E_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      'E2E tests require E2E_BASE_URL to be set.\n' +
      'Usage: E2E_BASE_URL=https://your-app.example.com npm run test:e2e'
    );
  }
  // Auto-prepend https:// if no protocol specified
  const url = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return url.replace(/\/+$/, '');
}

export const BASE_URL = getBaseUrl();

export const SUITE_PREFIX = process.env.E2E_SUITE || 'default';
export const IS_MOBILE = process.env.E2E_MOBILE === '1';

export const TIMEOUTS = {
  DIALOG: 5_000,
  DASHBOARD: 15_000,
  SESSION_CARD: 20_000,
  TERMINAL_READY: 30_000,
  /** Container start -> ready: ~20s typical, 30s max. 45s with margin. */
  CONTAINER_STARTUP: 45_000,
  CONTAINER_STARTUP_EXTENDED: 120_000,
  /** Full session navigation: card click -> init progress -> Open -> terminal. 45s with margin. */
  SESSION_NAV: 45_000,
  KV_PROPAGATION_INTERVAL: 2_000,
  KV_PROPAGATION_RETRIES: 10,
  CONTAINER_POLL_INTERVAL: 1_000,
} as const;
