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
