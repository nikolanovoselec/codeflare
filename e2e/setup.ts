// E2E Test Setup
// Uses workers.dev URL with DEV_MODE=true (no auth required for testing)
// TODO: Add local miniflare mode for offline/CI testing without a deployed worker
import { BASE_URL } from './config';
export { BASE_URL };

// Helper to make API requests
export async function apiRequest(path: string, options?: RequestInit) {
  const url = `${BASE_URL}${path}`;
  return fetch(url, options);
}
