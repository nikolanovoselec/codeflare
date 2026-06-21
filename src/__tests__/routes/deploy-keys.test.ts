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

// REQ-AGENT-010: Deploy Credential Storage (GitHub PAT, CF API Token)
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
      // null is the explicit "no account ID" signal (REQ-AGENT-029 AC2).
      expect(body.cloudflareAccountId).toBeNull();
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
      // Single account - no cloudflareAccounts returned
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

    it('drops a stale OAuth/App githubLogin (and refresh/expiry) when a PAT overwrites the connection', async () => {
      // A PAT may be for a different account and carries no login metadata, so a
      // leftover githubLogin would make /api/github/status report the wrong account.
      mockKV._set('deploy-keys:test-bucket', {
        githubToken: 'gho_prior_oauth_token',
        githubTokenSource: 'oauth',
        githubLogin: 'octo',
        githubRefreshToken: 'ghr_refresh',
        githubTokenExpiresAt: 9999999999,
      });
      // validateGithubToken calls GitHub; the PAT is valid.
      mockGlobalFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'newuser' }) });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'github_pat_new_account_token' }),
      });
      expect(res.status).toBe(200);

      const stored = await mockKV.get('deploy-keys:test-bucket', 'json') as DeployKeys;
      expect(stored.githubToken).toBe('github_pat_new_account_token');
      expect(stored.githubTokenSource).toBe('pat');
      expect(stored.githubLogin).toBeUndefined();
      expect(stored.githubRefreshToken).toBeUndefined();
      expect(stored.githubTokenExpiresAt).toBeUndefined();
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
      expect(body.cloudflareAccountId).toBeNull();
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

    it('sets cloudflareAccountId after validating it against the stored token', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        cloudflareApiToken: 'cf-token-existing',
      });
      // Account ID must be re-validated against the token's account list.
      mockGlobalFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          result: [{ id: 'acct-selected', name: 'Test' }, { id: 'acct-other', name: 'Other' }],
        }),
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

    it('rejects a cloudflareAccountId not accessible with the stored token', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        cloudflareApiToken: 'cf-token-existing',
      });
      mockGlobalFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          result: [{ id: 'acct-real', name: 'Test' }],
        }),
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareAccountId: 'acct-forged' }),
      });
      expect(res.status).toBe(400);
      // The forged ID must not have been persisted.
      const stored = await mockKV.get('deploy-keys:test-bucket', 'json') as DeployKeys;
      expect(stored.cloudflareAccountId).toBeUndefined();
    });

    it('rejects a cloudflareAccountId when no Cloudflare token is stored', async () => {
      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareAccountId: 'acct-orphan' }),
      });
      expect(res.status).toBe(400);
    });

    it('reuses single-request validation when token and account ID are co-submitted', async () => {
      // Token has multiple accounts; the same request also selects one.
      // Only one validation fetch should run (reused, not re-fetched).
      mockGlobalFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          result: [{ id: 'acct-a', name: 'A' }, { id: 'acct-b', name: 'B' }],
        }),
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareApiToken: 'cf-multi', cloudflareAccountId: 'acct-b' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.cloudflareAccountId).toBe('acct-b');
      // validateCloudflareToken called exactly once for the co-submitted token.
      expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
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

  // ─── Encryption (CF-003) ─────────────────────────────────────────────────
  // Ported from llm-keys.test.ts. The base test app sets no ENCRYPTION_KEY, so
  // the v1:-ciphertext path went unasserted here. With ENCRYPTION_KEY set, PUT
  // must store an encrypted v1: blob (not plaintext JSON) and GET must decrypt
  // and mask it round-trip.
  describe('PUT /api/deploy-keys - encryption', () => {
    // Generate key ONCE so PUT and GET share the same key.
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const stableBase64Key = btoa(String.fromCharCode(...rawKey));

    function createEncryptedTestApp() {
      const app = new Hono<{ Bindings: Env }>();
      app.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as any);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });
      app.use('*', async (c, next) => {
        (c.env as any) = { KV: mockKV, ENCRYPTION_KEY: stableBase64Key };
        return next();
      });
      app.route('/api/deploy-keys', deployKeysRoutes);
      return app;
    }

    it('stores encrypted value with v1: prefix when ENCRYPTION_KEY set', async () => {
      // GitHub token requires API validation before store.
      mockGlobalFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'testuser' }) });

      const app = createEncryptedTestApp();
      await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'github_pat_encrypted_test' }),
      });

      const rawStored = mockKV._store.get('deploy-keys:test-bucket');
      expect(rawStored).toBeDefined();
      expect(rawStored!.startsWith('v1:')).toBe(true);
      // Ciphertext must not be parseable plaintext JSON.
      expect(() => JSON.parse(rawStored!)).toThrow();
      // And must not contain the secret in the clear.
      expect(rawStored!).not.toContain('github_pat_encrypted_test');
    });

    it('GET decrypts correctly when ENCRYPTION_KEY set', async () => {
      mockGlobalFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ login: 'testuser' }) });

      const app = createEncryptedTestApp();

      // First store via PUT (encrypted).
      await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'github_pat_roundtrip1234' }),
      });

      // Then read via GET (should decrypt and mask).
      const res = await app.request('/api/deploy-keys');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubToken).toBe('****1234');
    });
  });
});
