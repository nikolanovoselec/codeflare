import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, DeployKeys } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { AppError, AuthError } from '../../lib/error-types';
import { getValidCloudflareToken } from '../../lib/cloudflare-token';
import { SETUP_KEYS } from '../../lib/kv-keys';

const mockIdentity = vi.hoisted(() => ({ role: 'user' as 'user' | 'admin' }));

// Hoisted mocks
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })),
  })),
}));

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => ({
    user: { email: 'test@example.com', authenticated: true, role: mockIdentity.role },
    bucketName: 'test-bucket',
  })),
}));

// Mock global fetch for token validation
const mockGlobalFetch = vi.fn();
vi.stubGlobal('fetch', mockGlobalFetch);

import deployKeysRoutes from '../../routes/deploy-keys';
import { authenticateRequest } from '../../lib/access';

// REQ-AGENT-010: Deploy Credential Storage (GitHub PAT, CF API Token)
describe('Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  function createTestApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as any);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });
    app.use('*', async (c, next) => {
      (c.env as any) = { KV: mockKV, ...envOverrides };
      return next();
    });
    app.route('/api/deploy-keys', deployKeysRoutes);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobalFetch.mockReset();
    // A provider request without an explicit success fixture becomes an observable
    // boundary error, not an accidentally successful validation or live traffic.
    mockGlobalFetch.mockRejectedValue(new AppError(
      'TEST_PROVIDER_BOUNDARY', 502, 'Synthetic provider boundary rejects validation',
    ));
    mockIdentity.role = 'user';
    mockKV = createMockKV();
  });

  function allowProviderValidation() {
    mockGlobalFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://api.github.com/user') {
        return Response.json({ login: 'synthetic-replacement' });
      }
      if (url === 'https://api.cloudflare.com/client/v4/accounts') {
        return Response.json({
          success: true,
          result: [{ id: 'synthetic-account-new', name: 'Synthetic account' }],
        });
      }
      throw new AppError('TEST_PROVIDER_BOUNDARY', 502, 'Unexpected synthetic provider destination');
    });
  }

  // REQ-ENTERPRISE-306 AC1: Enterprise direct deploy credential boundary.
  describe('REQ-ENTERPRISE-009 AC8: enterprise deploy credentials are disabled', () => {
    const replacementPayloads = [
      { label: 'GitHub replacement', payload: { githubToken: 'synthetic-personal-github-token' } },
      { label: 'Cloudflare replacement', payload: { cloudflareApiToken: 'synthetic-personal-cloudflare-token' } },
      {
        label: 'mixed replacement',
        payload: {
          githubToken: 'synthetic-personal-github-token',
          cloudflareApiToken: 'synthetic-personal-cloudflare-token',
          cloudflareAccountId: 'synthetic-account-new',
        },
      },
      { label: 'Cloudflare account selection', payload: { cloudflareAccountId: 'synthetic-account-new' } },
    ];
    const updatePayloads = [
      ...replacementPayloads,
      { label: 'GitHub clearing', payload: { githubToken: null } },
      { label: 'Cloudflare clearing', payload: { cloudflareApiToken: null } },
      { label: 'mixed clearing', payload: { githubToken: null, cloudflareApiToken: null } },
      { label: 'Cloudflare account clearing', payload: { cloudflareAccountId: null } },
      { label: 'empty update', payload: {} },
      { label: 'invalid credential schema', payload: { githubToken: 42 } },
    ];

    describe.each(['user', 'admin'] as const)('authenticated %s', role => {
      describe.each(['app', 'oauth'] as const)('managed GitHub %s connection', source => {
        let managedConnection: DeployKeys;
        let storedBefore: string;

        beforeEach(() => {
          mockIdentity.role = role;
          managedConnection = {
            githubToken: `synthetic-managed-${source}-token`,
            githubTokenSource: source,
            githubLogin: 'synthetic-connected-user',
            ...(source === 'app' ? {
              githubRefreshToken: 'synthetic-managed-app-refresh',
              githubTokenExpiresAt: 4102444800000,
            } : {}),
            cloudflareApiToken: 'synthetic-managed-cloudflare-token',
            cloudflareAccountId: 'synthetic-account-original',
            cloudflareTokenSource: 'oauth',
            cloudflareRefreshToken: 'synthetic-managed-cloudflare-refresh',
            cloudflareTokenExpiresAt: 4102444800000,
          };
          mockKV._set('deploy-keys:test-bucket', managedConnection);
          storedBefore = mockKV._store.get('deploy-keys:test-bucket')!;
        });

        async function expectCredentialDenial(res: Response) {
          expect(res.status).toBe(403);
          // The existing ForbiddenError wire contract discloses neither masked
          // credentials, account/login metadata, refresh tokens nor token source.
          expect(await res.json()).toEqual({ error: 'Access denied', code: 'FORBIDDEN' });
          expect(mockKV._store.get('deploy-keys:test-bucket')).toBe(storedBefore);
        }

        it.each(['GET', 'PUT', 'DELETE'] as const)(
          'REQ-ENTERPRISE-009 AC8: %s returns 403 without credential disclosure or mutation',
          async method => {
            allowProviderValidation();
            const res = await createTestApp({ ENTERPRISE_MODE: 'active' }).request('/api/deploy-keys', {
              method,
              ...(method === 'PUT' ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ githubToken: 'synthetic-personal-github-token' }),
              } : {}),
            });
            await expectCredentialDenial(res);
          },
        );

        it.each(['GET', 'PUT', 'DELETE'] as const)(
          'REQ-ENTERPRISE-009 AC8: %s is forbidden even when credential storage rejects access',
          async method => {
            const unavailable = new AppError('TEST_CREDENTIAL_BOUNDARY', 503, 'Synthetic storage unavailable');
            mockKV.get.mockRejectedValue(unavailable);
            mockKV.put.mockRejectedValue(unavailable);
            mockKV.delete.mockRejectedValue(unavailable);
            const res = await createTestApp({ ENTERPRISE_MODE: 'active' }).request('/api/deploy-keys', {
              method,
              ...(method === 'PUT' ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ githubToken: null }),
              } : {}),
            });
            await expectCredentialDenial(res);
          },
        );

        it.each(updatePayloads)(
          'REQ-ENTERPRISE-009 AC8: $label is forbidden without changing a managed connection',
          async ({ payload }) => {
            allowProviderValidation();
            const res = await createTestApp({ ENTERPRISE_MODE: 'active' }).request('/api/deploy-keys', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            await expectCredentialDenial(res);
          },
        );

        it.each(replacementPayloads)(
          'REQ-ENTERPRISE-009 AC8: $label is forbidden before the rejecting provider boundary',
          async ({ payload }) => {
            // The default provider fixture rejects with TEST_PROVIDER_BOUNDARY /
            // 502. A 403 FORBIDDEN outcome proves denial precedes validation;
            // no private-helper assertions or mock invocation counts are needed.
            const res = await createTestApp({ ENTERPRISE_MODE: 'active' }).request('/api/deploy-keys', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            await expectCredentialDenial(res);
          },
        );

        it('REQ-ENTERPRISE-009 AC8: malformed JSON is forbidden before body parsing', async () => {
          const res = await createTestApp({ ENTERPRISE_MODE: 'active' }).request('/api/deploy-keys', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: '{"githubToken":',
          });
          await expectCredentialDenial(res);
        });
      });
    });

    it.each(['GET', 'PUT', 'DELETE'] as const)(
      'REQ-ENTERPRISE-009 AC8: unauthenticated %s retains authentication failure before Enterprise denial',
      async method => {
        vi.mocked(authenticateRequest).mockRejectedValueOnce(new AuthError());
        const res = await createTestApp({ ENTERPRISE_MODE: 'active' }).request('/api/deploy-keys', {
          method,
          ...(method === 'PUT' ? { body: '{"githubToken":' } : {}),
        });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Authentication required', code: 'AUTH_ERROR' });
        expect(await mockKV.get('deploy-keys:test-bucket', 'json')).toBeNull();
      },
    );
  });

  it.each(['user', 'admin'] as const)(
    'REQ-ENTERPRISE-009 AC7 / REQ-AGENT-010: flag-unset %s retains deploy credential write, masked read and delete',
    async role => {
      mockIdentity.role = role;
      allowProviderValidation();
      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubToken: 'synthetic-personal-github-token',
          cloudflareApiToken: 'synthetic-personal-cloudflare-token',
          cloudflareAccountId: 'synthetic-account-new',
        }),
      });
      const maskedCredentials = {
        githubToken: '****oken',
        cloudflareApiToken: '****oken',
        cloudflareAccountId: 'synthetic-account-new',
      };
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(maskedCredentials);
      expect(await mockKV.get('deploy-keys:test-bucket', 'json')).toEqual({
        githubToken: 'synthetic-personal-github-token',
        githubTokenSource: 'pat',
        cloudflareApiToken: 'synthetic-personal-cloudflare-token',
        cloudflareAccountId: 'synthetic-account-new',
      });
      const read = await app.request('/api/deploy-keys');
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(maskedCredentials);
      const deleted = await app.request('/api/deploy-keys', { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ success: true });
      expect(await mockKV.get('deploy-keys:test-bucket', 'json')).toBeNull();
    },
  );

  it.each(['PUT', 'DELETE'])('CON-SEC-004 / REQ-SEC-007 AC1/3/4: unwrapped %s shares the authenticated mutation bound', async method => {
    const app = createTestApp();
    const request = (verb: string) => app.request('/api/deploy-keys', {
      method: verb,
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': verb === 'PUT' ? '192.0.2.1' : '192.0.2.2' },
      ...(verb === 'PUT' ? { body: JSON.stringify({ githubToken: null }) } : {}),
    });
    for (let i = 0; i < 20; i++) {
      expect((await request(i % 2 ? 'DELETE' : 'PUT')).status).toBe(200);
    }
    // A denied clear must leave stored credentials intact and must not probe providers.
    mockKV._set('deploy-keys:test-bucket', { githubToken: 'synthetic-preserved-token' });
    const res = await request(method);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMIT_ERROR' });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('20');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(JSON.parse(mockKV._store.get('deploy-keys:test-bucket')!)).toMatchObject({ githubToken: 'synthetic-preserved-token' });
    expect((await app.request('/api/deploy-keys')).status).toBe(200);
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

    it('REQ-AGENT-010 AC1: authenticates the supplied GitHub token at the provider before storing it', async () => {
      mockGlobalFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const authorized = request.url === 'https://api.github.com/user'
          && request.headers.get('Authorization') === 'Bearer synthetic-github-valid';
        return Response.json({ login: 'synthetic-user' }, { status: authorized ? 200 : 401 });
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'synthetic-github-valid' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ githubToken: '****alid' });
      const rejected = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: 'synthetic-github-invalid' }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await mockKV.get('deploy-keys:test-bucket', 'json')).toEqual({
        githubToken: 'synthetic-github-valid', githubTokenSource: 'pat',
      });
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

    it.each(['app', 'oauth'] as const)('REQ-GITHUB-001 AC6: non-Enterprise PAT replacement clears stale %s login and refresh metadata', async source => {
      // A PAT may be for a different account and carries no login metadata, so a
      // leftover githubLogin would make /api/github/status report the wrong account.
      mockKV._set('deploy-keys:test-bucket', {
        githubToken: 'synthetic-prior-managed-token',
        githubTokenSource: source,
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

    it.each([{ ids: ['acct-a'] }, { ids: ['acct-a', 'acct-b'] }])(
      'REQ-AGENT-010 AC1/AC6: co-submitted token and downstream account selection reuse a single provider response (%j)', async ({ ids }) => {
        const selected = ids.at(-1)!;
        const accounts = ids.map(id => ({ id, name: id }));
        // A second validation receives the fixture's default upstream failure.
        mockGlobalFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: accounts }) });
        const res = await createTestApp().request('/api/deploy-keys', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cloudflareApiToken: 'cf-new', cloudflareAccountId: selected }),
        });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.cloudflareAccountId).toBe(selected);
        expect(body.cloudflareAccounts).toEqual(ids.length > 1 ? accounts : undefined);
        expect(await mockKV.get('deploy-keys:test-bucket', 'json')).toEqual({
          cloudflareApiToken: 'cf-new', cloudflareAccountId: selected,
        });
      },
    );

    it.each(['replaced', 'cleared first'] as const)(
      'REQ-AGENT-010: an expiring Cloudflare OAuth grant %s by a PAT cannot renew the old grant', async action => {
        mockKV._set('deploy-keys:test-bucket', {
          githubToken: 'github-unchanged', cloudflareApiToken: 'old-oauth', cloudflareTokenSource: 'oauth',
          cloudflareRefreshToken: 'old-refresh', cloudflareTokenExpiresAt: Date.now() - 1000,
        } satisfies DeployKeys);
        const app = createTestApp();
        const put = (cloudflareApiToken: string | null) => app.request('/api/deploy-keys', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cloudflareApiToken }),
        });
        if (action === 'cleared first') {
          expect((await put(null)).status).toBe(200);
          expect(await mockKV.get('deploy-keys:test-bucket', 'json')).toEqual({ githubToken: 'github-unchanged' });
        }
        mockGlobalFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: [{ id: 'acct-pat', name: 'PAT' }] }) });
        expect((await put('replacement-pat')).status).toBe(200);
        expect(await mockKV.get('deploy-keys:test-bucket', 'json')).toEqual({
          githubToken: 'github-unchanged', cloudflareApiToken: 'replacement-pat', cloudflareAccountId: 'acct-pat',
        });
        const providerPaths: string[] = [];
        mockGlobalFetch.mockImplementation(async input => {
          providerPaths.push(new URL(String(input)).pathname);
          throw new Error('Unexpected provider request while resolving PAT');
        });
        mockKV._set(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID, 'client');
        mockKV._set(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET, { secret: 'secret' });
        const env = { KV: mockKV } as unknown as Env;
        expect(await getValidCloudflareToken(env, 'test-bucket')).toBe('replacement-pat');
        expect(providerPaths).toEqual([]);
      },
    );

    it('REQ-AGENT-010 AC3: clearing all keys removes persisted credentials', async () => {
      mockKV._set('deploy-keys:test-bucket', {
        githubToken: 'github_pat_old',
        cloudflareApiToken: 'cf-old',
      });

      const app = createTestApp();
      const res = await app.request('/api/deploy-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: null, cloudflareApiToken: null }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cloudflareAccountId: null });
      expect(await mockKV.get('deploy-keys:test-bucket', 'json')).toBeNull();
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
    it('REQ-AGENT-010 AC3: DELETE removes all persisted deploy credentials', async () => {
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
      expect(await mockKV.get('deploy-keys:test-bucket', 'json')).toBeNull();
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
