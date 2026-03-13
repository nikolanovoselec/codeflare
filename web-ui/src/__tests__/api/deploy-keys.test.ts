import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch before importing client
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { getDeployKeys, updateDeployKeys, deleteDeployKeys } from '../../api/client';

describe('Deploy Keys API client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockSuccessResponse(body: Record<string, unknown>) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  function mockErrorResponse(status: number, message: string) {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status,
      text: () => Promise.resolve(JSON.stringify({ error: message })),
    });
  }

  // ─── getDeployKeys ───────────────────────────────────────────────────

  describe('getDeployKeys', () => {
    it('calls GET /api/deploy-keys', async () => {
      mockSuccessResponse({});

      await getDeployKeys();

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/deploy-keys',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Requested-With': 'XMLHttpRequest',
          }),
        }),
      );
    });

    it('returns empty response when no keys set', async () => {
      mockSuccessResponse({});

      const result = await getDeployKeys();
      expect(result.githubToken).toBeUndefined();
      expect(result.cloudflareApiToken).toBeUndefined();
      expect(result.cloudflareAccountId).toBeUndefined();
    });

    it('returns masked tokens and account ID', async () => {
      mockSuccessResponse({
        githubToken: '****1234',
        cloudflareApiToken: '****abcd',
        cloudflareAccountId: 'acct-123',
      });

      const result = await getDeployKeys();
      expect(result.githubToken).toBe('****1234');
      expect(result.cloudflareApiToken).toBe('****abcd');
      expect(result.cloudflareAccountId).toBe('acct-123');
    });

    it('throws on HTTP error', async () => {
      mockErrorResponse(401, 'Unauthorized');

      await expect(getDeployKeys()).rejects.toThrow();
    });
  });

  // ─── updateDeployKeys ────────────────────────────────────────────────

  describe('updateDeployKeys', () => {
    it('calls PUT /api/deploy-keys with correct body', async () => {
      mockSuccessResponse({ githubToken: '****5678' });

      await updateDeployKeys({ githubToken: 'github_pat_new' });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/deploy-keys',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ githubToken: 'github_pat_new' }),
        }),
      );
    });

    it('sends null to clear a token', async () => {
      mockSuccessResponse({});

      await updateDeployKeys({ githubToken: null });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/deploy-keys',
        expect.objectContaining({
          body: JSON.stringify({ githubToken: null }),
        }),
      );
    });

    it('returns masked tokens and cloudflareAccounts when multi-account', async () => {
      mockSuccessResponse({
        cloudflareApiToken: '****abcd',
        cloudflareAccounts: [
          { id: 'acct-1', name: 'Personal' },
          { id: 'acct-2', name: 'Work' },
        ],
      });

      const result = await updateDeployKeys({ cloudflareApiToken: 'cf-token' });
      expect(result.cloudflareApiToken).toBe('****abcd');
      expect(result.cloudflareAccounts).toHaveLength(2);
      expect(result.cloudflareAccounts![0].name).toBe('Personal');
    });

    it('sends cloudflareAccountId for account selection', async () => {
      mockSuccessResponse({ cloudflareAccountId: 'acct-selected' });

      await updateDeployKeys({ cloudflareAccountId: 'acct-selected' });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/deploy-keys',
        expect.objectContaining({
          body: JSON.stringify({ cloudflareAccountId: 'acct-selected' }),
        }),
      );
    });

    it('throws on validation error', async () => {
      mockErrorResponse(400, 'Invalid GitHub token');

      await expect(
        updateDeployKeys({ githubToken: 'bad' })
      ).rejects.toThrow();
    });
  });

  // ─── deleteDeployKeys ────────────────────────────────────────────────

  describe('deleteDeployKeys', () => {
    it('calls DELETE /api/deploy-keys', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await deleteDeployKeys();

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/deploy-keys',
        expect.objectContaining({
          method: 'DELETE',
        }),
      );
    });

    it('throws on server error', async () => {
      mockErrorResponse(500, 'Internal error');

      await expect(deleteDeployKeys()).rejects.toThrow();
    });
  });
});
