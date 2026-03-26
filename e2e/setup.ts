// E2E Test Setup
// Two auth modes:
//   CF Access mode:  CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET (passes CF Access gateway + Worker)
//   GitHub OIDC mode: OAUTH_E2E_TEST_SECRET only (no CF Access gateway, Worker auth via X-Service-Auth)
import { BASE_URL } from './config';
export { BASE_URL };

const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID || '';
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || '';
const SERVICE_AUTH_SECRET = CF_ACCESS_CLIENT_SECRET || process.env.OAUTH_E2E_TEST_SECRET || '';

if (!SERVICE_AUTH_SECRET) {
  throw new Error(
    'E2E tests require an auth secret.\n' +
    'CF Access mode: set CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET.\n' +
    'GitHub OIDC mode: set OAUTH_E2E_TEST_SECRET.\n' +
    'Generate with: openssl rand -base64 32'
  );
}

// Helper to make API requests with service auth headers
export async function apiRequest(path: string, options?: RequestInit) {
  const url = `${BASE_URL}${path}`;
  const headers = new Headers(options?.headers);
  // CF Access headers (only when CF Access is configured)
  if (CF_ACCESS_CLIENT_ID) headers.set('CF-Access-Client-Id', CF_ACCESS_CLIENT_ID);
  if (CF_ACCESS_CLIENT_SECRET) headers.set('CF-Access-Client-Secret', CF_ACCESS_CLIENT_SECRET);
  // Worker auth header (works in both modes)
  headers.set('X-Service-Auth', SERVICE_AUTH_SECRET);

  // Add CSRF header for state-changing methods
  const method = options?.method?.toUpperCase() || 'GET';
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    headers.set('X-Requested-With', 'fetch');
  }

  return fetch(url, { ...options, headers });
}
