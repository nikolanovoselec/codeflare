import { z } from 'zod';
import { CloudflareStatusResponseSchema } from '../lib/schemas';
import { baseFetch } from './fetch-helper';

const BASE_URL = '/api';

// Connect-to-Cloudflare OAuth client API. Mirrors api/github.ts: baseFetch with
// credentials:'same-origin' + a Zod schema. Connect is a top-level browser
// navigation (the Worker 302s to Cloudflare and returns to the app), so the caller
// assigns window.location.href to cloudflareConnectUrl() rather than calling fetch.

export type CloudflareStatus = z.infer<typeof CloudflareStatusResponseSchema>;

async function cloudflareFetch<T>(endpoint: string, options: RequestInit, schema: z.ZodType<T>): Promise<T> {
  return baseFetch<T>(`${BASE_URL}${endpoint}`, options, { credentials: 'same-origin', schema });
}

// GET /api/cloudflare/status — connection state (never the token).
export async function getCloudflareStatus(): Promise<CloudflareStatus> {
  return cloudflareFetch('/cloudflare/status', {}, CloudflareStatusResponseSchema);
}

// POST /api/cloudflare/disconnect — revoke at Cloudflare + clear the stored token.
export async function disconnectCloudflare(): Promise<{ success: boolean }> {
  return cloudflareFetch('/cloudflare/disconnect', { method: 'POST' }, z.object({ success: z.boolean() }));
}

// POST /api/cloudflare/account — select the account for the connected token.
export async function selectCloudflareAccount(accountId: string): Promise<{ success: boolean; accountId: string }> {
  return cloudflareFetch(
    '/cloudflare/account',
    { method: 'POST', body: JSON.stringify({ accountId }) },
    z.object({ success: z.boolean(), accountId: z.string() }),
  );
}

// Connect is a top-level browser navigation — the caller assigns window.location.href.
export function cloudflareConnectUrl(): string {
  return '/api/cloudflare/connect';
}
