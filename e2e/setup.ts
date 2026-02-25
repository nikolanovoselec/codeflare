// E2E Test Setup
// Uses E2E_BASE_URL with CF Access service tokens for authentication
import { BASE_URL } from './config';
export { BASE_URL };

// Service token credentials from environment
const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID;
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

if (!CF_ACCESS_CLIENT_ID || !CF_ACCESS_CLIENT_SECRET) {
  throw new Error(
    'E2E tests require CF Access service token credentials.\n' +
    'Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET environment variables.\n' +
    'Create a service token in Cloudflare Access > Service Auth > Service Tokens.'
  );
}

// Helper to make API requests with service token + direct auth headers
export async function apiRequest(path: string, options?: RequestInit) {
  const url = `${BASE_URL}${path}`;
  const headers = new Headers(options?.headers);
  // CF Access service token headers (pass through CF Access edge)
  headers.set('CF-Access-Client-Id', CF_ACCESS_CLIENT_ID!);
  headers.set('CF-Access-Client-Secret', CF_ACCESS_CLIENT_SECRET!);
  // Direct service auth header (validated by worker, not stripped by CF Access)
  headers.set('X-Service-Auth', CF_ACCESS_CLIENT_SECRET!);

  // Add CSRF header for state-changing methods
  const method = options?.method?.toUpperCase() || 'GET';
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    headers.set('X-Requested-With', 'fetch');
  }

  return fetch(url, { ...options, headers });
}
