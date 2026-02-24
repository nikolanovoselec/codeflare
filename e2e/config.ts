/**
 * Shared E2E test configuration.
 *
 * The base URL can be set via:
 * - E2E_BASE_URL (preferred) — direct URL to the deployed worker (e.g., custom domain)
 * - ACCOUNT_SUBDOMAIN + CLOUDFLARE_WORKER_NAME (fallback) — constructs workers.dev URL
 */
function getBaseUrl(): string {
  // Prefer explicit base URL (custom domain with CF Access service auth)
  const explicitUrl = process.env.E2E_BASE_URL;
  if (explicitUrl) {
    // Strip trailing slash for consistency
    return explicitUrl.replace(/\/+$/, '');
  }

  // Fallback: construct workers.dev URL from subdomain
  const subdomain = process.env.ACCOUNT_SUBDOMAIN;
  if (!subdomain) {
    throw new Error(
      'E2E tests require either E2E_BASE_URL or ACCOUNT_SUBDOMAIN to be set.\n' +
      'Preferred: E2E_BASE_URL=https://your-app.example.com npm run test:e2e\n' +
      'Fallback:  ACCOUNT_SUBDOMAIN=your-subdomain npm run test:e2e'
    );
  }

  const workerName = process.env.CLOUDFLARE_WORKER_NAME || 'codeflare';
  return `https://${workerName}.${subdomain}.workers.dev`;
}

export const BASE_URL = getBaseUrl();
