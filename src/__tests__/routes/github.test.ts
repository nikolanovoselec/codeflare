import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, DeployKeys } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import { AppError, AuthError } from '../../lib/error-types';
import { authenticateRequest } from '../../lib/access';

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

// authMiddleware authenticates via this; pin a stable identity + bucket.
vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => ({
    user: { email: 'u@example.com', authenticated: true, role: 'user' },
    bucketName: 'test-bucket',
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Container DO fetch is the forward target for POST /api/github/clone. The mock
// returns whatever containerFetch resolves to so each test controls the
// upstream status/body the route must relay.
const containerFetch = vi.fn();
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({ fetch: containerFetch })),
}));

import githubRoutes from '../../routes/github';
import githubAuthRoutes from '../../routes/github-auth';
import { getValidGithubToken } from '../../lib/github-token';
import { buildCloneTargets } from '../../lib/clone-targets';
import { configureContainerDO } from '../../routes/container/lifecycle-init';
import type { Logger } from '../../lib/logger';
import { getContainer } from '@cloudflare/containers';

const KEY = 'deploy-keys:test-bucket';
const ENT: Partial<Env> = {
  ENTERPRISE_MODE: 'active',
  GITHUB_APP_CLIENT_ID: 'app-cid',
  GITHUB_APP_CLIENT_SECRET: 'app-sec',
  OAUTH_JWT_SECRET: 'state-secret',
};

let mockKV: ReturnType<typeof createMockKV>;
let mockD1: D1Database;

function createTestApp(env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as never);
    return c.json({ error: 'Unexpected error' }, 500);
  });
  app.use('*', async (c, next) => {
    (c.env as unknown) = { KV: mockKV, USAGE_DB: mockD1, ...env };
    return next();
  });
  app.route('/api/github', githubRoutes);
  app.route('/auth/github', githubAuthRoutes);
  return app;
}
function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockKV = createMockKV();
  mockD1 = createMockSessionD1(mockKV);
  mockKV._set('session:test-bucket:sid12345678', {
    id: 'sid12345678', name: 'Test', userId: 'test-bucket', status: 'running',
    createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
  });
});

it('REQ-GITHUB-007: unauthenticated GitHub requests preserve credentials and never reach provider or container I/O', async () => {
  mockKV._set(KEY, { githubToken: 'saved-owner-token', githubTokenSource: 'app', githubLogin: 'owner' } satisfies DeployKeys);
  const stored = [...mockKV._store];
  const app = createTestApp(ENT);
  for (const [path, method] of [
    ['status', 'GET'], ['repos', 'GET'], ['owned-repo-counts', 'GET'], ['connect', 'GET'], ['disconnect', 'POST'], ['clone', 'POST'],
  ] as const) {
    vi.mocked(authenticateRequest).mockRejectedValueOnce(new AuthError('Authentication required'));
    const response = await app.request(`/api/github/${path}`, {
      method,
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ repo: 'octo/repo', sessionId: 'sid12345678' }) } : {}),
    });
    expect(response.status).toBe(401);
    expect([...mockKV._store]).toEqual(stored);
  }
  expect(mockFetch).not.toHaveBeenCalled();
  expect(getContainer).not.toHaveBeenCalled();
  expect(containerFetch).not.toHaveBeenCalled();
});

// ─── GET /status (REQ-GITHUB-002 AC1) ───────────────────────────────────────

describe('REQ-GITHUB-002 / REQ-GITHUB-007: GET /api/github/status', () => {
  it('REQ-GITHUB-007: reports enabled outside enterprise too (panel available in every mode)', async () => {
    const res = await createTestApp({}).request('/api/github/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.connected).toBe(false);
  });

  it('REQ-GITHUB-002: reports enabled + not connected in enterprise with no token', async () => {
    const res = await createTestApp(ENT).request('/api/github/status');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.configured).toBe(true);
    expect(body.connected).toBe(false);
  });

  it('REQ-GITHUB-002: reports connected with login + source when a token exists', async () => {
    mockKV._set(KEY, { githubToken: 'gho_status_private_canary', githubRefreshToken: 'ghr_status_private_canary', githubTokenSource: 'app', githubLogin: 'octo' } satisfies DeployKeys);
    const res = await createTestApp(ENT).request('/api/github/status');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connected).toBe(true);
    expect(body.login).toBe('octo');
    expect(body.source).toBe('app');
    // Public status is a deliberately closed, non-secret wire schema.
    expect(body).toEqual({ enabled: true, configured: true, connected: true, login: 'octo', source: 'app' });
    for (const secret of ['gho_status_private_canary', 'ghr_status_private_canary']) {
      expect(JSON.stringify([...res.headers])).not.toContain(secret);
      expect(JSON.stringify(body)).not.toContain(secret);
    }
  });
});

describe('GitHub Details owned repository counts', () => {
  it.each(['counts', 'token helper'] as const)('serves a waiting App repository request after a refresh starts in %s', async initiator => {
    mockKV._set(KEY, { githubToken: 'expired', githubTokenSource: 'app', githubLogin: 'octocat',
      githubRefreshToken: 'one-use', githubTokenExpiresAt: Date.now() - 1000 } satisfies DeployKeys);
    const client = new AbortController();
    const retained: Promise<unknown>[] = [];
    const context = { waitUntil: (work: Promise<unknown>) => { retained.push(work); } } as ExecutionContext;
    let startExchange!: () => void;
    let finishExchange!: () => void;
    const exchangeStarted = new Promise<void>(resolve => { startExchange = resolve; });
    const exchangeFinished = new Promise<void>(resolve => { finishExchange = resolve; });
    let redeemed = false;
    mockFetch.mockImplementation(async (input: string, init: RequestInit) => {
      const path = new URL(input).pathname;
      if (path === '/login/oauth/access_token') {
        if (redeemed) return ok({ error: 'bad_refresh_token' });
        redeemed = true;
        startExchange();
        await exchangeFinished;
        if (client.signal.aborted && retained.length === 0) throw new Error('Initiating request was cancelled');
        return ok({ access_token: 'fresh', refresh_token: 'next', expires_in: 3600 });
      }
      if (new Headers(init.headers).get('Authorization') !== 'Bearer fresh') return new Response(null, { status: 401 });
      if (path === '/user') return ok({ login: 'octocat', public_repos: 3, owned_private_repos: 2 });
      if (path === '/user/repos') return ok([]);
      throw new Error(`Unexpected fixture path ${path}`);
    });
    const app = createTestApp(ENT);
    const counts = initiator === 'counts'
      ? app.request('/api/github/owned-repo-counts', { signal: client.signal }, undefined, context)
      : getValidGithubToken({ KV: mockKV, ...ENT } as Env, 'test-bucket', work => context.waitUntil(work));
    await exchangeStarted;
    const repositories = app.request('/api/github/repos', undefined, undefined, context);
    await new Promise(resolve => setTimeout(resolve, 0));
    if (initiator === 'counts') client.abort();
    finishExchange();
    const [countResponse, repos] = await Promise.all([counts, repositories]);
    await Promise.all(retained);
    if (countResponse instanceof Response) {
      expect(await countResponse.json()).toEqual({ login: 'octocat', counts: { public: 3, private: 2, total: 5 } });
    } else expect(countResponse).toBe('fresh');
    expect(repos.status).toBe(200);
    expect(await repos.json()).toMatchObject({ repos: [] });
  });
  it('returns only account-owned totals from the authenticated profile', async () => {
    mockKV._set(KEY, { githubToken: 'test-token', githubTokenSource: 'oauth', githubLogin: 'octocat' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(ok({ login: 'Octocat', public_repos: 3, owned_private_repos: 2, total_private_repos: 90 }));
    const response = await createTestApp({}).request('/api/github/owned-repo-counts');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ login: 'Octocat', counts: { public: 3, private: 2, total: 5 } });
  });

  it.each([
    { login: 'octocat', public_repos: 3, total_private_repos: 90 },
    { login: 'another-account', public_repos: 3, owned_private_repos: 2 },
    { login: 'octocat', public_repos: 3, owned_private_repos: -1 },
  ])('leaves owned counts unavailable for an incomplete or mismatched profile', async profile => {
    mockKV._set(KEY, { githubToken: 'test-token', githubTokenSource: 'oauth', githubLogin: 'octocat' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(ok(profile));
    const response = await createTestApp({}).request('/api/github/owned-repo-counts');
    expect(await response.json()).toEqual({ counts: null });
  });

  it.each([
    [{ login: 'octocat', public_repos: 3, owned_private_repos: 2 }, { login: 'octocat', counts: { public: 3, private: 2, total: 5 } }],
    [{ login: 'octocat', public_repos: 3, total_private_repos: 90 }, { counts: null }],
  ])('uses only complete owned counts from the connected GitHub App user profile', async (profile, expected) => {
    mockKV._set(KEY, { githubToken: 'test-token', githubTokenSource: 'app', githubLogin: 'octocat' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(ok(profile));
    const response = await createTestApp(ENT).request('/api/github/owned-repo-counts');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
  });
});

// ─── GET /repos (REQ-GITHUB-002 AC2) ────────────────────────────────────────

describe('REQ-GITHUB-002 / REQ-GITHUB-007: GET /api/github/repos', () => {
  it('REQ-GITHUB-002: 401s when not connected and never calls GitHub', async () => {
    const res = await createTestApp(ENT).request('/api/github/repos');
    expect(res.status).toBe(401);
    expect((await res.json() as Record<string, unknown>).code).toBe('NOT_CONNECTED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('REQ-GITHUB-007: is reachable in non-enterprise (panel no longer enterprise-gated) — 401 when not connected', async () => {
    const res = await createTestApp({}).request('/api/github/repos');
    expect(res.status).toBe(401);
    expect((await res.json() as Record<string, unknown>).code).toBe('NOT_CONNECTED');
  });

  it('REQ-GITHUB-002: proxies the user repos with the stored token and never returns the token', async () => {
    mockKV._set(KEY, { githubToken: 'gho_secret_tok', githubTokenSource: 'app' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(
      ok([
        { full_name: 'octo/repo', name: 'repo', owner: { login: 'octo' }, private: true, default_branch: 'main', updated_at: '2026-01-01T00:00:00Z' },
      ]),
    );

    const res = await createTestApp(ENT).request('/api/github/repos');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: Array<Record<string, unknown>>; page: number; hasMore: boolean };
    expect(body.page).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]).toMatchObject({ full_name: 'octo/repo', owner: 'octo', private: true, visibility: 'private', default_branch: 'main' });

    // upstream call carried the token + API version; response never leaks it
    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer gho_secret_tok',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    expect(JSON.stringify(body)).not.toContain('gho_secret_tok');
  });
});

// ─── GET /connect (REQ-GITHUB-001 / 002) ────────────────────────────────────

describe('GET /api/github/connect', () => {
  it('redirects to the provider authorize URL with a signed state + connect callback', async () => {
    const res = await createTestApp(ENT).request('/api/github/connect');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.host).toBe('github.com');
    expect(loc.pathname).toBe('/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('app-cid');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.searchParams.get('redirect_uri')).toMatch(/\/auth\/github\/connect\/callback$/);
  });

  it('503s when no provider is configured', async () => {
    const res = await createTestApp({ ENTERPRISE_MODE: 'active' }).request('/api/github/connect');
    expect(res.status).toBe(503);
    expect((await res.json() as Record<string, unknown>).code).toBe('GITHUB_NOT_CONFIGURED');
  });

  it('is reachable for a non-advanced authed user in non-enterprise (connect is not panel-gated)', async () => {
    const res = await createTestApp({ OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec', OAUTH_JWT_SECRET: 'state-secret' })
      .request('/api/github/connect');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.host).toBe('github.com');
    expect(loc.searchParams.get('state')).toBeTruthy();
  });

  it('feeds the scope tier into the OAuth-App authorize scope param', async () => {
    const env = { OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec', OAUTH_JWT_SECRET: 'state-secret' };
    const advanced = new URL(
      (await createTestApp(env).request('/api/github/connect?tier=advanced')).headers.get('location')!,
    );
    expect(advanced.searchParams.get('scope')).toContain('admin:repo_hook');
    const minimal = new URL(
      (await createTestApp(env).request('/api/github/connect?tier=minimal')).headers.get('location')!,
    );
    expect(minimal.searchParams.get('scope')).not.toContain('admin:repo_hook');
  });

  it.each(['minimal', 'recommended', 'advanced', 'default'])('REQ-GITHUB-317 AC5: requests read:user for the %s OAuth-App connection', async tier => {
    const env = { OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec', OAUTH_JWT_SECRET: 'state-secret' };
    const response = await createTestApp(env).request(`/api/github/connect${tier === 'default' ? '' : `?tier=${tier}`}`);
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get('location')!);
    expect(redirect.searchParams.get('scope')?.split(' ')).toContain('read:user');
  });

  it('REQ-GITHUB-013: requests gist access for every OAuth-App connection tier', async () => {
    const env = { OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec', OAUTH_JWT_SECRET: 'state-secret' };

    for (const tier of ['minimal', 'recommended', 'advanced']) {
      const location = new URL(
        (await createTestApp(env).request(`/api/github/connect?tier=${tier}`)).headers.get('location')!,
      );
      expect(location.searchParams.get('scope')?.split(' ')).toContain('gist');
    }
  });
});

// ─── POST /disconnect (REQ-GITHUB-005) ──────────────────────────────────────

describe('POST /api/github/disconnect', () => {
  it('revokes + clears the token and returns success', async () => {
    mockKV._set(KEY, { githubToken: 'gho_x', githubTokenSource: 'app' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });

    const res = await createTestApp(ENT).request('/api/github/disconnect', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).success).toBe(true);
    expect(await mockKV.get(KEY)).toBeNull();
  });
});

// ─── POST /clone (REQ-GITHUB-004 running-session path) ───────────────────────

function containerJson(status: number, json: unknown) {
  return { status, json: async () => json };
}

describe('POST /api/github/clone', () => {
  const SID = 'sid12345678';

  it('is reachable in non-enterprise (panel no longer enterprise-gated) and forwards to the container', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(200, { status: 'cloned', path: '/home/user/workspace/repo' }));
    const res = await createTestApp({}).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    expect(res.status).toBe(200);
    expect(containerFetch).toHaveBeenCalled();
  });

  it('forwards to the container /internal/git-clone and relays a 200', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(200, { status: 'cloned', path: '/home/user/workspace/repo' }));

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', ref: 'develop', sessionId: SID }),
    });

    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).status).toBe('cloned');

    // The forwarded request hit the internal clone path and carried repo+ref.
    expect(containerFetch).toHaveBeenCalledTimes(1);
    const forwarded = containerFetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/internal/git-clone');
    expect(forwarded.method).toBe('POST');
    const sentBody = await forwarded.json() as Record<string, unknown>;
    expect(sentBody).toEqual({ repo: 'octo/repo', ref: 'develop' });
    // Container is addressed by the bucket+session-derived id.
    expect(vi.mocked(getContainer).mock.calls[0][1]).toBe('test-bucket-sid12345678');
  });

  it('REQ-GITHUB-015 AC3: tracks the repository on the session as soon as the clone succeeds', async () => {
    const key = 'session:test-bucket:sid12345678';
    mockKV._set(key, {
      id: SID, name: 'Test', userId: 'test-bucket', status: 'running',
      createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
    });
    containerFetch.mockResolvedValueOnce(containerJson(200, { status: 'cloned', path: '/home/user/workspace/repo' }));

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', ref: 'develop', sessionId: SID }),
    });

    expect(res.status).toBe(200);
    const persisted = await mockKV.get(key, 'json') as { clones?: Array<{ repo: string; ref?: string }> };
    expect(persisted.clones).toEqual([{ repo: 'octo/repo', ref: 'develop' }]);
    expect(buildCloneTargets(persisted.clones, undefined)).toBe('octo/repo#develop');
  });

  it('REQ-GITHUB-015 AC6: merges clone tracking into the latest session record', async () => {
    const key = 'session:test-bucket:sid12345678';
    containerFetch.mockImplementationOnce(async () => {
      mockKV._set(key, {
        id: SID, name: 'Renamed during clone', userId: 'test-bucket', status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
      });
      return containerJson(200, { status: 'cloned', path: '/home/user/workspace/repo' });
    });

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });

    expect(res.status).toBe(200);
    const persisted = await mockKV.get(key, 'json') as { name: string; clones: unknown };
    expect(persisted.name).toBe('Renamed during clone');
    expect(persisted.clones).toEqual([{ repo: 'octo/repo' }]);
  });

  it('REQ-GITHUB-015 AC6: rejects a clone request for a missing session before forwarding', async () => {
    mockKV._clear();

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });

    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>).code).toBe('SESSION_NOT_FOUND');
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('REQ-GITHUB-319: an existing checkout is reported separately when tracking retries exhaust', async () => {
    let checkout: string | undefined;
    containerFetch.mockImplementationOnce(async () => {
      checkout = '/home/user/workspace/repo';
      return containerJson(200, { status: 'cloned', path: checkout });
    });
    // Model a persistently contended inventory at the D1 boundary, after the host completed.
    const prepare = mockD1.prepare.bind(mockD1);
    mockD1.prepare = (sql: string) => sql.includes('SET clones_json=')
      ? { bind: () => ({ run: async () => ({ success: true, meta: { changes: 0 } }) }) } as unknown as D1PreparedStatement
      : prepare(sql);
    const result = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    expect(checkout).toBe('/home/user/workspace/repo');
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'CLONE_TRACKING_UNCONFIRMED' });
    expect(await mockKV.get(`session:test-bucket:${SID}`, 'json')).not.toHaveProperty('clones');
  });

  it('REQ-GITHUB-015 AC6: does not return clone success when session persistence fails', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(200, { status: 'cloned', path: '/home/user/workspace/repo' }));
    mockKV.put.mockRejectedValue(new Error('KV unavailable'));

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });

    expect(res.status).toBe(500);
  });

  it('REQ-GITHUB-015 AC3: does not track a repository when the clone did not succeed', async () => {
    const key = 'session:test-bucket:sid12345678';
    mockKV._set(key, {
      id: SID, name: 'Test', userId: 'test-bucket', status: 'running',
      createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
    });
    containerFetch.mockResolvedValueOnce(containerJson(502, { error: 'failed', code: 'CLONE_FAILED' }));

    await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });

    expect((await mockKV.get(key, 'json') as { clones?: unknown }).clones).toBeUndefined();
  });

  it('relays a 409 collision verbatim', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(409, { error: 'exists', code: 'CLONE_TARGET_EXISTS' }));

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, unknown>).code).toBe('CLONE_TARGET_EXISTS');
  });

  it('relays a 502 clone failure verbatim', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(502, { error: 'failed', code: 'CLONE_FAILED' }));

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    expect(res.status).toBe(502);
    expect((await res.json() as Record<string, unknown>).code).toBe('CLONE_FAILED');
  });

  it('omits ref from the forwarded body when not supplied', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(200, { status: 'cloned', path: '/x' }));

    await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    const forwarded = containerFetch.mock.calls[0][0] as Request;
    expect(await forwarded.json() as Record<string, unknown>).toEqual({ repo: 'octo/repo' });
  });

  it('rejects a malformed repo with 400 and never forwards', async () => {
    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'not-valid', sessionId: SID }),
    });
    expect(res.status).toBe(400);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('rejects a missing sessionId with 400 and never forwards', async () => {
    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo' }),
    });
    expect(res.status).toBe(400);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('returns 503 when the container body is not JSON (asleep DO)', async () => {
    containerFetch.mockResolvedValueOnce({ status: 503, json: async () => { throw new Error('not json'); } });

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    expect(res.status).toBe(503);
    expect((await res.json() as Record<string, unknown>).code).toBe('NOT_RUNNING');
  });
});

it('REQ-GITHUB-002 AC2: lists accessible organization repositories across provider pages', async () => {
  mockKV._set(KEY, { githubToken: 'gho_org_canary', githubTokenSource: 'oauth' } satisfies DeployKeys);
  const first = Array.from({ length: 50 }, (_, i) => ({ full_name: `team/repo${i}`, name: `repo${i}`,
    owner: { login: 'team' }, private: true, default_branch: 'trunk', updated_at: '2026-01-01T00:00:00Z' }));
  const last = { ...first[0], full_name: 'another-team/final', name: 'final', owner: { login: 'another-team' } };
  mockFetch.mockResolvedValueOnce(ok(first)).mockResolvedValueOnce(ok([last]));
  const app = createTestApp(ENT);
  for (const [page, upstream, hasMore] of [[1, first, true], [2, [last], false]] as const) {
    const response = await app.request(`/api/github/repos?page=${page}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ page, hasMore, repos: upstream.map(repo => ({ ...repo, owner: repo.owner.login, visibility: 'private' })) });
    expect(JSON.stringify(body)).not.toContain('gho_org_canary');
    const [url, init] = mockFetch.mock.calls[page - 1];
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe('https://api.github.com/user/repos');
    expect(Object.fromEntries(target.searchParams)).toEqual({ sort: 'updated', per_page: '50', page: String(page),
      affiliation: 'owner,collaborator,organization_member' });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer gho_org_canary');
  }
});

it('REQ-GITHUB-319 AC1+AC2: successful overflow clones persist only twenty candidates for the next restore', async () => {
  const key = 'session:test-bucket:sid12345678';
  const initial = await mockKV.get(key, 'json') as Record<string, unknown>;
  const retained = Array.from({ length: 20 }, (_, i) => ({ repo: `team/r${String(i).padStart(2, '0')}` }));
  mockKV._set(key, { ...initial, clones: retained });
  const app = createTestApp(ENT);
  // One sorts beyond the cap; the other displaces the previous last entry.
  for (const repo of ['team/z-omitted', 'team/a-retained']) {
    containerFetch.mockResolvedValueOnce(containerJson(200, { status: 'cloned', path: `/workspace/${repo.split('/')[1]}` }));
    const response = await app.request('/api/github/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, sessionId: 'sid12345678' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'cloned', path: `/workspace/${repo.split('/')[1]}` });
  }
  const saved = await mockKV.get(key, 'json') as { clones: Array<{ repo: string }> };
  const expected = [{ repo: 'team/a-retained' }, ...retained.slice(0, 19)];
  expect(saved.clones).toEqual(expected);
  expect(buildCloneTargets(saved.clones, undefined).split(' ')).toEqual(expected.map(item => item.repo));
  expect(buildCloneTargets(saved.clones, undefined)).not.toContain('team/z-omitted');
  expect(buildCloneTargets(saved.clones, undefined)).not.toContain('team/r19');
  let resume: Request | undefined;
  const container = { fetch: async (request: Request) => {
    if (new URL(request.url).pathname === '/_internal/getBucketName') return Response.json({ bucketName: 'test-bucket' });
    resume = request;
    return new Response(null, { status: 409 });
  } };
  await configureContainerDO({ generation: 0, container, bucketName: 'test-bucket', sessionId: 'sid12345678',
    userEmail: 'u@example.com', containerId: 'test-bucket-sid12345678', scopedCreds: { accessKeyId: 'ak', secretAccessKey: 'sk' },
    r2Config: { accountId: 'account', endpoint: 'https://r2.example.test' },
    tabConfig: [], terminalMode: 'classic', workspaceSyncEnabled: false, fastStartEnabled: false,
    sessionMode: 'default', sessionWorkspace: 'terminal', sleepAfter: '30m', managedResourcePolicy: 'mutable',
    gitCloneTargets: buildCloneTargets(saved.clones, undefined),
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger });
  expect(resume?.method).toBe('POST');
  expect(new URL(resume!.url).pathname).toBe('/_internal/setBucketName');
  expect((await resume!.json() as { gitCloneTargets: string }).gitCloneTargets.split(' ')).toEqual(expected.map(item => item.repo));
});

it.each([['default', {}], ['saas', { SAAS_MODE: 'active' }], ['enterprise', ENT]] as const)(
  'REQ-GITHUB-317 AC1+AC3: %s nonadvanced connection is additive and authentication guards every connection action', async (_mode, mode) => {
    // A missing tier is pending in SaaS; exercise an active, nonadvanced user.
    vi.mocked(authenticateRequest).mockResolvedValue({
      user: { email: 'u@example.com', authenticated: true, role: 'user', subscriptionTier: 'free' },
      bucketName: 'test-bucket',
    });
    const env = { ...mode, OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec', OAUTH_JWT_SECRET: 'state-secret' };
    const app = createTestApp(env);
    mockKV._set(KEY, { cloudflareApiToken: 'prior-cloudflare-grant', cloudflareAccountId: 'account' } satisfies DeployKeys);
    const before = await mockKV.get(KEY);
    const connect = await app.request('/api/github/connect');
    expect(connect.status).toBe(302);
    expect(await mockKV.get(KEY)).toBe(before);
    const authorize = new URL(connect.headers.get('location')!);
    const state = authorize.searchParams.get('state')!;
    const callback = `/auth/github/connect/callback?code=code&state=${encodeURIComponent(state)}`;
    for (const [path, method] of [['/api/github/connect', 'GET'], [callback, 'GET'], ['/api/github/disconnect', 'POST']]) {
      vi.mocked(authenticateRequest).mockRejectedValueOnce(new AuthError('Authentication required'));
      const denied = await app.request(path, { method });
      expect(denied.status).toBe(path === callback ? 302 : 401);
      if (path === callback) expect(denied.headers.get('location')).toContain('error=session-expired');
      expect(await mockKV.get(KEY)).toBe(before);
      expect(mockFetch).not.toHaveBeenCalled();
    }
    mockFetch.mockResolvedValueOnce(ok({ access_token: 'gho_added_grant' })).mockResolvedValueOnce(ok({ login: 'octo' }));
    const connected = await app.request(callback);
    expect(connected.status).toBe(302);
    expect(connected.headers.get('location')).toContain('github=connected');
    expect(connected.headers.get('set-cookie')).toBeNull();
    expect(await getValidGithubToken({ KV: mockKV, ...env } as Env, 'test-bucket')).toBe('gho_added_grant');
    expect(await mockKV.get(KEY, 'json')).toMatchObject({ cloudflareApiToken: 'prior-cloudflare-grant', cloudflareAccountId: 'account',
      githubToken: 'gho_added_grant', githubLogin: 'octo' });
    mockFetch.mockResolvedValueOnce(ok({}));
    const disconnected = await app.request('/api/github/disconnect', { method: 'POST' });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({ success: true });
    expect(await mockKV.get(KEY, 'json')).toEqual({ cloudflareApiToken: 'prior-cloudflare-grant', cloudflareAccountId: 'account' });
  });
