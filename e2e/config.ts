/**
 * Shared E2E test configuration.
 *
 * The base URL is constructed from two environment variables:
 * - ACCOUNT_SUBDOMAIN (required) — your Cloudflare account subdomain
 * - CLOUDFLARE_WORKER_NAME (optional, defaults to 'codeflare')
 */
function getBaseUrl(): string {
  const subdomain = process.env.ACCOUNT_SUBDOMAIN;
  if (!subdomain) {
    throw new Error(
      'E2E tests require ACCOUNT_SUBDOMAIN to be set.\n' +
      'Find it in: Cloudflare dashboard > Workers & Pages > Overview > your subdomain.\n' +
      'Usage: ACCOUNT_SUBDOMAIN=your-subdomain npm run test:e2e'
    );
  }

  const workerName = process.env.CLOUDFLARE_WORKER_NAME || 'codeflare';
  return `https://${workerName}.${subdomain}.workers.dev`;
}

export const BASE_URL = getBaseUrl();
