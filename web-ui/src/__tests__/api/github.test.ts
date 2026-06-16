import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch before importing the API module.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  getGithubStatus,
  getGithubRepos,
  disconnectGithub,
  githubConnectUrl,
} from '../../api/github';

function mockSuccessResponse(body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockErrorResponse(status: number, body: Record<string, unknown>) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const REPO = {
  full_name: 'octocat/hello',
  name: 'hello',
  owner: 'octocat',
  private: false,
  visibility: 'public',
  default_branch: 'main',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('GitHub API client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('getGithubStatus', () => {
    it('calls GET /api/github/status', async () => {
      mockSuccessResponse({ enabled: true, connected: false });

      await getGithubStatus();

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/github/status',
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Requested-With': 'XMLHttpRequest' }),
        }),
      );
    });

    it('parses the status contract', async () => {
      mockSuccessResponse({ enabled: true, configured: true, connected: true, login: 'octocat', source: 'oauth' });

      const result = await getGithubStatus();

      expect(result.enabled).toBe(true);
      expect(result.connected).toBe(true);
      expect(result.login).toBe('octocat');
      expect(result.source).toBe('oauth');
    });
  });

  describe('getGithubRepos', () => {
    it('hits /api/github/repos with the page param', async () => {
      mockSuccessResponse({ repos: [], page: 1, hasMore: false });

      await getGithubRepos(1);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/github/repos?page=1',
        expect.objectContaining({}),
      );
    });

    it('requests the requested page number', async () => {
      mockSuccessResponse({ repos: [], page: 3, hasMore: false });

      await getGithubRepos(3);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/github/repos?page=3',
        expect.objectContaining({}),
      );
    });

    it('parses the paginated repos contract', async () => {
      mockSuccessResponse({ repos: [REPO], page: 1, hasMore: true });

      const result = await getGithubRepos(1);

      expect(result.repos).toHaveLength(1);
      expect(result.repos[0].full_name).toBe('octocat/hello');
      expect(result.repos[0].private).toBe(false);
      expect(result.repos[0].default_branch).toBe('main');
      expect(result.page).toBe(1);
      expect(result.hasMore).toBe(true);
    });

    it('throws on 401 NOT_CONNECTED', async () => {
      mockErrorResponse(401, { code: 'NOT_CONNECTED' });

      await expect(getGithubRepos(1)).rejects.toThrow();
    });

    it('throws on 403 GITHUB_DISABLED', async () => {
      mockErrorResponse(403, { code: 'GITHUB_DISABLED' });

      await expect(getGithubRepos(1)).rejects.toThrow();
    });
  });

  describe('disconnectGithub', () => {
    it('POSTs /api/github/disconnect', async () => {
      mockSuccessResponse({ success: true });

      await disconnectGithub();

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/github/disconnect',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('parses the success contract', async () => {
      mockSuccessResponse({ success: true });

      const result = await disconnectGithub();

      expect(result.success).toBe(true);
    });

    it('throws on server error', async () => {
      mockErrorResponse(500, { error: 'Internal error' });

      await expect(disconnectGithub()).rejects.toThrow();
    });
  });

  describe('githubConnectUrl', () => {
    it('returns the connect endpoint', () => {
      expect(githubConnectUrl()).toBe('/api/github/connect');
    });
  });
});
