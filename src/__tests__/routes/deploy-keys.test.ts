import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, DeployKeys } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { AppError } from '../../lib/error-types';

// Hoisted mocks
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })),
  })),
}));

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => ({
    user: { email: 'test@example.com', authenticated: true, role: 'user' },
    bucketName: 'test-bucket',
  })),
}));

// Mock global fetch for token validation
const mockGlobalFetch = vi.fn();
vi.stubGlobal('fetch', mockGlobalFetch);

import deployKeysRoutes from '../../routes/deploy-keys';

describe('Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  function createTestApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as any);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });
    app.use('*', async (c, next) => {
      (c.env as any) = { KV: mockKV };
      return next();
    });
    app.route('/api/deploy-keys', deployKeysRoutes);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockKV = createMockKV();
  });

  // ─── GET ───────────────────────────────────────────────────────────────

  describe('GET /api/deploy-keys', () => {
    it('returns empty when no keys stored', async () => {
      const app = createTestApp();
      const res = await app.request('/api/deploy-keys');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubToken).toBeUndefined();
      expect(body.cloudflareApiToken).toBeUndefined();
      expect(body.cloudflareAccountId).toBeUndefined();
    });

    it('returns masked tokens when keys exist', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        githubToken: 'github_pat_abcdefghijklmnop',
        cloudflareApiToken: 'cf-token-xxxxxxxxxxxxxxx',
        cloudflareAccountId: 'abc123',
      } satisfies DeployKeys);

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubToken).toBe('****mnop');
      expect(body.cloudflareApiToken).toBe('****xxxx');
      expect(body.cloudflareAccountId).toBe('abc123');
    });

    it('masks short tokens correctly', async () => {
      mockKV._set('deploy-keys:test-bucket', { githubToken: 'abc' } satisfies DeployKeys);

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys');
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubToken).toBe('****');
    });

    it('never returns full tokens', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        githubToken: 'github_pat_full_secret_token_1234',
      } satisfies DeployKeys);

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys');
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubToken).not.toContain('github_pat');
      expect(body.githubToken).toMatch(/^\*{4}/);
    });

    it('returns cloudflareAccountId in plain text (not masked)', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        cloudflareApiToken: 'cf-token-xyz',
        cloudflareAccountId: 'my-account-id-123',
      } satisfies DeployKeys);

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys');
      const body = await res.json() as Record<string, unknown>;
      expect(body.cloudflareAccountId).toBe('my-account-id-123');
    });
  });

  // ─── PUT ───────────────────────────────────────────────────────────────

  describe('PUT /api/deploy-keys', () => {
    it('stores a new GitHub token after validation and returns masked', async () => {
      mockGlobalFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'github_pat_test1234567890' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubToken).toBe('****7890');

      // Verify stored in KV
      const stored = await mockKV.get('deploy-keys:test-bucket', 'json') as DeployKeys;
      expect(stored.githubToken).toBe('github_pat_test1234567890');
    });

    it('validates GitHub token against API', async () => {
      mockGlobalFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'testuser' }),
      });

      const app = createTestApp();
      await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'github_pat_valid' }),
      });

      expect(mockGlobalFetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer github_pat_valid',
          }),
        }),
      );
    });

    it('rejects invalid GitHub token', async () => {
      mockGlobalFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'bad-token' }),
      });
      expect(res.status).toBe(400);
    });

    it('stores Cloudflare token and auto-selects single account', async () => {
      mockGlobalFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          result: [{ id: 'acct-123', name: 'My Account' }],
        }),
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareApiToken: 'cf-token-valid' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.cloudflareApiToken).toBe('****alid');
      expect(body.cloudflareAccountId).toBe('acct-123');
      // Single account — no cloudflareAccounts returned
      expect(body.cloudflareAccounts).toBeUndefined();
    });

    it('returns account list when multiple Cloudflare accounts', async () => {
      mockGlobalFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          result: [
            { id: 'acct-1', name: 'Personal' },
            { id: 'acct-2', name: 'Work' },
          ],
        }),
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareApiToken: 'cf-token-multi' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { cloudflareAccounts?: Array<{ id: string; name: string }> };
      expect(body.cloudflareAccounts).toHaveLength(2);
      expect(body.cloudflareAccounts![0].id).toBe('acct-1');
      expect(body.cloudflareAccounts![1].id).toBe('acct-2');
    });

    it('rejects invalid Cloudflare token', async () => {
      mockGlobalFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareApiToken: 'bad-cf-token' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects Cloudflare token with non-array result', async () => {
      mockGlobalFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: 'not-an-array' }),
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareApiToken: 'cf-bad-response' }),
      });
      expect(res.status).toBe(400);
    });

    it('clears GitHub token when null is sent', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        githubToken: 'github_pat_existing',
        cloudflareApiToken: 'cf-token-keep',
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubToken).toBeUndefined();
      expect(body.cloudflareApiToken).toMatch(/^\*{4}/);
    });

    it('clears Cloudflare token and account ID when null is sent', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        cloudflareApiToken: 'cf-existing',
        cloudflareAccountId: 'acct-old',
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareApiToken: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.cloudflareApiToken).toBeUndefined();
      expect(body.cloudflareAccountId).toBeUndefined();
    });

    it('leaves token unchanged when field is omitted', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        githubToken: 'github_pat_keep_this',
      });

      // Set a CF token (requires validation mock)
      mockGlobalFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          result: [{ id: 'acct-1', name: 'Test' }],
        }),
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareApiToken: 'cf-new-token' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubToken).toBe('****this');
      expect(body.cloudflareApiToken).toBe('****oken');
    });

    it('sets cloudflareAccountId explicitly', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        cloudflareApiToken: 'cf-token-existing',
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareAccountId: 'acct-selected' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.cloudflareAccountId).toBe('acct-selected');
    });

    it('deletes KV entry when all keys cleared', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        githubToken: 'github_pat_old',
        cloudflareApiToken: 'cf-old',
      });

      const app = createTestApp();
      await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: null, cloudflareApiToken: null }),
      });

      expect(mockKV.delete).toHaveBeenCalledWith('deploy-keys:test-bucket');
    });

    it('rejects unknown fields', async () => {
      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unknownField: 'value' }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── DELETE ────────────────────────────────────────────────────────────

  describe('DELETE /api/deploy-keys', () => {
    it('removes all keys from KV', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        githubToken: 'github_pat_delete_me',
        cloudflareApiToken: 'cf-delete-me',
        cloudflareAccountId: 'acct-delete',
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(mockKV.delete).toHaveBeenCalledWith('deploy-keys:test-bucket');
    });
  });
});
