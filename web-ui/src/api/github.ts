import { z } from 'zod';
import {
  GithubStatusResponseSchema,
  GithubReposResponseSchema,
} from '../lib/schemas';
import { baseFetch } from './fetch-helper';

const BASE_URL = '/api';

// Phase-3 GitHub panel API (read-only connect + repo browsing).
// Mirrors the storage/client fetch pattern: baseFetch with
// credentials:'same-origin' and a Zod schema for response validation.

export type GithubStatus = z.infer<typeof GithubStatusResponseSchema>;
export type GithubReposResponse = z.infer<typeof GithubReposResponseSchema>;
export type GithubRepo = GithubReposResponse['repos'][number];

async function githubFetch<T>(endpoint: string, options: RequestInit, schema: z.ZodType<T>): Promise<T> {
  return baseFetch<T>(`${BASE_URL}${endpoint}`, options, {
    credentials: 'same-origin',
    schema,
  });
}

// GET /api/github/status — when enabled is false the panel renders nothing.
export async function getGithubStatus(): Promise<GithubStatus> {
  return githubFetch('/github/status', {}, GithubStatusResponseSchema);
}

// GET /api/github/repos?page=N — 401 NOT_CONNECTED / 403 GITHUB_DISABLED
// surface as ApiError (with .code) via baseFetch.
export async function getGithubRepos(page: number): Promise<GithubReposResponse> {
  return githubFetch(`/github/repos?page=${page}`, {}, GithubReposResponseSchema);
}

// POST /api/github/disconnect — clears the stored connection.
export async function disconnectGithub(): Promise<{ success: boolean }> {
  return githubFetch(
    '/github/disconnect',
    { method: 'POST' },
    z.object({ success: z.boolean() }),
  );
}

// Connect is a top-level browser navigation (the Worker 302s to GitHub
// and returns to /app/?github=connected). This is not a fetch — the
// caller assigns window.location.href to this value.
export function githubConnectUrl(): string {
  return '/api/github/connect';
}
