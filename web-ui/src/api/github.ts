import { z } from 'zod';
import {
  GithubStatusResponseSchema,
  GithubReposResponseSchema,
  GithubCloneResponseSchema,
} from '../lib/schemas';
import { ApiError, baseFetch } from './fetch-helper';

const BASE_URL = '/api';

// Phase-3 GitHub panel API (read-only connect + repo browsing).
// Mirrors the storage/client fetch pattern: baseFetch with
// credentials:'same-origin' and a Zod schema for response validation.

export type GithubStatus = z.infer<typeof GithubStatusResponseSchema>;
export type GithubReposResponse = z.infer<typeof GithubReposResponseSchema>;
export type GithubRepo = GithubReposResponse['repos'][number];

// A completed checkout with unconfirmed restore tracking is not a failed clone.
export type CloneIntoSessionResult =
  | { outcome: 'cloned'; path: string }
  | { outcome: 'exists' }
  | { outcome: 'tracking-unconfirmed' }
  | { outcome: 'failed'; code?: string };

export interface CloneIntoSessionArgs {
  repo: string;
  sessionId: string;
  // Optional git ref. Omitted today (backend defaults to the repo's default
  // branch); kept so a future branch picker is a one-line change.
  ref?: string;
}

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

const OwnedRepoCountsSchema = z.union([
  z.object({ counts: z.null() }),
  z.object({ login: z.string(), counts: z.object({ public: z.int().nonnegative(), private: z.int().nonnegative(), total: z.int().nonnegative() }) }),
]);

export function getGithubOwnedRepoCounts() {
  return githubFetch('/github/owned-repo-counts', {}, OwnedRepoCountsSchema);
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

// POST /api/github/clone — clone a repo into a RUNNING session's workspace.
// Map the two distinct 409 outcomes before treating the response as a failure.
export async function cloneIntoSession(args: CloneIntoSessionArgs): Promise<CloneIntoSessionResult> {
  const body: Record<string, unknown> = { repo: args.repo, sessionId: args.sessionId };
  if (args.ref) body.ref = args.ref;
  try {
    const res = await githubFetch(
      '/github/clone',
      { method: 'POST', body: JSON.stringify(body) },
      GithubCloneResponseSchema,
    );
    return { outcome: 'cloned', path: res.path };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'CLONE_TARGET_EXISTS') {
      return { outcome: 'exists' };
    }
    if (err instanceof ApiError && err.code === 'CLONE_TRACKING_UNCONFIRMED') return { outcome: 'tracking-unconfirmed' };
    return { outcome: 'failed', code: err instanceof ApiError ? err.code : undefined };
  }
}
